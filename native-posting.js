// LinkedIn and Indeed postings are assessed from what the applicant's own
// browser observed on the bound job page. Nothing here is a model output:
// eligibility uses the saved structured scope, pay uses explicitly posted
// amounts, and ordering signals cite the page text they came from. Ordering
// is a heuristic for which eligible job to try first; it is never presented
// as an interview, response or hiring probability.
import './local-policy.js';
import {scopeIntent,scopedWorkEligibility,isScopeRemote} from './search-scope.js';
import {matchAssessment} from './matching.js';
import {compensation} from './job-intelligence.js';

const P=globalThis.ApplyPilotPolicy;
export const NATIVE_ROLE_FAMILY=/\b(?:cloud|devops|dev\s*ops|devsecops|site reliability|sre|platform)\b/i;
const NATIVE_ROLE_EXCLUSION=/\b(?:sales|account (?:executive|manager)|business development|recruit(?:er|ing)|marketing|customer success|intern(?:ship)?|co-?op|student)\b/i;
const clip=(value,max)=>String(value??'').replace(/\s+/g,' ').trim().slice(0,max);

export function nativeSnapshot(input={}){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('A job-page snapshot is required.');
 const signals=Array.isArray(input.signals)?[...new Set(input.signals.filter(s=>typeof s==='string').map(s=>clip(s,160)).filter(Boolean))].slice(0,20):[];
 const workplace=['remote','hybrid','on-site'].includes(input.workplace)?input.workplace:'';
 return {url:String(input.url||''),title:clip(input.title,200),company:clip(input.company,200),location:clip(input.location,200),workplace,
  description:String(input.description||'').slice(0,24000),salaryText:clip(input.salaryText,200),postedText:clip(input.postedText,120),applicantsText:clip(input.applicantsText,120),signals,
  nativeApply:input.nativeApply===true,external:input.external===true};
}

// Posted amounts only. A bare "$" takes its currency from the posting's own
// country (and says so); otherwise the currency stays unknown.
export function nativePay(snapshot){
 const explicit=compensation({description:[snapshot.salaryText,snapshot.description].join('\n')});
 if(explicit.length)return explicit.map(p=>({...p,currencySource:'explicit'}));
 const text=snapshot.salaryText||'';
 const m=text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(k)?\s*(?:\/\s*(yr|year|hr|hour|mo|month))?\s*(?:-|–|—|to)\s*\$\s*([\d,]+(?:\.\d+)?)\s*(k)?\s*(?:\/\s*|\s+(?:a|an|per)\s+)(yr|year|hr|hour|mo|month|week|day)\b/i);
 if(!m)return [];
 const currency=/\bcanada\b|\b(?:ON|BC|AB|QC|MB|SK|NS|NB|NL|PE)\b,?\s*(?:canada)?$/i.test(snapshot.location)&&/\bcanada\b/i.test(snapshot.location)?'CAD':/\b(?:united states|usa)\b/i.test(snapshot.location)?'USD':'';
 const period={yr:'year',year:'year',hr:'hour',hour:'hour',mo:'month',month:'month',week:'week',day:'day'}[m[6].toLowerCase()];
 const factors={year:1,month:12,week:52,day:260,hour:2080};
 const min=Number(m[1].replaceAll(',',''))*(m[2]?1000:1),max=Number(m[4].replaceAll(',',''))*(m[5]?1000:1);
 if(!Number.isFinite(min)||!Number.isFinite(max)||min<=0||max<min)return [];
 return [{min,max,currency,period,annualMin:Math.round(min*factors[period]),annualMax:Math.round(max*factors[period]),estimated:period!=='year',currencySource:currency?'posting location':'unknown',source:'Posted pay on the job board',label:text.slice(0,160)}];
}

export function hiringSignals(snapshot,date=Date.now()){
 const signals=[];let postedDays=null,applicants=null;
 const posted=snapshot.postedText.toLowerCase();
 if(/\b(?:just posted|today|moments? ago)\b/.test(posted)||/\b\d+\s+(?:minute|hour)s?\s+ago\b/.test(posted))postedDays=0;
 else{const d=posted.match(/\b(\d+)\+?\s+(day|week|month)s?\s+ago\b/);if(d)postedDays=Number(d[1])*({day:1,week:7,month:30}[d[2]]);}
 if(postedDays!==null)signals.push({kind:'posted',value:postedDays,evidence:snapshot.postedText});
 const a=snapshot.applicantsText.match(/\b(?:over\s+)?(\d[\d,]*)\+?\s+(?:applicants|people clicked apply)\b/i);
 if(a){applicants=Number(a[1].replaceAll(',',''));signals.push({kind:'applicants',value:applicants,evidence:snapshot.applicantsText});}
 for(const s of snapshot.signals){
  if(/\bactively (?:recruiting|hiring)\b/i.test(s))signals.push({kind:'actively-recruiting',evidence:s});
  else if(/\burgently hiring\b/i.test(s))signals.push({kind:'urgently-hiring',evidence:s});
  else if(/\bhiring multiple\b/i.test(s))signals.push({kind:'multiple-openings',evidence:s});
  else if(/\b(?:be an early applicant|early applicant)\b/i.test(s))signals.push({kind:'early-applicant',evidence:s});
  else if(/\bresponds? (?:within|in)\b|\btypically responds\b/i.test(s))signals.push({kind:'response-time',evidence:s});
 }
 // Ordering points only; documented in README. Not a probability.
 let score=0;
 if(postedDays!==null)score+=postedDays<=1?30:postedDays<=7?20:postedDays<=14?10:postedDays<=30?3:0;
 if(applicants!==null)score+=applicants<25?20:applicants<100?10:0;
 for(const kind of ['actively-recruiting','urgently-hiring','multiple-openings','early-applicant','response-time'])if(signals.some(s=>s.kind===kind))score+={'actively-recruiting':10,'urgently-hiring':10,'multiple-openings':5,'early-applicant':5,'response-time':5}[kind];
 return {score,signals,checkedAt:new Date(date).toISOString()};
}

