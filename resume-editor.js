import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chromium} from 'playwright';

const run=promisify(execFile);
export const resumeDigest=bytes=>createHash('sha256').update(bytes).digest('hex');
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function resumeHTML(input){
 if(typeof input!=='string'||input.trim().length<200||input.length>18000)throw Error('Enter 200–18,000 characters of resume text.');
 const pages=input.trim().split(/^\s*---\s*$/m);
 if(pages.length>3)throw Error('Use at most three resume pages.');
 const sections=pages.map((page,index)=>{
  const lines=page.trim().split(/\r?\n/),out=[];let list=false;
  const close=()=>{if(list){out.push('</ul>');list=false;}};
  for(const raw of lines){
   const line=raw.trim();if(!line){close();continue;}
   if(/^[-•]\s+/.test(line)){if(!list){out.push('<ul>');list=true;}out.push('<li>'+escape(line.replace(/^[-•]\s+/,''))+'</li>');continue;}
   close();
   if(/^# /.test(line))out.push('<h1>'+escape(line.slice(2))+'</h1>');
   else if(/^## /.test(line))out.push('<h2>'+escape(line.slice(3))+'</h2>');
   else if(/^### /.test(line))out.push('<h3>'+escape(line.slice(4))+'</h3>');
   else out.push('<p>'+escape(line)+'</p>');
  }
  close();return '<section class="sheet" aria-label="Resume page '+(index+1)+'">'+out.join('\n')+'</section>';
 });
 return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>Resume</title><style>@page{size:Letter;margin:0}*{box-sizing:border-box}body{margin:0;background:#fff;color:#111;font:10.5pt/1.28 Arial,sans-serif}.sheet{width:8.5in;height:11in;padding:.58in .65in;break-after:page;overflow:hidden}.sheet:last-child{break-after:auto}h1{font-size:21pt;line-height:1.12;margin:0 0 5pt;font-weight:700;color:#000}h2{font-size:11pt;line-height:1.2;margin:14pt 0 5pt;font-weight:700;color:#000}h3{font-size:10.7pt;line-height:1.25;margin:9pt 0 3pt;font-weight:700;color:#000}p{margin:0 0 5pt}ul{margin:4pt 0 8pt;padding-left:14pt}li{margin:0 0 4pt}h1+p{font-weight:700;font-size:11pt}h1+p+p{font-size:9.2pt;color:#333}</style></head><body>'+sections.join('')+'</body></html>';
}
export async function renderResume(input){
 const html=resumeHTML(input),directory=await mkdtemp(join(tmpdir(),'applypilot-resume-'));let browser;
 try{
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:816,height:1056}});
  await page.route('**/*',route=>route.abort());
  await page.setContent(html,{waitUntil:'load',timeout:15000});
  const overflow=await page.locator('.sheet').evaluateAll(nodes=>nodes.some(n=>n.scrollHeight>n.clientHeight+1));
  if(overflow)throw Error('A resume page is too long. Shorten it or insert --- on its own line to start another page.');
  const pdf=await page.pdf({format:'Letter',printBackground:true,preferCSSPageSize:true});
  const file=join(directory,'resume.pdf');await writeFile(file,pdf,{mode:0o600});
  const {stdout:extracted}=await run('pdftotext',['-layout',file,'-'],{timeout:15000,maxBuffer:300000});
  if(extracted.trim().length<150)throw Error('The generated resume did not contain readable text.');
  const images=[];
  for(let n=1;n<=input.trim().split(/^\s*---\s*$/m).length;n++){
   const prefix=join(directory,'page-'+n);
   await run('pdftoppm',['-f',String(n),'-singlefile','-scale-to',1320,'-png',file,prefix],{timeout:15000,maxBuffer:300000});
   images.push((await readFile(prefix+'.png')).toString('base64'));
  }
  return {pdf,text:extracted,images};
 }finally{await browser?.close();await rm(directory,{recursive:true,force:true});}
}
const previews=new Map();let rendering=0;
function purge(){for(const [id,p]of previews)if(p.expires<Date.now())previews.delete(id);}
export function installResumeEditor(db){db.exec('CREATE TABLE IF NOT EXISTS resume_previous(applicant_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,path TEXT NOT NULL,saved_at TEXT NOT NULL)');}
export async function prepareResumeEdit(db,uid,id,input,{render=renderResume,read=readFile}={}){
 const applicant=db.prepare('SELECT name,resume_path FROM applicants WHERE id=? AND user_id=?').get(id,uid);
 if(!applicant)throw Error('Applicant not found');
 if(typeof input!=='string')throw Error('Resume text is required');
 purge();if(rendering>=2)throw Error('Resume preview is busy. Try again shortly.');
 rendering++;
 try{
  const expectedPath=applicant.resume_path||null,expectedSha=expectedPath?resumeDigest(await read(expectedPath)):null;
  const result=await render(input);
  for(const [key,p]of previews)if(p.uid===uid&&p.applicantId===id)previews.delete(key);
  if(previews.size>=20)throw Error('Resume preview is busy. Try again shortly.');
  const draftId=randomUUID();
  const name=(applicant.name||'Applicant').replace(/[^a-z0-9 -]/gi,'').trim().replace(/\s+/g,'_')+'_Resume.pdf';
  previews.set(draftId,{uid,applicantId:id,expectedPath,expectedSha,pdf:result.pdf,name,expires:Date.now()+15*60000});
  return {draftId,name,pages:result.images,text:result.text,bytes:result.pdf.length};
 }finally{rendering--;}
}
export async function saveResumeEdit(db,uid,id,draftId,uploadDir,{read=readFile,write=writeFile,makeDir=mkdir}={}){
 purge();const draft=previews.get(draftId);
 if(!draft||draft.uid!==uid||draft.applicantId!==id)throw Error('Preview expired. Preview this resume again before saving.');
 const current=db.prepare('SELECT resume_path FROM applicants WHERE id=? AND user_id=?').get(id,uid);
 if(!current||current.resume_path!==draft.expectedPath||(current.resume_path&&resumeDigest(await read(current.resume_path))!==draft.expectedSha))throw Error('Your current resume changed. Open it and preview your revision again.');
 await makeDir(uploadDir,{recursive:true,mode:0o700});const file=join(uploadDir,randomUUID()+'.pdf');
 await write(file,draft.pdf,{mode:0o600});
 db.exec('BEGIN IMMEDIATE');
 try{
  const fresh=db.prepare('SELECT resume_path FROM applicants WHERE id=? AND user_id=?').get(id,uid);
  if(!fresh||fresh.resume_path!==draft.expectedPath)throw Error('Your current resume changed. Preview again.');
  if(fresh.resume_path)db.prepare('INSERT INTO resume_previous(applicant_id,user_id,path,saved_at) VALUES(?,?,?,?) ON CONFLICT(applicant_id) DO UPDATE SET user_id=excluded.user_id,path=excluded.path,saved_at=excluded.saved_at').run(id,uid,fresh.resume_path,new Date().toISOString());
  db.prepare('UPDATE applicants SET resume_path=? WHERE id=? AND user_id=?').run(file,id,uid);
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}
 previews.delete(draftId);
 return {ok:true,name:draft.name,bytes:draft.pdf.length,previousSaved:!!draft.expectedPath};
}
export function previousResumePath(db,uid,id){return db.prepare('SELECT path FROM resume_previous WHERE applicant_id=? AND user_id=?').get(id,uid)?.path||null;}
