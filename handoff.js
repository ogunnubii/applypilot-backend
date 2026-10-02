import {supported} from './local-policy.js';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {readToken} from './auth.js';
const receipt=/thank you for (applying|your application)|application (has been )?(submitted|received)|successfully applied/i;
const intermediateAction=/\b(next|continue|review|proceed)\b|sign\s*in|log\s*in/i;
const explicitFinalAction=/\bsubmit\b|\bsend\s+(?:my\s+)?application\b|\bcomplete\s+(?:my\s+)?application\b/i;
export function isFinalSubmitControl(control){
 if(!control||control.disabled)return false;
 const label=[control.text,control.value,control.ariaLabel,control.title].filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
 if(intermediateAction.test(label))return false;
 return explicitFinalAction.test(label)||(['submit','image'].includes(String(control.type||'').toLowerCase())&&!/sign\s*in|log\s*in/i.test(label));
}
async function framePointControl(page,x,y){
 const frames=page.frames(),main=page.mainFrame?.()||frames[0];
 for(const frame of frames){
  if(!supported(frame.url()))continue;
  let point={x,y};
  if(frame!==main){
   const handle=frame.frameElement?await frame.frameElement().catch(()=>null):null;if(!handle)continue;
   try{
    const box=await handle.boundingBox().catch(()=>null);if(!box||x<box.x||y<box.y||x>box.x+box.width||y>box.y+box.height)continue;
    const inset=handle.evaluate?await handle.evaluate(element=>({x:element.clientLeft||0,y:element.clientTop||0})).catch(()=>({x:0,y:0})):{x:0,y:0};
    point={x:x-box.x-inset.x,y:y-box.y-inset.y};
   }finally{if(handle.dispose)await handle.dispose().catch(()=>{})}
  }
  const control=await frame.evaluate(({x:localX,y:localY})=>{const element=document.elementFromPoint(localX,localY)?.closest('button,input[type="submit"],input[type="image"],[role="button"]');return element?({text:String(element.innerText||''),value:String(element.value||''),ariaLabel:String(element.getAttribute('aria-label')||''),title:String(element.getAttribute('title')||''),type:String(element.type||element.getAttribute('type')||''),disabled:!!element.disabled||element.getAttribute('aria-disabled')==='true'}):null},point).catch(()=>null);
  if(control)return control;
 }
 return null;
}
async function enterSubmitControl(page){
 for(const frame of page.frames()){
  if(!supported(frame.url()))continue;
  const state=await frame.evaluate(()=>{
   if(!document.hasFocus())return null;
   const active=document.activeElement;if(!active||active===document.body||active===document.documentElement||active.tagName==='IFRAME')return null;
   const describe=element=>({text:String(element?.innerText||''),value:String(element?.value||''),ariaLabel:String(element?.getAttribute?.('aria-label')||''),title:String(element?.getAttribute?.('title')||''),type:String(element?.type||element?.getAttribute?.('type')||''),disabled:!!element?.disabled||element?.getAttribute?.('aria-disabled')==='true'});
   const activeControl=active.closest?.('button,input[type="submit"],input[type="image"],[role="button"]');if(activeControl)return {activeControl:describe(activeControl)};
   if(active.matches?.('textarea,[contenteditable="true"],[contenteditable=""],select,input[type="button"],input[type="reset"],input[type="checkbox"],input[type="radio"],input[type="file"]'))return {blocked:true};
   const form=active.form||active.closest?.('form');if(!form||!active.matches?.('input'))return {blocked:true};
   const visible=element=>{const rect=element.getBoundingClientRect(),style=getComputedStyle(element);return rect.width>1&&rect.height>1&&style.display!=='none'&&style.visibility!=='hidden'&&!element.disabled&&element.getAttribute('aria-disabled')!=='true'};
   const submitters=[...form.querySelectorAll('button,input[type="submit"],input[type="image"]')].filter(element=>visible(element)&&['submit','image'].includes(String(element.type||'').toLowerCase())).map(describe);
   return {implicitSubmitters:submitters};
  }).catch(()=>null);
  if(!state)continue;
  if(state.activeControl)return isFinalSubmitControl(state.activeControl)?state.activeControl:null;
  if(state.blocked)return null;
  if(state.implicitSubmitters?.length===1&&isFinalSubmitControl(state.implicitSubmitters[0]))return state.implicitSubmitters[0];
  return null;
 }
 return null;
}
export class Handoffs {
 constructor({onResume,onClose,onSubmitted,onPossibleSubmit,max=3,clock=Date.now}){Object.assign(this,{onResume,onClose,onSubmitted,onPossibleSubmit,max,clock});this.sessions=new Map()}
 full(){return this.sessions.size>=this.max}
 async hold(job,context,page){
  if(this.sessions.has(job.id))return;
  if(this.full()){await context.close().catch(()=>{});this.onClose(job,'Live browser capacity is full. This application remains saved until a slot is available.');return false;}
  let initial='';for(const frame of page.frames())if(supported(frame.url()))initial+='\n'+await frame.locator('body').innerText({timeout:1500}).catch(()=>'');
  const session={job,context,page,created:this.clock(),touched:this.clock(),busy:false,ready:job.challenge==='Ready to submit',attempted:['Submission in progress','Unconfirmed submission'].includes(job.challenge),initialReceipt:receipt.test(initial),chooser:null};
  const attach=p=>p.on?.('filechooser',chooser=>{session.chooser=chooser});context.pages().forEach(attach);context.on?.('page',attach);
  this.sessions.set(job.id,session);
 }
 async expire(){for(const [id,s] of this.sessions){const expired=s.ready?this.clock()-s.created>12*60*60*1000:(this.clock()-s.touched>15*60*1000||this.clock()-s.created>45*60*1000);if(!s.busy&&expired){this.sessions.delete(id);await s.context.close().catch(()=>{});this.onClose(s.job,s.ready?'Ready-to-submit browser expired after 12 hours. Reopen the application to prepare it again.':'Live browser expired. Saved answers remain; reopen to restart the form.')}}}
 async command(uid,id,action,data={}){
  await this.expire();const s=this.sessions.get(id);
  if(!s||s.job.user_id!==uid){const e=Error('No live browser for this application');e.status=404;throw e}
  if(s.busy){const e=Error('Browser is processing your last action');e.status=409;throw e}
  s.busy=true;
  try{
   const pages=s.context.pages().filter(p=>!p.isClosed());if(!pages.length)throw Error('Employer browser closed');s.page=pages.at(-1);const p=s.page;
   if(action==='close'){this.sessions.delete(id);await s.context.close();this.onClose(s.job,'Live browser closed by applicant');return {closed:true}}
   if(action==='resume'){
    await this.onResume(s.job,s);
    this.sessions.delete(id);return {resumed:true};
   }
   if(action==='click'){
    if(!Number.isFinite(data.x)||!Number.isFinite(data.y)||data.x<0||data.y<0||data.x>1100||data.y>800)throw Error('Invalid click');
    const possible=isFinalSubmitControl(await framePointControl(p,data.x,data.y));
    if(possible){s.attempted=true;await this.onPossibleSubmit(s.job);}
    await p.mouse.click(data.x,data.y);s.touched=this.clock();
   }else if(action==='drag'){
    if(!Array.isArray(data.points)||data.points.length<2||data.points.length>40||data.points.some(v=>!Number.isFinite(v.x)||!Number.isFinite(v.y)||v.x<0||v.x>1100||v.y<0||v.y>800))throw Error('Invalid drag');
    await p.mouse.move(data.points[0].x,data.points[0].y);await p.mouse.down();try{for(const point of data.points.slice(1))await p.mouse.move(point.x,point.y)}finally{await p.mouse.up()}s.touched=this.clock();
   }else if(action==='upload'){
    if(!s.chooser)throw Error('Click the employer upload control first');
    if(typeof data.base64!=='string'||data.base64.length>8500000||!/^[A-Za-z0-9+/]*={0,2}$/.test(data.base64))throw Error('Invalid file');
    const buffer=Buffer.from(data.base64,'base64');if(buffer.length>6*1024*1024)throw Error('File must be smaller than 6 MB');
    const name=String(data.name||'').replace(/[^a-zA-Z0-9._-]/g,'_').slice(-150);
    const pdf=/\.pdf$/i.test(name)&&buffer.subarray(0,5).toString()==='%PDF-';const docx=/\.docx$/i.test(name)&&buffer.subarray(0,2).toString()==='PK';if(!pdf&&!docx)throw Error('Use a PDF or DOCX file');
    await s.chooser.setFiles({name,mimeType:pdf?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer});s.chooser=null;s.touched=this.clock();
   }else if(action==='text'){
    if(typeof data.text!=='string'||!data.text.length||data.text.length>4000)throw Error('Enter up to 4,000 characters');
    await p.keyboard.insertText(data.text);s.touched=this.clock();
   }else if(action==='key'){
    if(!['Tab','Shift+Tab','Enter','Backspace','Delete','ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End','PageDown','PageUp','Escape','ControlOrMeta+A','Space'].includes(data.key))throw Error('Unsupported key');
    if(data.key==='Enter'){
     const possible=!!await enterSubmitControl(p);
     if(possible){s.attempted=true;await this.onPossibleSubmit(s.job);}
    }
    await p.keyboard.press(data.key);s.touched=this.clock();
   }else if(action==='scroll'){
    if(!Number.isFinite(data.y)||Math.abs(data.y)>1000||!Number.isFinite(data.x??0)||Math.abs(data.x??0)>1000)throw Error('Invalid scroll');
    if(data.pointerX!==undefined||data.pointerY!==undefined){if(!Number.isFinite(data.pointerX)||!Number.isFinite(data.pointerY)||data.pointerX<0||data.pointerX>1100||data.pointerY<0||data.pointerY>800)throw Error('Invalid pointer');await p.mouse.move(data.pointerX,data.pointerY);}
    await p.mouse.wheel(data.x||0,data.y);s.touched=this.clock();
   }else if(action!=='view')throw Error('Unsupported browser action');
   // Input acknowledgements do not wait for image capture. The next view checks receipts.
   if(data.render===false&&['click','drag','text','key','scroll'].includes(action))return {accepted:true};
   let content='';if(s.attempted&&!s.initialReceipt)for(const frame of p.frames())if(supported(frame.url()))content+='\n'+await frame.locator('body').innerText({timeout:1500}).catch(()=>'');
   if(s.attempted&&!s.initialReceipt&&receipt.test(content)){const match=content.match(receipt);this.onSubmitted(s.job,content.slice(Math.max(0,match.index-40),match.index+250).trim());this.sessions.delete(id);await s.context.close();return {submitted:true}}
   const image=await p.screenshot({type:'jpeg',quality:60,timeout:10000});
   const frameId=createHash('sha256').update(image).digest('hex');
   const url=new URL(p.url());return {image:data.frameId===frameId?undefined:image.toString('base64'),frameId,width:1100,height:800,host:url.hostname,uploadRequested:!!s.chooser,expiresAt:s.ready?s.created+12*60*60*1000:Math.min(s.touched+15*60*1000,s.created+45*60*1000)};
  }finally{s.busy=false}
 }
}
export function serveHandoffs(handoffs,port=8081){
 const server=createServer(async(req,res)=>{res.setHeader('cache-control','no-store');res.setHeader('content-type','application/json');try{
  const uid=readToken(req.headers.authorization?.replace(/^Bearer /i,''));if(!uid){res.writeHead(401);res.end(JSON.stringify({error:'Sign in required'}));return}
  const route=new URL(req.url,'http://localhost').pathname.match(/^\/([a-f0-9-]+)\/(view|click|drag|upload|text|key|scroll|resume|close)$/);if(!route)throw Error('Unknown action');
  let body='',size=0;for await(const b of req){size+=b.length;if(size>9000000)throw Error('Input too large');body+=b}
  const out=await handoffs.command(uid,route[1],route[2],body?JSON.parse(body):{});res.end(JSON.stringify(out));
 }catch(e){res.writeHead(e.status||400);res.end(JSON.stringify({error:e.message}))}});
 return server.listen(port,'127.0.0.1');
}
