import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {diversifyApplications,prioritizeApplications,spreadDiscoveryBoards,applicationPlatform} from '../application-diversity.js';
const job=(id,company,platform='greenhouse',score=90)=>({id,company,title:'Platform Engineer '+id,url:platform==='greenhouse'?'https://job-boards.greenhouse.io/'+company+'/jobs/'+id:platform==='lever'?'https://jobs.lever.co/'+company+'/'+id:'https://jobs.ashbyhq.com/'+company+'/'+id,status:'queued',match_score:score});
test('new employers and a mix of platforms precede repeat-company batches without dropping jobs',()=>{
 const jobs=[...Array.from({length:8},(_,i)=>job('a'+i,'A','greenhouse',99)),job('b','B','greenhouse',85),job('c','C','lever',84),job('d','D','ashby',83)];
 const ranked=diversifyApplications(jobs);assert.deepEqual(ranked.slice(0,4).map(j=>j.company),['A','C','D','B']);assert.equal(ranked.length,jobs.length);assert.equal(new Set(ranked.map(j=>j.id)).size,jobs.length);assert.equal(jobs[0].id,'a0');
 assert.equal(ranked.find(j=>j.company==='A').match_score,99,'fit scores are preserved');
});
test('five previous roles put further same-company work behind underrepresented companies',()=>{
 const history=Array.from({length:5},(_,i)=>({...job('old'+i,'A'),status:'submitted'}));
 const rows=diversifyApplications([job('a','A','lever',100),...Array.from({length:6},(_,i)=>job('b'+i,'B','greenhouse',75))],history);
 assert(rows.findIndex(j=>j.id==='a')>=5);assert.equal(diversifyApplications([job('a','A')],history).length,1,'soft rotation does not block available work');
});
test('company aliases across platforms and imported history share company exposure',()=>{
 const history=Array.from({length:5},(_,i)=>({id:'external'+i,company:'PricewaterhouseCoopers',title:'Cloud Engineer '+i,status:'applied',external:true}));
 const rows=diversifyApplications([job('p','pwc','lever',100),job('new','NewCo','greenhouse',70)],history);assert.equal(rows[0].id,'new');
 const aliasHistory=[...history,...history.map((j,i)=>({...j,id:'native'+i,company:'pwc',external:false,status:'submitted'}))];
 const competingHistory=Array.from({length:6},(_,i)=>({...job('z'+i,'Z','ashby'),status:'submitted'}));
 assert.equal(diversifyApplications([job('p','pwc','lever',100),job('z','Z','greenhouse',70)],[...aliasHistory,...competingHistory])[0].id,'p','imported/native copy is counted once');
});
test('database ordering is account scoped and leaves outcomes and attempts unchanged',()=>{
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE jobs(id,company,title,url,normalized_url,status,attempts,local_attempt_at,confirmation,user_id);CREATE TABLE external_application_history(id,company,title,status,user_id);');
 for(let i=0;i<8;i++)db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?)').run('old'+i,'A','Role '+i,'https://jobs.lever.co/A/old'+i,'','submitted',1,'2026',null,'other');
 const rows=[job('a','A','greenhouse',99),job('b','B','lever',80),{...job('done','A'),status:'submitted',confirmation:'receipt'},{...job('attempt','A'),local_attempt_at:'2026'}];
 const ranked=prioritizeApplications(db,'owner',rows);assert.equal(ranked[0].id,'a');assert.equal(ranked[0].queue_position,1);assert.equal(ranked.find(j=>j.id==='done').confirmation,'receipt');assert.equal(ranked.find(j=>j.id==='attempt').queue_position,undefined);db.close();
});
test('discovery rotates platforms while preserving every distinct employer board',()=>{
 const boards=['https://boards.greenhouse.io/a','https://boards.greenhouse.io/b','https://jobs.ashbyhq.com/c','https://jobs.ashbyhq.com/d','https://jobs.lever.co/e'];
 const spread=spreadDiscoveryBoards(boards);assert.deepEqual(spread.map(applicationPlatform),['greenhouse','ashby','lever','greenhouse','ashby']);assert.equal(new Set(spread).size,boards.length);
});
test('the extension honors server rotation ahead of fit score and its stale local queue',async()=>{
 const state={enabled:true,records:{},queue:['high']},noop={addListener(){}};
 const chrome={storage:{local:{get:async()=>state,set:async patch=>Object.assign(state,patch)}},tabs:{onRemoved:noop},runtime:{onMessage:noop,onStartup:noop,onInstalled:noop},alarms:{onAlarm:noop}};
 const ctx=vm.createContext({chrome,URL,Date,setTimeout,clearTimeout,importScripts(){},ApplyPilotPolicy:{supported:()=>true}});
 const source=readFileSync('extension/background.js','utf8');
 vm.runInContext(source+';api=async()=>({jobs:[{id:"high",url:"https://jobs.lever.co/A/high",status:"queued",execution_mode:"local",match_score:100,queue_position:2},{id:"diverse",url:"https://jobs.lever.co/B/diverse",status:"queued",execution_mode:"local",match_score:85,queue_position:1}]});openJob=async id=>{globalThis.opened=id;};globalThis.testTick=tick;',ctx);
 await ctx.testTick();assert.equal(ctx.opened,'diverse');assert.deepEqual(Array.from(state.queue),['high']);
});
