import {supportAssessment,salaryTarget} from './support-career.js';
import {frenchApplication} from './language-policy.js';
import {matchAssessment} from './matching.js';
import {workEligibility} from './work-eligibility.js';
const plain=v=>String(v||'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
function interval(value){const s=String(value||'').toLowerCase();return /year|annual|annum/.test(s)?'year':/month/.test(s)?'month':/hour/.test(s)?'hour':/week/.test(s)?'week':/day/.test(s)?'day':'';}
function payRange(min,max,currency,period,source,label=''){
 min=Number(min);max=Number(max);currency=String(currency||'').toUpperCase();period=interval(period);
 if(!/^[A-Z]{3}$/.test(currency)||!period||!Number.isFinite(min)||!Number.isFinite(max)||min<=0||max<min||max>100000000)return null;
 const factors={year:1,month:12,week:52,day:260,hour:2080},assumptions={year:'',month:'12 months',week:'52 paid weeks',day:'260 paid days',hour:'2,080 paid hours'};
 return {min,max,currency,period,annualMin:Math.round(min*factors[period]),annualMax:Math.round(max*factors[period]),estimated:period!=='year',assumption:assumptions[period],source,label:plain(label).slice(0,160)};
}
export function compensation(job){
 const rows=[],add=x=>{if(x)rows.push(x);};
 const s=job.salaryRange;if(s)add(payRange(s.min,s.max,s.currency,s.interval,'Employer salary range'));
 const c=job.compensation||{};
 const tiers=c.compensationTiers||[];
 const parts=tiers.length?tiers.flatMap(t=>(t.components||[]).map(p=>({...p,tier:t.title}))):c.summaryComponents||[];
 for(const p of parts)if(String(p.compensationType).toLowerCase()==='salary')add(payRange(p.minValue,p.maxValue,p.currencyCode,p.interval,'Employer compensation',p.tier));
 for(const p of job.pay_input_ranges||[]){
  // Greenhouse has no interval property. Require an explicit period in the range or posting.
  const wording=plain([p.title,p.blurb,job.description].join(' '));
  const period=/\bannual(?:ized)?(?: salary| compensation| pay)?|\bper year|\bper annum|\byearly\b/i.test(wording)?'year':'';
  add(payRange(Number(p.min_cents)/100,Number(p.max_cents)/100,p.currency_type,period,'Employer pay transparency',p.title));
 }
 // Conservative text fallback: explicit currency + two amounts + period in the same salary sentence.
 if(!rows.length){
  const source=plain(job.salaryDescriptionPlain||job.description);
  const re=/\b(USD|CAD|GBP|EUR|AUD)\s*[$£€]?\s*([\d,]+(?:\.\d+)?)\s*(k)?\s*(?:-|–|—|to)\s*(?:(?:USD|CAD|GBP|EUR|AUD)\s*)?[$£€]?\s*([\d,]+(?:\.\d+)?)\s*(k)?\s*(?:per\s+|\/\s*)?(year|annum|annually|hour|month|week|day)\b/gi;
  for(const m of source.matchAll(re))add(payRange(Number(m[2].replaceAll(',',''))*(m[3]?1000:1),Number(m[4].replaceAll(',',''))*(m[5]?1000:1),m[1],m[6],'Explicit range in employer posting'));
 }
 return rows.filter((row,i)=>rows.findIndex(x=>x.min===row.min&&x.max===row.max&&x.currency===row.currency&&x.period===row.period&&x.label===row.label)===i).slice(0,12);
}
export function jobIntelligence(job,intent,focus='',date=Date.now()){
 const match=matchAssessment(job,intent,focus),eligibility=workEligibility(job,{incorporatedFromCanada:!!intent.supportCareer}),published=Date.parse(job.publishedAt||''),fresh=Number.isFinite(published)&&published<=date&&date-published<7*86400000;
 const remote=job.remote===true||/\bremote\b/i.test(job.location||''),preference=eligibility.eligible?(eligibility.kind==='worldwide-remote'?10:remote?8:6):0;
 const score=Math.max(0,Math.min(100,Math.round((match.score||0)*.85+preference+(fresh?5:0))));
 return {...(intent.supportCareer?{supportCareer:supportAssessment(job),salaryTarget:salaryTarget(compensation(job),intent.minimumCAD||120000)}:{}),version:2,description:plain(job.description).slice(0,24000),frenchApplication:frenchApplication(job),score,strong:!!match.strong,matched:!!match.matched,location:plain(job.location).slice(0,200),remote,employmentType:plain(job.employmentType).slice(0,80),eligibility,pay:compensation(job),publishedAt:Number.isFinite(published)?new Date(published).toISOString():null,checkedAt:new Date(date).toISOString(),available:true,reasons:[match.strong?'Strong role match':match.matched?'Related role match':'Outside current role preferences',eligibility.reason,...(fresh?['Published in the last 7 days']:[])],sourceUrl:job.url};
}
export function metadataFor(job){try{return JSON.parse(job.job_metadata_json||'{}')}catch{return {};}}
export function nextApplicationEligible(job){
 const m=metadataFor(job);
 return ['saved','queued'].includes(job.status)&&!job.local_attempt_at&&!Number(job.attempts||0)&&!job.challenge&&!job.handoff_available&&m.available===true&&m.strong===true&&m.eligibility?.eligible===true&&Date.now()-Date.parse(m.checkedAt||'')<86400000;
}
export function rankedJobs(jobs){
 return [...jobs].sort((a,b)=>(Number(b.match_score)||0)-(Number(a.match_score)||0)||String(b.created_at||'').localeCompare(String(a.created_at||''))||String(a.id).localeCompare(String(b.id)));
}
export function nextApplication(jobs){return rankedJobs(jobs).find(nextApplicationEligible)||null;}
