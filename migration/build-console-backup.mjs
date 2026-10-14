import {readFileSync,writeFileSync} from 'node:fs';

// Inline the reviewed built-in-only resume module in its own lexical scope.
// No downloaded dependency, app startup, credential environment or provider.
const resumeSource=readFileSync(new URL('./recovery-resumes.mjs',import.meta.url),'utf8')
 .replace(/^import (\{[^;]+\}) from ('node:[^']+');$/gm,'const $1 = await import($2);')
 .replace(/^export /gm,'');
if(/^import /m.test(resumeSource))throw Error('standalone_helper_import_not_supported');
const resumeInline=`const {copyReferencedResumes,verifyReferencedResumes}=await (async()=>{\n${resumeSource}\nreturn {copyReferencedResumes,verifyReferencedResumes};\n})();`;
const snapshot=readFileSync(new URL('./state-snapshot.mjs',import.meta.url),'utf8').split('if(process.argv[1]&&import.meta.url===')[0]
 .replace("import {copyReferencedResumes,verifyReferencedResumes} from './recovery-resumes.mjs';",resumeInline);

function program(recovery){return snapshot+`
try{
 const [approval,source,uploads,target]=process.argv.slice(2);
 if(approval!==${JSON.stringify(recovery?'--approved-sqlite-recovery-backup':'--approved-full-state-backup')})fail('full_state_backup_approval_required');
 if(!source||!uploads||!target||!isAbsolute(source)||!isAbsolute(uploads)||!isAbsolute(target))fail('absolute_backup_paths_required');
 const result=await ${recovery?'createRecoverySnapshot(source,target,{uploadsRoot:uploads,resourceLimits:CONSOLE_RESOURCE_LIMITS})':'createSnapshot(source,uploads,target,{resourceLimits:CONSOLE_RESOURCE_LIMITS})'};
 console.log(JSON.stringify({snapshot_ready:true,...result,target,source_rows_modified:false,peak_rss_kib:process.resourceUsage().maxRSS}));
}catch(error){console.error('Backup stopped: '+(/^[a-z_]+$/.test(error.message)?error.message:'private_input_unavailable'));process.exitCode=1}
`;}
export const consoleProgram=program(false);
export const recoveryProgram=program(true);

// Independent Linux fixture review showed that the old 96 MiB admission floor
// omitted substantial disk/cache allocation. This is a conservative operator
// minimum for the explicit bounded envelope, not a reserved cgroup budget.
export const MINIMUM_HEADROOM_BYTES=256*1024*1024;
export const MINIMUM_FREE_SPACE_BYTES=256*1024*1024;
export const MAXIMUM_ARCHIVE_BYTES=16*1024*1024;
function shell(recovery){
 const kind=recovery?'recovery':'migration',approval=recovery?'--approved-sqlite-recovery-backup':'--approved-full-state-backup';
 return `#!/bin/sh
# Approved private ${kind} backup only. No downloads, credentials, restart or cutover.
# ${recovery?'Online SQLite + individually stable referenced resumes; no global freeze inferred.':'Requires a coordinated writer freeze for the complete DB+resume interval.'}
# Node exits before tar/hash. Heap flags are not a cgroup memory limit.
# Usage: sh script.sh ABSOLUTE_DATABASE ABSOLUTE_UPLOADS ABSOLUTE_OUTPUT_PARENT
# The operator must verify these paths; source defaults are not runtime evidence.
set -eu
set -C
umask 077
test "$#" -eq 3 || { printf '%s\\n' 'Backup stopped: three_verified_absolute_paths_required'; exit 1; }
for AP_BACKUP_PATH in "$@"; do case "$AP_BACKUP_PATH" in /*) ;; *) printf '%s\\n' 'Backup stopped: absolute_backup_paths_required'; exit 1;; esac; done
AP_BACKUP_SOURCE=$1
AP_BACKUP_UPLOADS=$2
AP_BACKUP_OUTPUT_PARENT=$3
test -d "$AP_BACKUP_OUTPUT_PARENT" || { printf '%s\\n' 'Backup stopped: output_parent_missing'; exit 1; }
for AP_BACKUP_COMMAND in node tar sha256sum date cat rm df awk wc; do command -v "$AP_BACKUP_COMMAND" >/dev/null || { printf '%s\\n' 'Backup stopped: required_tool_missing'; exit 1; }; done
ap_backup_check_memory() {
test -r /sys/fs/cgroup/memory.max && test -r /sys/fs/cgroup/memory.current || { printf '%s\\n' 'Backup stopped: cgroup_memory_unavailable'; exit 1; }
AP_BACKUP_LIMIT=$(cat /sys/fs/cgroup/memory.max)
AP_BACKUP_CURRENT=$(cat /sys/fs/cgroup/memory.current)
case "$AP_BACKUP_LIMIT:$AP_BACKUP_CURRENT" in *[!0-9:]*|:*|*:) printf '%s\\n' 'Backup stopped: cgroup_memory_not_bounded'; exit 1;; esac
AP_BACKUP_HEADROOM=$((AP_BACKUP_LIMIT-AP_BACKUP_CURRENT))
test "$AP_BACKUP_HEADROOM" -ge ${MINIMUM_HEADROOM_BYTES} || { printf '%s\\n' 'Backup stopped: insufficient_container_memory_headroom'; exit 1; }
}
ap_backup_check_disk() {
AP_BACKUP_FREE_KIB=$(df -Pk "$AP_BACKUP_OUTPUT_PARENT" | awk 'NR==2 {print $4}')
case "$AP_BACKUP_FREE_KIB" in ''|*[!0-9]*) printf '%s\\n' 'Backup stopped: filesystem_space_unavailable'; exit 1;; esac
test "$AP_BACKUP_FREE_KIB" -ge ${MINIMUM_FREE_SPACE_BYTES/1024} || { printf '%s\\n' 'Backup stopped: insufficient_filesystem_space'; exit 1; }
}
ap_backup_check_memory
ap_backup_check_disk
AP_BACKUP_TARGET="$AP_BACKUP_OUTPUT_PARENT/applypilot-${kind}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
test ! -e "$AP_BACKUP_TARGET" && test ! -e "$AP_BACKUP_TARGET.tar.gz" || { printf '%s\\n' 'Backup stopped: destination_already_exists'; exit 1; }
node --max-old-space-size=24 --max-semi-space-size=1 --input-type=module - ${approval} "$AP_BACKUP_SOURCE" "$AP_BACKUP_UPLOADS" "$AP_BACKUP_TARGET" <<'APPLYPILOT_BACKUP_MODULE'
${recovery?recoveryProgram:consoleProgram}
APPLYPILOT_BACKUP_MODULE
# Native Node has now exited; archive/hash processes do not overlap its RSS.
ap_backup_check_memory
ap_backup_check_disk
printf '%s\\n' 'Archive has not completed.' > "$AP_BACKUP_TARGET/ARCHIVE_INCOMPLETE"
tar -czf - -C "$AP_BACKUP_TARGET" database.sqlite resumes manifest.json > "$AP_BACKUP_TARGET.tar.gz"
AP_BACKUP_ARCHIVE_BYTES=$(wc -c < "$AP_BACKUP_TARGET.tar.gz" | awk '{print $1}')
case "$AP_BACKUP_ARCHIVE_BYTES" in ''|*[!0-9]*) printf '%s\\n' 'Backup stopped: archive_size_unavailable'; exit 1;; esac
test "$AP_BACKUP_ARCHIVE_BYTES" -le ${MAXIMUM_ARCHIVE_BYTES} || { printf '%s\\n' 'Backup stopped: archive_outside_resource_envelope'; exit 1; }
tar -tzf "$AP_BACKUP_TARGET.tar.gz" >/dev/null
AP_BACKUP_HASH=$(sha256sum "$AP_BACKUP_TARGET.tar.gz")
AP_BACKUP_HASH=\${AP_BACKUP_HASH%% *}
rm -- "$AP_BACKUP_TARGET/ARCHIVE_INCOMPLETE"
printf '{"backup_ready":true,"kind":"${recovery?'sqlite-recovery':'migration-snapshot'}","archive":"%s","sha256":"%s","source_rows_modified":false,"${recovery?'external_workflows_frozen':'requires_coordinated_freeze'}":${recovery?'false':'true'}}\\n' "$AP_BACKUP_TARGET.tar.gz" "$AP_BACKUP_HASH"
`;
}
writeFileSync(new URL('./railway-console-backup.sh',import.meta.url),shell(false));
writeFileSync(new URL('./railway-console-recovery.sh',import.meta.url),shell(true));
