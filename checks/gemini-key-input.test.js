import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('Windows Gemini setup accepts modern opaque keys and paste padding, rejects embedded lines and commands', {skip:process.platform!=='win32'},()=>{
 const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./gemini-key-input.ps1',import.meta.url))],{encoding:'utf8',windowsHide:true,timeout:10000});
 assert.equal(result.status,0,result.stderr||result.stdout||result.error?.message);
 assert.match(result.stdout,/PASS: Gemini key input compatibility and injection checks/);
});
