import test from 'node:test';
import assert from 'node:assert/strict';
import {oldConsoleProgram,qualifyBackupMemory} from './backup-memory-probe.mjs';

test('old backup qualification pins the committed full console program without running the builder',()=>{
 const program=oldConsoleProgram();
 assert.match(program,/statement\.all\(\)\.map/);
 assert.match(program,/hash\(readFileSync\(archive\)\)/);
 assert.match(program,/execFileSync\('tar'/);
});

test('synthetic probe measures the full pinned backup subprocess without disclosing fixture contents',async()=>{
 const result=await qualifyBackupMemory({kinds:['single-blob-row'],heaps:[48],targetBytes:128*1024});
 assert.equal(result.results.length,1);
 const row=result.results[0];assert.equal(row.completed,true);assert.equal(row.exitCode,0);
 assert(row.maxRSSKiB>0);assert.equal(row.measuredPeakRssBytes,row.maxRSSKiB*1024);
 assert(row.finalRssBytes>0);assert.equal(row.linuxCgroupQualified,false);assert.equal(row.includesTarSubprocess,false);
 assert.doesNotMatch(JSON.stringify(result),/synthetic\.pdf|application rows|payload value/);
 assert.doesNotMatch(JSON.stringify(result),/reportedHeadroom|sourceModule|sourceShell|[A-Za-z]:\\\\/);
});
