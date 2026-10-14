import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {benchmarkInlineRecovery,benchmarkStreamingBackup,compactRecoveryCases,createStreamingFixture,defaultCases,readInlineRecoveryProgram,SYNTHETIC_GUARD_REJECTION_BYTES,validateBenchmarkRuntime} from './benchmark-streaming-backup.mjs';

test('the qualification matrix starts with urgent recovery cases and covers each mode/heap/shape exactly once',()=>{
 assert.deepEqual(defaultCases.slice(0,2),[{kind:'many-small-rows',mode:'recovery',heap:32},{kind:'single-blob-row',mode:'recovery',heap:32}]);
 assert.equal(defaultCases.length,12);assert.equal(new Set(defaultCases.map(row=>JSON.stringify(row))).size,12);
});

test('generated recovery heredoc includes resume integration and rejects an independent synthetic 80 MiB fixture',()=>{
 const pinned=readInlineRecoveryProgram(new URL('./railway-console-recovery.sh',import.meta.url));
 assert.match(pinned.sourceSha256,/^[a-f0-9]{64}$/);assert.match(pinned.shellSha256,/^[a-f0-9]{64}$/);
 assert.equal(pinned.minimumHeadroomBytes,256*1024*1024);
 assert.equal(SYNTHETIC_GUARD_REJECTION_BYTES,80*1024*1024);
 assert(SYNTHETIC_GUARD_REJECTION_BYTES<pinned.minimumHeadroomBytes);
 assert(pinned.source.includes('createRecoverySnapshot(source,target,{uploadsRoot:uploads,resourceLimits:CONSOLE_RESOURCE_LIMITS})'));
});

test('compact profile preserves the original matrix and adds a two-byte text fixture',()=>{
 assert.equal(defaultCases.length,12);assert.equal(compactRecoveryCases.length,4);
 for(const row of compactRecoveryCases){assert.equal(row.mode,'recovery');assert.equal(row.heap,24);assert.equal(row.semiSpace,1);}
 const fixture=createStreamingFixture('single-two-byte-text-row',{targetBytes:128*1024});
 let db;
 try{
  db=new DatabaseSync(fixture.source,{readOnly:true});
  const {value,bytes}=db.prepare('SELECT value,length(CAST(value AS BLOB)) AS bytes FROM payload').get();
  assert.equal(bytes,fixture.payloadBytes);assert.equal(value.indexOf('\u{1f600}'),32767);
  assert.equal(value.length,fixture.payloadBytes-2);assert.match(fixture.expectedTableDigest,/^[a-f0-9]{64}$/);
 }finally{db?.close();fixture.cleanup();}
});

test('runtime validator does not silently qualify a different installed Node version',()=>{
 if(process.version!=='v24.20.0')assert.throws(()=>validateBenchmarkRuntime(process.execPath),/requires_official_node_24_20_0_win_x64/);
});

test('small synthetic full and recovery snapshots emit bounded-format measurements on the exact requested runtime',{skip:!process.env.APPLYPILOT_BENCHMARK_NODE||!process.env.APPLYPILOT_BENCHMARK_MODULE},async()=>{
 const result=await benchmarkStreamingBackup({executable:process.env.APPLYPILOT_BENCHMARK_NODE,modulePath:process.env.APPLYPILOT_BENCHMARK_MODULE,targetBytes:128*1024,cases:[{kind:'single-blob-row',mode:'recovery',heap:32},{kind:'single-blob-row',mode:'full',heap:32},{kind:'single-two-byte-text-row',mode:'recovery',heap:24,semiSpace:1}]});
 assert.equal(result.runtime.version,'v24.20.0');assert.match(result.sourceSha256,/^[a-f0-9]{64}$/);
 assert.doesNotMatch(JSON.stringify(result),/reportedHeadroom|sourceModule|sourceShell|[A-Za-z]:\\\\/);
 for(const row of result.results){assert.equal(row.completed,true);assert.equal(row.exitCode,0);assert.equal(row.format1DigestVerified,true);assert(row.maxRSSKiB>0);assert.equal(row.measuredPeakRssBytes,row.maxRSSKiB*1024);assert.equal(row.linuxCgroupQualified,false);assert.equal(row.includesTar,false);}
 assert.equal(result.results[0].uploadsIncluded,false);assert.equal(result.results[1].uploadCount,1);
 assert.deepEqual(result.results[2].nodeFlags,['--max-old-space-size=24','--max-semi-space-size=1']);
 assert.equal(result.results[2].semiSpaceMiB,1);
});

test('exact inline program copies referenced resumes and verifies them offline after synthetic live-file removal',{skip:!process.env.APPLYPILOT_BENCHMARK_NODE},async()=>{
 const result=await benchmarkInlineRecovery({executable:process.env.APPLYPILOT_BENCHMARK_NODE,shellPath:fileURLToPath(new URL('./railway-console-recovery.sh',import.meta.url)),targetBytes:128*1024,cases:[{kind:'single-two-byte-text-row'}]});
 assert.equal(result.syntheticGuardRejectionBytes,80*1024*1024);assert.equal(result.syntheticFixturePassesGuard,false);
 assert.doesNotMatch(JSON.stringify(result),/reportedHeadroom|sourceModule|sourceShell|[A-Za-z]:\\\\/);
 const row=result.results[0];
 assert.equal(row.completed,true);assert.equal(row.exitCode,0);assert.equal(row.format1DigestVerified,true);assert.equal(row.referencedResumeVerified,true);
 assert.equal(row.uploadsIncluded,true);assert.equal(row.uploadCount,1);assert.equal(row.offlineVerified,true);assert.equal(row.liveSyntheticResumeRemovedBeforeVerification,true);
 assert(row.offlineVerificationPeakRssBytes>0);assert.deepEqual(row.nodeFlags,['--max-old-space-size=24','--max-semi-space-size=1']);
});
