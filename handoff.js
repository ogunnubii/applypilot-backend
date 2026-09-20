import {createServer} from 'node:http';
import {readToken} from './auth.js';
const receipt=/thank you for (applying|your application)|application (has been )?(submitted|received)|successfully applied/i;
export class Handoffs {
 constructor({onResume,onClose,onSubmitted,onPossibleSubmit,max=3,clock=Date.now}){Object.assign(this,{onResume,onClose,onSubmitted,onPossibleSubmit,max,clock});this.sessions=new Map()}
 full(){return this.sessions.size>=this.max}
 async hold(job,context,page){
  if(this.sessions.has(job.id))return;
  if(this.full())throw Error('All live-browser slots are occupied');
  let initial='';for(const frame of page.frames())initial+='\n'+await frame.locator('body').innerText({timeout:1500}).catch(()=>'');
  const session={job,context,page,created:this.clock(),touched:this.clock(),busy:false,initialReceipt:receipt.test(initial),chooser:null};
  const attach=p=>p.on?.('filechooser',chooser=>{session.chooser=chooser});context.pages().forEach(attach);context.on?.('page',attach);
  this.sessions.set(job.id,session);
 }
 async expire(){for(const [id,s] of this.sessions)if(!s.busy&&(this.clock()-s.touched>15*60*1000||this.clock()-s.created>45*60*1000)){this.sessions.delete(id);await s.context.close().catch(()=>{});this.onClose(s.job,'Live browser expired. Saved answers remain; reopen to restart the form.')}}
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
    const possible=await p.evaluate(({x,y})=>{const e=document.elementFromPoint(x,y)?.closest('button,input[type=submit],[role=button]');return !!e&&(/submit|send application/i.test(e.innerText||e.value||e.getAttribute('aria-label')||'')||(e.type==='submit'&&!/next|continue|sign.?in|log.?in/i.test(e.innerText||e.value||'')))},{x:data.x,y:data.y});
    if(possible)this.onPossibleSubmit(s.job);
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
    if(!['Tab','Shift+Tab','Enter','Backspace','Delete','ArrowDown','ArrowUp','Escape','ControlOrMeta+A','Space'].includes(data.key))throw Error('Unsupported key');
    if(data.key==='Enter')this.onPossibleSubmit(s.job);
    await p.keyboard.press(data.key);s.touched=this.clock();
   }else if(action==='scroll'){
    if(!Number.isFinite(data.y)||Math.abs(data.y)>1000)throw Error('Invalid scroll');await p.mouse.wheel(0,data.y);s.touched=this.clock();
   }else if(action!=='view')throw Error('Unsupported browser action');
   let content='';for(const frame of p.frames())content+='\n'+await frame.locator('body').innerText({timeout:1500}).catch(()=>'');
   if(!s.initialReceipt&&receipt.test(content)){this.onSubmitted(s.job);this.sessions.delete(id);await s.context.close();return {submitted:true}}
   const image=await p.screenshot({type:'jpeg',quality:65,timeout:10000});
   const url=new URL(p.url());return {image:image.toString('base64'),width:1100,height:800,host:url.hostname,uploadRequested:!!s.chooser,expiresAt:Math.min(s.touched+15*60*1000,s.created+45*60*1000)};
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
