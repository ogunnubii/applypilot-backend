import test from 'node:test';
import assert from 'node:assert/strict';
process.env.SESSION_SECRET||='0123456789abcdef0123456789abcdef';
const {Handoffs,isFinalSubmitControl}=await import('./handoff.js');

const descriptor=(text,type='submit')=>({text,value:'',ariaLabel:'',title:'',type,disabled:false});

function interactiveHarness(){
 let pointControl=null,enterState=null;
 const actions=[];
 const main={
  url:()=> 'https://jobs.lever.co/example/role',
  locator:()=>({innerText:async()=> 'Application form'}),
  evaluate:async()=>null
 };
 const frameHandle={
  boundingBox:async()=>({x:100,y:200,width:600,height:400}),
  evaluate:async()=>({x:2,y:3}),
  dispose:async()=>{}
 };
 const child={
  url:()=> 'https://jobs.lever.co/example/role/apply',
  locator:()=>({innerText:async()=> 'Embedded application form'}),
  frameElement:async()=>frameHandle,
  evaluate:async(_fn,arg)=>{
   if(arg){assert.deepEqual(arg,{x:8,y:17});return pointControl;}
   return enterState;
  }
 };
 const page={
  isClosed:()=>false,
  frames:()=>[main,child],
  mainFrame:()=>main,
  url:()=>main.url(),
  mouse:{click:async()=>actions.push('click')},
  keyboard:{press:async()=>actions.push('key')}
 };
 const context={pages:()=>[page],close:async()=>actions.push('close')};
 return {page,context,actions,setPoint:value=>{pointControl=value},setEnter:value=>{enterState=value}};
}

test('final-action classifier never treats navigation controls as submission',()=>{
 for(const label of ['Review','Proceed','Next','Continue','Review and submit','Proceed to Submit'])assert.equal(isFinalSubmitControl(descriptor(label)),false,label);
 assert.equal(isFinalSubmitControl(descriptor('Submit application')),true);
 assert.equal(isFinalSubmitControl(descriptor('Send application','button')),true);
 assert.equal(isFinalSubmitControl(descriptor('Complete application','button')),true);
});

test('child-frame clicks record a genuine final submission before the click',async()=>{
 const harness=interactiveHarness();
 const handoffs=new Handoffs({onResume:()=>{},onClose:()=>{},onSubmitted:()=>{},onPossibleSubmit:async()=>{await Promise.resolve();harness.actions.push('record')}});
 await handoffs.hold({id:'job',user_id:'owner',challenge:'Ready to submit'},harness.context,harness.page);
 for(const label of ['Review','Proceed','Next','Continue']){
  harness.setPoint(descriptor(label));
  await handoffs.command('owner','job','click',{x:110,y:220,render:false});
 }
 assert.deepEqual(harness.actions,['click','click','click','click']);
 harness.setPoint(descriptor('Submit application'));
 await handoffs.command('owner','job','click',{x:110,y:220,render:false});
 assert.deepEqual(harness.actions.slice(-2),['record','click']);
});

test('child-frame Enter records only a genuine active or implicit final submit before the key',async()=>{
 const harness=interactiveHarness();
 const handoffs=new Handoffs({onResume:()=>{},onClose:()=>{},onSubmitted:()=>{},onPossibleSubmit:async()=>{await Promise.resolve();harness.actions.push('record')}});
 await handoffs.hold({id:'job',user_id:'owner',challenge:'Ready to submit'},harness.context,harness.page);
 harness.setEnter({activeControl:descriptor('Review')});
 await handoffs.command('owner','job','key',{key:'Enter',render:false});
 assert.deepEqual(harness.actions,['key']);
 harness.setEnter({activeControl:descriptor('Submit application')});
 await handoffs.command('owner','job','key',{key:'Enter',render:false});
 assert.deepEqual(harness.actions.slice(-2),['record','key']);
 harness.setEnter({implicitSubmitters:[descriptor('Continue')]});
 await handoffs.command('owner','job','key',{key:'Enter',render:false});
 assert.deepEqual(harness.actions.slice(-1),['key']);
 harness.setEnter({implicitSubmitters:[descriptor('Submit application') ]});
 await handoffs.command('owner','job','key',{key:'Enter',render:false});
 assert.deepEqual(harness.actions.slice(-2),['record','key']);
});

function passiveBrowser(id,closed){
 const frame={url:()=>`https://jobs.lever.co/example/${id}`,locator:()=>({innerText:async()=> 'Application form'})};
 const page={frames:()=>[frame],url:()=>frame.url(),isClosed:()=>false,screenshot:async()=>Buffer.from(id)};
 const context={pages:()=>[page],close:async()=>{closed.push(id)}};
 return {page,context};
}

test('full handoff capacity preserves ready sessions and rejects the newcomer',async()=>{
 const closed=[],events=[];
 const ready=passiveBrowser('ready',closed),newcomer=passiveBrowser('new',closed);
 const handoffs=new Handoffs({max:1,onResume:()=>{},onSubmitted:()=>{},onPossibleSubmit:()=>{},onClose:(job,message)=>events.push({id:job.id,message})});
 await handoffs.hold({id:'ready',user_id:'owner',challenge:'Ready to submit'},ready.context,ready.page);
 assert.equal(await handoffs.hold({id:'new',user_id:'owner'},newcomer.context,newcomer.page),false);
 assert.equal(handoffs.sessions.has('ready'),true);
 assert.equal(handoffs.sessions.has('new'),false);
 assert.deepEqual(closed,['new']);
 assert.match(events[0].message,/capacity is full/i);
});

test('ready sessions remain live for 12 hours while ordinary sessions keep short expiry',async()=>{
 let now=0;const closed=[];
 const ready=passiveBrowser('ready',closed),ordinary=passiveBrowser('ordinary',closed);
 const handoffs=new Handoffs({max:2,clock:()=>now,onResume:()=>{},onSubmitted:()=>{},onPossibleSubmit:()=>{},onClose:()=>{}});
 await handoffs.hold({id:'ready',user_id:'owner',challenge:'Ready to submit'},ready.context,ready.page);
 await handoffs.hold({id:'ordinary',user_id:'owner'},ordinary.context,ordinary.page);
 assert.equal((await handoffs.command('owner','ready','view')).expiresAt,12*60*60*1000);
 now=16*60*1000;await handoffs.expire();
 assert.equal(handoffs.sessions.has('ordinary'),false);
 assert.equal(handoffs.sessions.has('ready'),true);
 now=12*60*60*1000;await handoffs.expire();assert.equal(handoffs.sessions.has('ready'),true);
 now++;await handoffs.expire();assert.equal(handoffs.sessions.has('ready'),false);
 assert.deepEqual(closed,['ordinary','ready']);
});
