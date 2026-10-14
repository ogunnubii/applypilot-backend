// Source-only report; never opens application data or imports runtime startup.
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {databaseInventory} from './database-inventory.mjs';
const root=new URL('../',import.meta.url),read=file=>readFileSync(new URL(file,root),'utf8').replaceAll('\r\n','\n');
const targets={server:['notificationPreferences','professionalExperience','exportPreparationLedger','reservePreparation','applicationHistory','authorizePreparationStep','syncLocalReceipt'],worker:['syncHostedReceipt']};
const sites=[];
for(const [module,names] of Object.entries(targets)){
 const file=module+'.js',source=read(file),pattern=new RegExp('\\bawait ('+names.join('|')+')\\(asyncDatabase\\b','g');
 for(const match of source.matchAll(pattern))sites.push({file,line:source.slice(0,match.index).split('\n').length,callee:match[1]});
}
const apis=readdirSync(new URL('api/',root)).filter(f=>f.endsWith('.js')&&!f.endsWith('.test.js')).sort().map(name=>{
 const file='api/'+name,source=read(file);return {file,scoped_sql_calls:[...source.matchAll(/\btx\.(get|all|run)\s*\(/g)].length,sha256:createHash('sha256').update(source).digest('hex')};
});
console.log(JSON.stringify({...databaseInventory(),async_api_slices:apis,scoped_api_sql_calls:apis.reduce((n,r)=>n+r.scoped_sql_calls,0),converted_production_invocations:sites.length,production_invocations:sites,http_method_operations:12,hosted_receipt_paths:2,new_imported_admission_guard_calls:[{file:'server.js',callee:'importedPreparationAccess'}],notes:['Counts are lexical and are not a completion percentage.','The imported admission guard is new and excluded from converted invocation counts.','Native guard UDFs, startup, unported writers and post-receipt helpers remain; remote runtime is disabled.']},null,2));
