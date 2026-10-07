// Search preferences, never claims about the applicant's experience.
export const SUPPORT_INSTRUCTION='Support career pathway: AI support engineer, technical support engineer, cloud support engineer, developer support engineer, product support engineer, technical account manager, implementation consultant; eligibility: worldwide sponsorship, remote from Canada, or B2B; Canada incorporated contracts only';
export const supportIntent=value=>/^Support career pathway:/i.test(String(value||''));
export const CANADA_SUPPORT_INSTRUCTION=SUPPORT_INSTRUCTION.split(';')[0]+'; remote Canada only; eligibility: incorporated / C2C / B2B contracts only';
export const remoteCanadaIntent=value=>/;\s*remote Canada only\s*(?:;|$)/i.test(String(value||''));
export const t4FallbackIntent=value=>/;\s*T4 fallback only\s*(?:;|$)/i.test(String(value||''));
export const CANADA_FALLBACK_INSTRUCTION=CANADA_SUPPORT_INSTRUCTION.replace('contracts only','contracts first')+'; T4 fallback only';
export function supportSearchInstruction(db,userId,applicantId){
 const rows=db.prepare('SELECT instruction FROM searches WHERE user_id=? AND applicant_id=? AND enabled=1 ORDER BY created_at DESC').all(userId,applicantId);
 return rows.map(r=>r.instruction).find(supportIntent)||SUPPORT_INSTRUCTION;
}
export function supportRole(title){
 const s=String(title||'');
 if(/\b(?:staff|principal|head|director|vp|lead|manager of|intern|internship|sales|hardware|field service)\b/i.test(s))return false;
 return /\b(?:(?:AI|cloud|technical|developer|product|application|IT|platform|customer|software)\s+support\s+(?:engineer|specialist|analyst)|support engineer|technical account manager|implementation (?:consultant|specialist|engineer)|technical customer (?:engineer|support))\b/i.test(s);
}
export function supportAssessment(job){
 const description=String(job.description||'').replace(/<[^>]*>/g,' '),title=job.title||'';
 const demands=[];
 if(/on[- ]call|24\s*\/\s*7|rotating shifts|weekend|overnight/i.test(description))demands.push('On-call or shift work mentioned');
 if(/high[- ]pressure|fast[- ]paced|urgent escalations|executive support/i.test(description+' '+title))demands.push('High-pressure or fast-paced work mentioned');
 if(/(?:advanced|expert|deep)\s+(?:knowledge of\s+|proficiency in\s+|experience with\s+)?(?:C\+\+|Java|Python|Kubernetes|distributed systems)|build.*production.*(?:software|code)|(?:5|6|7|8|10)\+?\s+years.*(?:software development|software engineering)/i.test(description))demands.push('Advanced engineering requirements');
 const pathway=/linux|cloud|API|logs?|troubleshoot|automation|containers?|kubernetes|infrastructure/i.test(description);
 const degree=/master|computer engineering|electrical engineering/i.test(description);
 return {matched:supportRole(title),strong:supportRole(title)&&!demands.includes('Advanced engineering requirements'),score:Math.max(0,92+(pathway?5:0)+(degree?3:0)-demands.length*14),demands,pathway,degreeRelevant:degree};
}
let rates={CAD:1},rateDate=null,lastFetch=0;
export async function refreshSalaryRates(){
 if(Date.now()-lastFetch<3600000)return;lastFetch=Date.now();
 try{const response=await fetch('https://www.bankofcanada.ca/valet/observations/FXUSDCAD,FXEURCAD,FXGBPCAD,FXAUDCAD/json?recent=1',{signal:AbortSignal.timeout(10000)});if(!response.ok)return;const row=(await response.json()).observations?.at(-1);if(!row||Date.now()-Date.parse(row.d)>7*86400000)return;const next={CAD:1};for(const currency of ['USD','EUR','GBP','AUD']){const value=Number(row['FX'+currency+'CAD']?.v);if(value>0&&value<10)next[currency]=value;}rates=next;rateDate=row.d;}catch{/* Unknown conversion keeps the role out of the automatic batch. */}
}
export function salaryTarget(pay,minimum=120000,fx=rates,date=rateDate){
 const ranges=(pay||[]).filter(p=>fx[p.currency]>0).map(p=>({...p,cadMin:Math.round(p.annualMin*fx[p.currency]),cadMax:Math.round(p.annualMax*fx[p.currency])}));
 const eligible=ranges.filter(p=>p.cadMax>=minimum).sort((a,b)=>b.cadMin-a.cadMin)[0];
 return {minimum,currency:'CAD',eligible:!!eligible,range:eligible||null,rateDate:date,reason:eligible?(eligible.cadMin>=minimum?'Published range meets target':'Target is within the published range; offer amount needs confirmation'):ranges.length?'Published range is below target':'Pay or currency conversion not verified'};
}
