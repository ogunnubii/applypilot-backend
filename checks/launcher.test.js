// Regression checks for the Windows launcher. CI has no Windows PowerShell, so
// these guard the constructs that broke (or would break) on PowerShell 5.1.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const ps1=readFileSync(new URL('../start-local.ps1',import.meta.url),'utf8');
const cmd=readFileSync(new URL('../ApplyPilot.cmd',import.meta.url),'utf8');
const code=ps1.split(/\r?\n/).filter(line=>!/^\s*#/.test(line));

test('no JavaScript is passed to node on the command line (PowerShell 5.1 strips its inner quotes)',()=>{
 // The original bug: node -p 'process.versions.node.split(".")[0]' arrived as split(.) and threw.
 for(const line of code)assert(!/\bnode(?:\.exe)?\b[^#\n]*\s(?:-p|-e|--print|--eval)\b/i.test(line),line);
 for(const line of code.filter(l=>/&\s*node\b/i.test(l)))assert(!line.includes('"'),'node arguments must not contain double quotes: '+line);
 assert(!/\bnode(?:\.exe)?\b[^\r\n]*\s(?:-p|-e)\b/i.test(cmd));
});

test('Node version check uses node --version and accepts 24+',()=>{
 assert.match(ps1,/\$version = \[string\]\(& node --version\)/);
 const pattern=/'\^v\(\\d\+\)\\\.'/;assert.match(ps1,pattern,'expected the ^v(\\d+)\\. pattern');
 const major=v=>(v.match(/^v(\d+)\./)||[])[1];
 assert.equal(major('v24.21.0'),'24');assert.equal(major('v100.0.1'),'100');assert.equal(major('24.0.0'),undefined);
 assert.match(ps1,/\[int\]\$Matches\[1\] -lt 24/);
});

test('secrets come from the .NET RNG and .env.local is written without a byte-order mark',()=>{
 assert.match(ps1,/RandomNumberGenerator\]::Create\(\)/);
 assert.match(ps1,/New-Object System\.Text\.UTF8Encoding \$false/);
 assert.match(ps1,/WriteAllLines\(\$envFile, \[string\[\]\]\$lines, \$utf8\)/);
 for(const line of code)assert(!/Set-Content[^\n]*\.env\.local/i.test(line)&&!/Out-File[^\n]*\.env\.local/i.test(line),line);
});

test('configurable port: -Port is validated, saved, and never confused with the resolved port',()=>{
 assert.match(ps1,/\[int\]\$Port = 0/);
 assert.match(ps1,/\$value -ge 1024 -and \$value -le 65535/);
 // PowerShell variables are case-insensitive: assigning "$port" would overwrite the -Port parameter.
 for(const line of code.filter(l=>!/^\s*\[int\]\$Port = 0,$/.test(l)))assert(!/\$port\s*=/i.test(line.replace(/\$portRequested/gi,'')),line);
 assert.match(ps1,/\$appPort = if \(\$portRequested\) \{ \$Port \} elseif \(Test-PortValue \$savedPort\) \{ \$savedPort \} else \{ 8080 \}/);
 assert.match(ps1,/\$url = "http:\/\/localhost:\$appPort"/);
 assert.match(ps1,/PORT = \$appPort; PUBLIC_ORIGIN = \$url; SERVICE_ORIGIN = \$url/,'port and origins stay in step');
 assert(!/localhost:8080/.test(code.join('\n')),'no hard-coded local origin');
});

test('a port used by another program is reported, never stopped or reused',()=>{
 assert.match(ps1,/function Test-PortFree/);
 assert.match(ps1,/ConnectAsync\('127\.0\.0\.1', \$appPort\)/);
 assert.match(ps1,/IPAddress\]::Loopback\), \$appPort/);
 assert(!/IPAddress\]::Any/.test(code.join('\n')),'no 0.0.0.0 bind (firewall prompt)');
 assert.match(ps1,/already used by another program[^"]*leaves it running/);
 // The only process ApplyPilot stops is the one recorded in its own PID file, and only if it is node.
 const stops=code.filter(l=>/Stop-Process/.test(l));assert.deepEqual(stops.map(l=>l.trim()),['Stop-Process -Id $p.Id']);
 assert.match(ps1,/\$p\.ProcessName -match '\^node'/);
});

test('ApplyPilot.cmd forwards arguments (quoted paths intact) and defaults to start',()=>{
 assert(cmd.includes('\r\n'),'CRLF line endings for cmd.exe');
 assert.match(cmd,/start-local\.ps1" start\r?\n/);
 assert.match(cmd,/start-local\.ps1" %\*\r?\n/);
 assert(!/set "AP_ARGS=%\*"/.test(cmd),'arguments are not re-parsed through a variable');
 assert.match(cmd,/-ExecutionPolicy Bypass -File/);
});

test('import uses the same .env.local (and therefore the same database and port)',()=>{
 assert.match(ps1,/\$importArgs = @\('--env-file=\.env\.local', 'import-local\.js', \$File\)/);
 const importer=readFileSync(new URL('../import-local.js',import.meta.url),'utf8');
 assert.match(importer,/process\.env\.PUBLIC_ORIGIN/);
});