// Returns a complete, explainable assessment. `eligible` is true only when
// every requirement is positively evidenced; anything unknown is a blocker.
export function assessNativePosting(job,input,scope,{date=Date.now(),profileFocus=''}={}){
 const snapshot=nativeSnapshot(input),board=P.nativeBoard(job.url),reasons=[];
 const fail=reason=>({eligible:false,board,blocker:reason,reasons:[...reasons,reason],checkedAt:new Date(date).toISOString()});
 if(!board)return fail('Not a LinkedIn or Indeed job.');
 if(!P.sameApplication(snapshot.url,job.url))return fail('The open page is not the saved job.');
 if(snapshot.external||!snapshot.nativeApply)return fail(board==='linkedin'?'This LinkedIn job applies on the employer’s site, not Easy Apply. Add the employer’s direct application link instead.':'This Indeed job applies on the company site, not Indeed Apply. Add the employer’s direct application link instead.');
 if(!snapshot.title||!snapshot.company)return fail('The job title and company could not be read from the posting.');
 const same=(a,b)=>String(a||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()===String(b||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
 if(job.company&&!same(job.company,snapshot.company))return fail('The posting’s company does not match the saved job. Review this job before applying.');
 if(!NATIVE_ROLE_FAMILY.test(snapshot.title)||NATIVE_ROLE_EXCLUSION.test(snapshot.title))return fail('Outside the Cloud, DevOps, SRE and Platform role scope.');
 reasons.push('Cloud/DevOps/SRE/Platform title');
 const posting={title:snapshot.title,location:[snapshot.workplace==='remote'?'Remote':snapshot.workplace,snapshot.location].filter(Boolean).join(' · '),description:snapshot.description,remote:snapshot.workplace==='remote'};
 if(snapshot.workplace!=='remote'||!isScopeRemote(posting))return fail('Not listed as a remote position.');
 reasons.push('Listed as remote');
 if(!scope)return fail('Save and enable a structured search scope before applying on LinkedIn or Indeed.');
 const pay=nativePay(snapshot);posting.pay=pay;
 const eligibility=scopedWorkEligibility(posting,scope);
 if(!eligibility.eligible)return fail(eligibility.reason);
 reasons.push(eligibility.reason);
 const fit=matchAssessment(posting,scopeIntent(scope),profileFocus);
 const hiring=hiringSignals(snapshot,date);
 const known=pay.filter(p=>p.currency&&p.annualMax),best=known.sort((a,b)=>b.annualMax-a.annualMax)[0];
 return {eligible:true,board,blocker:null,reasons,eligibility,pay,fit:{score:fit.score||0,strong:!!fit.strong,matched:!!fit.matched},hiring,
  rank:{payAnnualMax:best?.annualMax||0,payCurrency:best?.currency||'',fit:fit.score||0,speed:hiring.score},
  title:snapshot.title,company:snapshot.company,location:posting.location,checkedAt:new Date(date).toISOString()};
}

// Pay first (only comparable within a currency; unknown pay ranks after known
// pay), then evidence-based fit, then hiring-speed signals.
export function compareNative(a,b){
 const x=a?.rank,y=b?.rank;if(!x||!y)return 0;
 if(x.payCurrency&&y.payCurrency&&x.payCurrency===y.payCurrency&&x.payAnnualMax!==y.payAnnualMax)return y.payAnnualMax-x.payAnnualMax;
 if(!!x.payAnnualMax!==!!y.payAnnualMax)return x.payAnnualMax?-1:1;
 return (y.fit-x.fit)||(y.speed-x.speed);
}
export const NATIVE_ASSESSMENT_MAX_AGE=24*60*60*1000;
export function freshNativeAssessment(metadata,date=Date.now()){
 const n=metadata?.native;return !!n&&n.eligible===true&&Number.isFinite(Date.parse(n.checkedAt))&&date-Date.parse(n.checkedAt)>=0&&date-Date.parse(n.checkedAt)<NATIVE_ASSESSMENT_MAX_AGE;
}
