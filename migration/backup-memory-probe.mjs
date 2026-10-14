import {DatabaseSync} from 'node:sqlite';
import {createHash,randomBytes} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const MIB=1024*1024;
// Blob is shared by the earlier tested local tree and published PR tree.
export const OLD_BACKUP_REVISION='4fddb3b21238e502451fdb6f860b0e7ab154cb88';
const repository=dirname(dirname(fileURLToPath(import.meta.url)));
const marker='APPLYPILOT_BACKUP_MODULE';
const sha=value=>createHash('sha256').update(value).digest('hex');

// Pin the original committed command. Importing build-console-backup.mjs would
// regenerate an existing tracked file, and reading current source would race
// the independently authored streaming replacement. Neither happens here.
export function oldConsoleProgram() {
 const shell=execFileSync('git',['show',OLD_BACKUP_REVISION],{cwd:repository,encoding:'utf8',windowsHide:true,maxBuffer:2*MIB});
 const begin=shell.indexOf("<<'"+marker+"'\n"),end=shell.lastIndexOf('\n'+marker);
 if(begin<0||end<=begin)throw Error('pinned_backup_heredoc_missing');
 return shell.slice(begin+("<<'"+marker+"'\n").length,end);
}
function cleanTemp(root) {
 const target=resolve(root),boundary=resolve(tmpdir()),r=relative(boundary,target);
 if(!r||r==='..'||r.startsWith('..'+sep)||!target.includes('applypilot-memory-fixture-'))throw Error('unsafe_probe_cleanup');
 rmSync(target,{recursive:true,force:true});
}

export function createMemoryFixture(kind,{targetBytes=Math.floor(6.5*MIB)}={}) {
 if(!['many-small-rows','single-text-row','single-blob-row'].includes(kind))throw Error('unknown_probe_fixture');
 if(!Number.isSafeInteger(targetBytes)||targetBytes<65536||targetBytes>8*MIB)throw Error('invalid_probe_size');
 const root=mkdtempSync(join(tmpdir(),'applypilot-memory-fixture-')),source=join(root,'synthetic.sqlite'),uploads=join(root,'resumes');
 const engine=new DatabaseSync(source);let rows=0,payloadBytes=0;
 try{
  engine.exec('PRAGMA page_size=4096; PRAGMA journal_mode=DELETE; PRAGMA synchronous=OFF; CREATE TABLE payload(value)');
  if(kind==='many-small-rows'){
   const add=engine.prepare('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO payload SELECT 0 FROM n');
   engine.exec('BEGIN');
   while(Number(engine.prepare('PRAGMA page_count').get().page_count)*4096<targetBytes){add.run(1000);rows+=1000;}
   engine.exec('COMMIT');
  }else{
   // Leave room for table header and overflow-page links, keeping the total
   // near 6.5 MiB. Incompressible blob stresses the final archive Buffer too.
   payloadBytes=targetBytes-32768;
   const value=kind==='single-text-row'?'x'.repeat(payloadBytes):randomBytes(payloadBytes);
   engine.prepare('INSERT INTO payload VALUES(?)').run(value);rows=1;
  }
 }catch(error){engine.close();cleanTemp(root);throw error;}
 engine.close();
 mkdirSync(uploads);writeFileSync(join(uploads,'synthetic.pdf'),randomBytes(52*1024));
 return {root,source,uploads,kind,rows,payloadBytes,databaseBytes:statSync(source).size,resumeBytes:52*1024,cleanup:()=>cleanTemp(root)};
}

