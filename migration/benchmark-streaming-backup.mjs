import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {execFileSync,spawn} from 'node:child_process';
import {readFileSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createMemoryFixture,MIB} from './backup-memory-probe.mjs';

export const CONSERVATIVE_REFERENCE_BYTES=90*MIB;
export const REQUESTED_MARGIN_BYTES=32*MIB;
// Independent test input, never read from a deployment or operational report.
export const SYNTHETIC_GUARD_REJECTION_BYTES=80*MIB;
const hash=value=>createHash('sha256').update(value).digest('hex');

// Read the generated script, not the builder module: importing that module
// rewrites both tracked .sh files. The returned bytes are the builder's actual
// recoveryProgram heredoc, and its SHA can be checked against that export.
export function readInlineRecoveryProgram(shellPath) {
 const shell=readFileSync(shellPath,'utf8'),marker='APPLYPILOT_BACKUP_MODULE';
 const start=shell.indexOf("<<'"+marker+"'\n"),end=shell.lastIndexOf('\n'+marker);
 if(start<0||end<=start)throw Error('recovery_program_heredoc_missing');
 const source=shell.slice(start+("<<'"+marker+"'\n").length,end);
 if(!source.includes('createRecoverySnapshot(source,target,{uploadsRoot:uploads')||!source.includes('copyReferencedResumes'))throw Error('integrated_recovery_program_missing');
 const guard=shell.match(/test "\$AP_BACKUP_HEADROOM" -ge (\d+)/);
 if(!guard)throw Error('recovery_program_headroom_guard_missing');
 return {source,sourceSha256:hash(source),shellSha256:hash(shell),minimumHeadroomBytes:Number(guard[1])};
}

function addResumeReferences(fixture) {
 const engine=new DatabaseSync(fixture.source);
 try{
  engine.exec('CREATE TABLE applicants(id TEXT PRIMARY KEY,resume_path TEXT); CREATE TABLE resume_previous(applicant_id TEXT PRIMARY KEY,path TEXT)');
  engine.prepare('INSERT INTO applicants VALUES(?,?)').run('synthetic-current',join(fixture.uploads,'synthetic.pdf'));
  engine.prepare('INSERT INTO resume_previous VALUES(?,?)').run('synthetic-previous','synthetic.pdf');
 }finally{engine.close();}
 fixture.databaseBytes=statSync(fixture.source).size;
 fixture.expectedResumeSha256=hash(readFileSync(join(fixture.uploads,'synthetic.pdf')));
}

function verifyOffline(executable,source,fixture,nodeFlags) {
 const cliMarker='\ntry{\n const [approval,source,uploads,target]=process.argv.slice(2);';
 const end=source.lastIndexOf(cliMarker);
 if(end<0)throw Error('inline_recovery_cli_marker_missing');
 const verifier=join(fixture.root,'offline-verify.mjs');
 writeFileSync(verifier,source.slice(0,end)+`\nconst verified=await verifyRecoverySnapshot(process.argv[2]);\nconsole.log(JSON.stringify({offline_verified:verified.complete===true,files:verified.uploads.files.length,peak_rss_kib:process.resourceUsage().maxRSS}));\n`);
 // Only this probe's synthetic source file is removed; verification must work
// entirely from the copied database/resumes and their manifest.
 unlinkSync(join(fixture.uploads,'synthetic.pdf'));
 const output=execFileSync(executable,[...nodeFlags,verifier,join(fixture.root,'snapshot')],{encoding:'utf8',windowsHide:true,timeout:120000,stdio:['ignore','pipe','pipe']});
 const result=JSON.parse(output.trim());
 return {offlineVerified:result.offline_verified===true&&result.files===1,offlineVerificationPeakRssBytes:result.peak_rss_kib*1024,liveSyntheticResumeRemovedBeforeVerification:true};
}

