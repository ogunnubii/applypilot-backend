import {request} from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP,BlockList} from 'node:net';
import {canonicalJobURL} from './form-policy.js';
import {supported} from './local-policy.js';
import {plainJobText} from './draft-job-context.js';

const denied=new BlockList();
for(const [base,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.168.0.0',16],['192.0.0.0',24],['192.0.2.0',24],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]])denied.addSubnet(base,bits,'ipv4');
function safePublicURL(value){
 const u=new URL(value);
 if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443'||isIP(u.hostname.replace(/^\[|\]$/g,''))||!u.hostname.includes('.')||/\.(?:local|localhost|internal|test|invalid)$/i.test(u.hostname))throw Error('Use a public HTTPS employer job link.');
 for(const name of u.searchParams.keys())if(/^(?:password|passwd|access_token|auth|authorization|api_key|secret|session|email)$/i.test(name))throw Error('Remove private sign-in information from the job link.');
 u.hash='';
 return u.toString();
}
export function safeFunnelURL(value){return canonicalJobURL(safePublicURL(value));}
export function parseFunnelLinks(input){
 if(typeof input!=='string'||input.length>1000000)throw Error('Paste up to 1,000 job links at a time.');
 const raw=input.match(/https?:\/\/[^\s<>"'\[\]]+/gi)||[];
 if(!raw.length)throw Error('Paste at least one HTTPS job link.');
 if(raw.length>1000)throw Error('Paste up to 1,000 job links at a time.');
 const links=[],rejected=[];let repeated=0;
 for(const value of raw){try{const url=safeFunnelURL(value.replace(/[),.;!?]+$/,''));if(links.includes(url))repeated++;else links.push(url);}catch(error){rejected.push({reason:error.message});}}
 return {links,rejected,repeated};
}
// Resolve and pin a public IPv4 address for every HTTPS hop. No cookies, bearer
// tokens, browser session, executable page scripts or private network access.
export async function readPublicJob(url,{resolveHost=lookup,requestImpl=request}={}){
 // Identity normalization is for duplicate checks, not HTTP requests. Some
 // employers redirect to a trailing slash; removing it on every hop loops.
 let target=safePublicURL(url);
 for(let hops=0;hops<5;hops++){
  const u=new URL(target),addresses=await resolveHost(u.hostname,{all:true,family:4});
  if(!addresses.length||addresses.some(a=>a.family!==4||denied.check(a.address,'ipv4')))throw Error('Job link does not resolve to a public address.');
  const data=await new Promise((resolve,reject)=>{
   const req=requestImpl(u,{method:'GET',headers:{accept:'text/html,application/json','user-agent':'ApplyPilot job-link reader'},lookup:(_host,options,cb)=>cb(null,options?.all?[{address:addresses[0].address,family:4}]:addresses[0].address,4)},res=>{
    const status=res.statusCode||0;
    if(status>=300&&status<400){res.resume();resolve({redirect:res.headers.location,status});return;}
    if(status!==200){res.resume();const error=Error('Employer page returned '+status);error.status=status;reject(error);return;}
    if(Number(res.headers['content-length']||0)>2000000){res.resume();reject(Error('Employer page is too large to read.'));return;}
    let length=0,chunks=[];res.on('data',chunk=>{length+=chunk.length;if(length>2000000){req.destroy(Error('Employer page is too large to read.'));return;}chunks.push(chunk);});res.on('error',reject);res.on('end',()=>resolve({html:Buffer.concat(chunks).toString('utf8'),url:target}));
   });req.setTimeout(12000,()=>req.destroy(Error('Employer page timed out.')));req.on('error',reject);req.end();
  });
  if(!data.redirect)return data;
  target=safePublicURL(new URL(data.redirect,target).toString());
 }
 throw Error('Too many employer-page redirects.');
}
export function jobFromHTML(html,url){
 const postings=[];
 const walk=(value,depth=0)=>{if(!value||depth>8)return;if(Array.isArray(value)){for(const entry of value.slice(0,300))walk(entry,depth+1);return;}if(typeof value!=='object')return;const type=value['@type'];if(type==='JobPosting'||Array.isArray(type)&&type.includes('JobPosting'))postings.push(value);if(value['@graph'])walk(value['@graph'],depth+1);};
 for(const m of String(html).matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){try{walk(JSON.parse(m[1]));}catch{}}
 if(postings.length!==1)return null;
 const p=postings[0];if(!p.title||!p.hiringOrganization?.name||!p.description)return null;
 const expires=Date.parse(p.validThrough);if(Number.isFinite(expires)&&expires<Date.now())return {closed:true};
 const locations=Array.isArray(p.jobLocation)?p.jobLocation:[p.jobLocation],countries=Array.isArray(p.applicantLocationRequirements)?p.applicantLocationRequirements:[p.applicantLocationRequirements];
 const location=locations.map(l=>[l?.address?.addressLocality,l?.address?.addressRegion,l?.address?.addressCountry?.name||l?.address?.addressCountry].filter(x=>typeof x==='string').join(', ')).filter(Boolean).join('; ')||countries.map(c=>c?.name).filter(Boolean).join(', ');
 const pay=p.baseSalary?.value;
 return {title:plainJobText(p.title),company:plainJobText(p.hiringOrganization.name),description:plainJobText(p.description),location,remote:p.jobLocationType==='TELECOMMUTE',employmentType:Array.isArray(p.employmentType)?p.employmentType.join(', '):p.employmentType,url,publishedAt:p.datePosted,salaryRange:pay?{min:pay.minValue||pay.value,max:pay.maxValue||pay.value,currency:p.baseSalary.currency,interval:pay.unitText}:undefined};
}
export function applicationLinks(html,url){
 const links=new Set();for(const m of String(html).matchAll(/(?:href|src)=["']([^"']+)["']/gi)){try{const target=safeFunnelURL(new URL(m[1].replaceAll('&amp;','&'),url).toString());if(supported(target)&&new URL(target).pathname.split('/').filter(Boolean).length>=2)links.add(target);}catch{}}
 return [...links];
}