function runChild(fixture,program,heapMiB) {
 return new Promise((resolveResult,reject)=>{
  const script=join(fixture.root,'measured-'+(heapMiB??'default')+'.mjs'),destination=join(fixture.root,'out-'+(heapMiB??'default'));
  mkdirSync(destination);
  const telemetry=`
const probeMetrics=phase=>console.log(JSON.stringify({probe_memory:true,phase,maxRSSKiB:process.resourceUsage().maxRSS,...process.memoryUsage()}));
process.on('exit',()=>probeMetrics('exit'));
await new Promise(resolveStart=>process.once('message',message=>{if(message!=='start')throw Error('invalid_probe_start');process.disconnect();resolveStart();}));
probeMetrics('baseline');
`;
  writeFileSync(script,telemetry+program);
  const flags=heapMiB===null?[]:['--max-old-space-size='+heapMiB];
  const child=spawn(process.execPath,[...flags,script,'--approved-full-state-backup',fixture.source,fixture.uploads,destination],{cwd:fixture.root,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  let stdout='',stderr='',externalPeak=0,monitorError=false,monitor=null,started=false,timedOut=false;
  const start=()=>{if(!started){started=true;child.send('start');}};
  const timer=setTimeout(()=>{timedOut=true;child.kill();},120000);
  child.stdout.on('data',data=>{stdout+=data;});child.stderr.on('data',data=>{if(stderr.length<65536)stderr+=data;});
  child.on('error',error=>{clearTimeout(timer);reject(error);});
  // Sample only this freshly spawned synthetic child. Windows keeps a peak
  // working-set counter; sampling may miss the final interval before an OOM,
  // so it is labeled a lower bound when no final resourceUsage sample exists.
  // The monitor's own memory and tar subprocess memory are NOT included.
  if(process.platform==='win32'){
   const command=`$ErrorActionPreference='Stop'; $probeProcess=Get-Process -Id ${child.pid}; $probePeak=0L; Write-Output 'READY'; try { do { $probeProcess.Refresh(); if($probeProcess.PeakWorkingSet64 -gt $probePeak){$probePeak=$probeProcess.PeakWorkingSet64}; Start-Sleep -Milliseconds 10 } while(-not $probeProcess.HasExited) } catch {} ; Write-Output ('PEAK:'+ $probePeak)`;
   monitor=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,stdio:['ignore','pipe','ignore']});
   let monitorText='';
   monitor.stdout.on('data',data=>{monitorText+=data;if(monitorText.includes('READY'))start();});
   monitor.on('error',()=>{monitorError=true;start();});
   monitor.on('close',()=>{const match=monitorText.match(/PEAK:(\d+)/);if(match)externalPeak=Number(match[1]);else monitorError=true;start();});
  }else start();
  child.on('close',async(code,signal)=>{
   clearTimeout(timer);
   if(monitor&&monitor.exitCode===null)await new Promise(done=>monitor.once('close',done));
   const parsed=stdout.split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
   const baseline=parsed.find(row=>row.probe_memory&&row.phase==='baseline')||null,final=parsed.find(row=>row.probe_memory&&row.phase==='exit')||null;
   const peakBytes=final?final.maxRSSKiB*1024:externalPeak||null;
   resolveResult({fixture:fixture.kind,rows:fixture.rows,databaseBytes:fixture.databaseBytes,payloadBytes:fixture.payloadBytes,resumeBytes:fixture.resumeBytes,
    heapLimitMiB:heapMiB??'default',exitCode:code,signal,timedOut,completed:parsed.some(row=>row.backup_ready===true),
    failure:timedOut?'timeout':/heap out of memory|Reached heap limit|Allocation failed/i.test(stderr)?'v8_heap_out_of_memory':code===0?null:'backup_or_runtime_failure',
    baselineRssBytes:baseline?.rss??null,finalRssBytes:final?.rss??null,maxRSSKiB:final?.maxRSSKiB??null,
    measuredPeakRssBytes:peakBytes,peakIsLowerBound:!final,windowsSampledPeakBytes:externalPeak||null,monitorError,
    includesTarSubprocess:false,linuxCgroupQualified:false});
  });
 });
}

export async function qualifyBackupMemory({kinds=['many-small-rows','single-text-row','single-blob-row'],heaps=[48,null],targetBytes=Math.floor(6.5*MIB),onResult=()=>{}}={}) {
 const program=oldConsoleProgram(),results=[];
 for(const kind of kinds){
  const fixture=createMemoryFixture(kind,{targetBytes});
  try{for(const heap of heaps){const result=await runChild(fixture,program,heap);results.push(result);await onResult(result);}}
  finally{fixture.cleanup();}
 }
 return {sourceRevision:OLD_BACKUP_REVISION,consoleProgramSha256:sha(program),platform:process.platform,node:process.version,
  resourceUsageMaxRSSUnit:'KiB (1024 bytes)',results,
  conclusion:'Synthetic Windows process measurements cannot qualify Linux cgroup safety; tar, page cache and concurrent application growth are excluded.'};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const result=await qualifyBackupMemory({onResult:row=>console.log(JSON.stringify({measurement:row}))});
 console.log(JSON.stringify({qualification:result}));
}