// Fixture setup and independent format-1 oracle calculation happen in the
// harness, outside the measured child. One astral character requires a two-byte
// JS string while keeping the SQLite UTF-8 payload at the same byte length.
export function createStreamingFixture(kind,options={}) {
 const mixed=kind==='single-two-byte-text-row';
 const fixture=createMemoryFixture(mixed?'single-text-row':kind,options);
 let engine;
 try {
  engine=new DatabaseSync(fixture.source);
  if(mixed){
   const before=Math.min(32767,fixture.payloadBytes-4),after=fixture.payloadBytes-before-4;
   engine.prepare('UPDATE payload SET value=?').run('x'.repeat(before)+'\u{1f600}'+'x'.repeat(after));
   fixture.kind=kind;
  }
  const statement=engine.prepare('SELECT value FROM payload LIMIT 1');statement.setReadBigInts(true);
  const value=statement.get().value;
  const rowHash=hash(JSON.stringify([['value',value]],(_,v)=>typeof v==='bigint'?{integer:String(v)}:v instanceof Uint8Array?{blob:Buffer.from(v).toString('hex')}:v));
  const digest=createHash('sha256');digest.update('[');
  for(let i=0;i<fixture.rows;i++){if(i)digest.update(',');digest.update(JSON.stringify(rowHash));}
  digest.update(']');fixture.expectedTableDigest=digest.digest('hex');
  return fixture;
 }catch(error){engine?.close();engine=null;fixture.cleanup();throw error;}
 finally{engine?.close();}
}
export function validateBenchmarkRuntime(executable) {
 const value=JSON.parse(execFileSync(executable,['-p','JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})'],{encoding:'utf8',windowsHide:true}));
 if(value.version!=='v24.20.0'||value.platform!=='win32'||value.arch!=='x64')throw Error('requires_official_node_24_20_0_win_x64');
 return value;
}

const worker=`
import {createSnapshot,createRecoverySnapshot} from './snapshot-under-test.mjs';
const emit=phase=>console.log(JSON.stringify({probe_memory:true,phase,maxRSSKiB:process.resourceUsage().maxRSS,...process.memoryUsage()}));
process.on('exit',()=>emit('exit'));
await new Promise(resolveStart=>process.once('message',message=>{if(message!=='start')throw Error('invalid_probe_start');process.disconnect();resolveStart();}));
emit('baseline');
try {
 const [mode,source,uploads,destination]=process.argv.slice(2);
 const result=mode==='recovery'?await createRecoverySnapshot(source,destination):await createSnapshot(source,uploads,destination);
 console.log(JSON.stringify({backup_ready:result.complete===true,mode,upload_count:result.upload_count??0,uploads_included:result.uploads_included??true}));
}catch(error){console.error(/^[a-z_]+$/.test(error.message)?error.message:'synthetic_backup_failed');process.exitCode=1;}
`;

