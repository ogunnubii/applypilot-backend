import {readFileSync,writeFileSync} from 'node:fs';
// Produce a dependency-free command that can be pasted into the supported
// Railway Console after separate full-state-copy approval and writer freeze.
const snapshot=readFileSync(new URL('./state-snapshot.mjs',import.meta.url),'utf8').split('if(process.argv[1]&&import.meta.url===')[0];
export const consoleProgram=snapshot+`
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {chmodSync} from 'node:fs';
try{
 const [approval,source='/app/data/applypilot.sqlite',uploads='/app/data/resumes',parent=tmpdir()]=process.argv.slice(2);
 if(approval!=='--approved-full-state-backup')fail('full_state_backup_approval_required');
 const target=join(parent,'applypilot-migration-'+randomUUID());
 const result=await createSnapshot(source,uploads,target);
 const archive=target+'.tar.gz';
 execFileSync('tar',['-czf',archive,'-C',target,'database.sqlite','resumes','manifest.json'],{stdio:'pipe'});
 chmodSync(archive,0o600);
 console.log(JSON.stringify({backup_ready:true,...result,archive,sha256:hash(readFileSync(archive)),source_rows_modified:false}));
}catch(error){console.error('Backup stopped: '+(/^[a-z_]+$/.test(error.message)?error.message:'private_input_or_archive_unavailable'));process.exitCode=1}
`;
const shell="# Do not run before full-state-copy approval and a coordinated writer freeze.\n# This command creates private files on Railway; it does not download them.\numask 077\nnode --input-type=module - --approved-full-state-backup <<'APPLYPILOT_BACKUP_MODULE'\n"+consoleProgram+"\nAPPLYPILOT_BACKUP_MODULE\n";
writeFileSync(new URL('./railway-console-backup.sh',import.meta.url),shell);
