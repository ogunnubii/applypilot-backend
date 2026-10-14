// Source-only inventory. Never imports db.js or opens application data.
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
export function databaseInventory(root=fileURLToPath(new URL('../',import.meta.url))){
 const modules=[],functions=new Set();
 for(const file of readdirSync(root).filter(f=>f.endsWith('.js')&&!f.endsWith('.test.js')).sort()){
  const source=readFileSync(resolve(root,file),'utf8').replaceAll('\r\n','\n');
  const calls=[...source.matchAll(/\bdb\.(prepare|exec)\s*\(/g)];
  for(const match of source.matchAll(/\bdb\.function\('([^']+)'/g))functions.add(match[1]);
  if(calls.length)modules.push({file,direct_calls:calls.length,explicit_write_transactions:[...source.matchAll(/BEGIN IMMEDIATE/g)].length,sha256:createHash('sha256').update(source).digest('hex')});
 }
 return {method:'Source lexical inventory; direct db.prepare/db.exec calls, not transitive callers or SQL statements.',modules:modules.length,direct_calls:modules.reduce((n,m)=>n+m.direct_calls,0),explicit_write_transactions:modules.reduce((n,m)=>n+m.explicit_write_transactions,0),custom_functions:[...functions].sort(),files:modules};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)console.log(JSON.stringify(databaseInventory(),null,2));