function measure(fixture,{executable,source,mode,heap,semiSpace=null,repeat=null,inlineProgram=false}) {
 return new Promise((done,reject)=>{
  const moduleFile=join(fixture.root,'snapshot-under-test.mjs'),workerFile=join(fixture.root,'streaming-worker.mjs');
  const telemetry=`const benchmarkEmit=phase=>console.log(JSON.stringify({probe_memory:true,phase,maxRSSKiB:process.resourceUsage().maxRSS,...process.memoryUsage()}));\nprocess.on('exit',()=>benchmarkEmit('exit'));\nawait new Promise(resolveStart=>process.once('message',message=>{if(message!=='start')throw Error('invalid_probe_start');process.disconnect();resolveStart();}));\nbenchmarkEmit('baseline');\n`;
  writeFileSync(moduleFile,source);writeFileSync(workerFile,inlineProgram?telemetry+source:worker);
  const startedAt=Date.now();
  const nodeFlags=['--max-old-space-size='+heap,...(semiSpace===null?[]:['--max-semi-space-size='+semiSpace])];
  const child=spawn(executable,[...nodeFlags,workerFile,inlineProgram?'--approved-sqlite-recovery-backup':mode,fixture.source,fixture.uploads,join(fixture.root,'snapshot')],{cwd:fixture.root,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  let stdout='',stderr='',timedOut=false,started=false,monitorText='';
  const timer=setTimeout(()=>{timedOut=true;child.kill();},120000);
  const start=()=>{if(!started&&!child.killed){started=true;child.send('start');}};
  child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>{if(stderr.length<65536)stderr+=data;});
  child.on('error',error=>{clearTimeout(timer);reject(error);});
  const command=`$ErrorActionPreference='Stop'; $probeProcess=Get-Process -Id ${child.pid}; $probePeak=0L; Write-Output 'READY'; try { do { $probeProcess.Refresh(); if($probeProcess.PeakWorkingSet64 -gt $probePeak){$probePeak=$probeProcess.PeakWorkingSet64}; Start-Sleep -Milliseconds 10 } while(-not $probeProcess.HasExited) } catch {}; Write-Output ('PEAK:'+ $probePeak)`;
  const monitor=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,stdio:['ignore','pipe','ignore']});
  monitor.stdout.on('data',data=>{monitorText+=data;if(monitorText.includes('READY'))start();});
  monitor.on('error',()=>start());monitor.on('close',()=>start());
  child.on('close',async(exitCode,signal)=>{
   clearTimeout(timer);
   if(monitor.exitCode===null)await new Promise(resolveClose=>monitor.once('close',resolveClose));
   const rows=stdout.split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
   const baseline=rows.find(row=>row.probe_memory&&row.phase==='baseline'),final=rows.find(row=>row.probe_memory&&row.phase==='exit'),result=rows.find(row=>row.backup_ready||row.snapshot_ready);
   const sample=monitorText.match(/PEAK:(\d+)/),samplePeak=sample?Number(sample[1]):null,peak=final?final.maxRSSKiB*1024:samplePeak;
   let format1DigestVerified=false,referencedResumeVerified=false,offline={offlineVerified:null,offlineVerificationPeakRssBytes:null,liveSyntheticResumeRemovedBeforeVerification:false};
   if(result){
    try{const manifest=JSON.parse(readFileSync(join(fixture.root,'snapshot','manifest.json'),'utf8'));
     format1DigestVerified=manifest.database.tables.payload.rows===fixture.rows&&manifest.database.tables.payload.digest===fixture.expectedTableDigest;
     if(inlineProgram){
      const file=manifest.uploads.files[0];
      referencedResumeVerified=manifest.uploads_included===true&&manifest.uploads.files.length===1&&file.bytes===fixture.resumeBytes&&file.sha256===fixture.expectedResumeSha256&&file.reference_counts.applicants===1&&file.reference_counts.resume_previous===1&&hash(readFileSync(join(fixture.root,'snapshot','resumes','synthetic.pdf')))===fixture.expectedResumeSha256;
      offline=verifyOffline(executable,source,fixture,nodeFlags);
     }
    }catch{}
   }
   done({fixture:fixture.kind,mode,heapLimitMiB:heap,semiSpaceMiB:semiSpace,nodeFlags,repeat,rows:fixture.rows,databaseBytes:fixture.databaseBytes,payloadBytes:fixture.payloadBytes,resumeBytes:fixture.resumeBytes,
    completed:!!result,uploadCount:result?.upload_count??null,uploadsIncluded:result?.uploads_included??null,exitCode,signal,timedOut,durationMs:Date.now()-startedAt,
    format1DigestVerified,referencedResumeVerified,...offline,
    failure:timedOut?'timeout':/heap out of memory|Reached heap limit|Allocation failed/i.test(stderr)?'v8_heap_out_of_memory':exitCode===0?null:stderr.split(/\r?\n/).find(line=>/^[a-z_]+$/.test(line))||'backup_or_runtime_failure',
    baselineRssBytes:baseline?.rss??null,finalRssBytes:final?.rss??null,maxRSSKiB:final?.maxRSSKiB??null,measuredPeakRssBytes:peak,peakIsLowerBound:!final,windowsSampledPeakBytes:samplePeak,
    below90MiB:peak!==null&&peak<CONSERVATIVE_REFERENCE_BYTES,
    peakPlusSyntheticMarginBytes:peak===null?null:peak+REQUESTED_MARGIN_BYTES,
    includesTar:false,includesLinuxPageCache:false,linuxCgroupQualified:false});
  });
 });
}

export const defaultCases=[
 {kind:'many-small-rows',mode:'recovery',heap:32},
 {kind:'single-blob-row',mode:'recovery',heap:32},
 ...['many-small-rows','single-text-row','single-blob-row'].flatMap(kind=>['recovery','full'].flatMap(mode=>[32,48].map(heap=>({kind,mode,heap}))))
  .filter(value=>!(value.mode==='recovery'&&value.heap===32&&['many-small-rows','single-blob-row'].includes(value.kind)))
];

export const compactRecoveryCases=['many-small-rows','single-text-row','single-blob-row','single-two-byte-text-row'].map(kind=>({kind,mode:'recovery',heap:24,semiSpace:1}));

export async function benchmarkInlineRecovery({executable,shellPath,cases=compactRecoveryCases,targetBytes=Math.floor(6.5*MIB),onResult=()=>{}}) {
 const runtime=validateBenchmarkRuntime(executable),pinned=readInlineRecoveryProgram(shellPath),results=[];
 for(const {kind} of cases){
  const fixture=createStreamingFixture(kind,{targetBytes});
  try{
   addResumeReferences(fixture);
   const result=await measure(fixture,{executable,source:pinned.source,mode:'recovery-inline',heap:24,semiSpace:1,inlineProgram:true});
   results.push(result);await onResult(result);
  }finally{fixture.cleanup();}
 }
 const worst=Math.max(...results.map(row=>row.measuredPeakRssBytes??Infinity));
 return {runtime,sourceKind:'generated-recovery-script',sourceSha256:pinned.sourceSha256,shellSha256:pinned.shellSha256,resourceUsageMaxRSSUnit:'KiB (1024 bytes)',syntheticGuardRejectionBytes:SYNTHETIC_GUARD_REJECTION_BYTES,minimumHeadroomBytes:pinned.minimumHeadroomBytes,syntheticFixturePassesGuard:SYNTHETIC_GUARD_REJECTION_BYTES>=pinned.minimumHeadroomBytes,requestedMarginBytes:REQUESTED_MARGIN_BYTES,worstMeasuredPeakRssBytes:worst,windowsPeakPlusRequestedMarginBytes:worst+REQUESTED_MARGIN_BYTES,results,
  qualification:'Exact inline recovery program plus telemetry; offline verifier runs separately after live synthetic resume removal. Windows process RSS does not qualify Linux cgroup, page cache, tar/hash, or concurrent app growth. Shell guard itself is not executed on Windows.'};
}

export async function benchmarkStreamingBackup({executable,modulePath,cases=defaultCases,targetBytes=Math.floor(6.5*MIB),onResult=()=>{}}) {
 const runtime=validateBenchmarkRuntime(executable),source=readFileSync(modulePath,'utf8'),sourceSha256=createHash('sha256').update(source).digest('hex');
 if(!source.includes('function hashEncoded(')||!source.includes('statement.iterate()'))throw Error('streaming_row_hashing_not_ready');
 const results=[];
 for(const {kind,mode,heap,semiSpace=null,repeat=null} of cases){
  if(!['recovery','full'].includes(mode)||![24,32,48].includes(heap)||(semiSpace!==null&&semiSpace!==1))throw Error('unsupported_benchmark_case');
  const fixture=createStreamingFixture(kind,{targetBytes});
  try{const result=await measure(fixture,{executable,source,mode,heap,semiSpace,repeat});results.push(result);await onResult(result);}
  finally{fixture.cleanup();}
 }
 return {runtime,sourceKind:'caller-supplied-snapshot-module',sourceSha256,resourceUsageMaxRSSUnit:'KiB (1024 bytes)',conservativeReferenceBytes:CONSERVATIVE_REFERENCE_BYTES,requestedMarginBytes:REQUESTED_MARGIN_BYTES,results,
  qualification:'Synthetic Node24.20 Windows process only; not Linux cgroup qualification. Tar, filesystem page cache and concurrent application growth excluded.'};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [executable,modulePath,profile]=process.argv.slice(2);
 if(!executable||!modulePath)throw Error('usage_node24_executable_and_pinned_module_required');
 if(profile&& !['--compact-recovery','--final-inline-recovery'].includes(profile))throw Error('unknown_benchmark_profile');
 const onResult=measurement=>console.log(JSON.stringify({measurement}));
 if(profile==='--final-inline-recovery'){
  console.log(JSON.stringify({inlineRecoveryQualification:await benchmarkInlineRecovery({executable,shellPath:modulePath,onResult})}));
 }else{
 const qualification=await benchmarkStreamingBackup({executable,modulePath,cases:profile?compactRecoveryCases:defaultCases,onResult});
 console.log(JSON.stringify({qualification}));
 if(profile&&qualification.results.every(row=>row.completed&&row.exitCode===0&&row.format1DigestVerified)){
  const cases=[1,2,3].map(repeat=>({...compactRecoveryCases[0],repeat}));
  console.log(JSON.stringify({repeatedDenseQualification:await benchmarkStreamingBackup({executable,modulePath,cases,onResult})}));
 }
 }
}
