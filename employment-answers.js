// Employer eligibility questions use explicit applicant answers, never model
// inference, search preferences, nationality or an inferred immigration status.
const clean=value=>String(value??'').normalize('NFKC').replace(/[\u2013\u2014]/g,'-').replace(/[?*]+$/g,'').replace(/\s+/g,' ').trim().toLowerCase();
export const EMPLOYMENT_KEYS={availability:'Available to start',canadaAuthorization:'Work authorization - Canada',canadaSponsorship:'Visa sponsorship now or in future - Canada',over18:'Over 18 - applicant confirmed'};
const yesNo=value=>/^(yes|no)$/i.test(String(value||'').trim())?String(value).trim().toLowerCase()==='yes'?'Yes':'No':null;
function questionKind(value){
 const q=clean(value);
 if(/^are you (?:over (?:the age of )?(?:18|eighteen)(?: years old| years of age)?|at least (?:18|eighteen)(?: years old| years of age)?)$/.test(q))return 'adult';
 if(/^(?:when (?:can|could) you start(?: a new role| work| employment)?|(?:what is your )?(?:earliest start date|availability to start|available to start|notice period))$/.test(q))return 'availability';
 const where='(?:canada|the country (?:where|in which) (?:the|this) (?:job|role|position) is located|this country)';
 if(new RegExp('^are you (?:legally )?(?:authori[sz]ed|eligible|permitted) to work in '+where+'$').test(q))return 'authorization';
 if(new RegExp('^(?:will you now or in the future|do you(?: now or in the future)?) require sponsorship(?: for (?:an? )?(?:employment )?visa(?: status)?)?(?: in '+where+')?$').test(q))return 'sponsorship';
 return null;
}
function canadaJob(job){
 let m;try{m=JSON.parse(job?.job_metadata_json||'{}');}catch{return false;}
 const location=String(m.location||'');
 // Multi-country/global roles do not establish the country of employment.
 if(/\b(?:united states|us|usa|u\.s\.|uk|united kingdom|france|germany|india|australia|worldwide|global|anywhere|europe)\b|\bOntario\s*,\s*(?:CA|OR)\b/i.test(location))return false;
 return /\b(?:canada|ontario|british columbia|alberta|quebec|nova scotia|new brunswick|manitoba|saskatchewan|newfoundland|prince edward island)\b/i.test(location)||clean(m.country)==='canada'&&!location.includes('/');
}
export function employmentContext(profile,job){
 let saved={},application={};try{saved=JSON.parse(profile?.answers_json||'{}');application=JSON.parse(job?.answers_json||'{}');}catch{}
 return {canada:canadaJob(job),facts:Object.fromEntries(Object.values(EMPLOYMENT_KEYS).filter(k=>typeof saved[k]==='string').map(k=>[k,saved[k]])),application};
}
export function approvedEmploymentAnswer(field,profile){
 const context=profile?.employment_context;if(!context)return null;
 const question=field?.label||field?.ariaLabel||'',kind=questionKind(question);if(!kind)return null;
 // Field help can introduce a different country, attestation or time scope.
 // Leave such compound statements for explicit review.
 if(String(field.description||'').trim())return null;
 const entries=Object.entries(context.application||{}).filter(([q])=>clean(q)===clean(question));
 if(new Set(entries.map(([,a])=>clean(a))).size>1)return null;
 const exact=entries.length?String(entries[0][1]).trim():null;
 if(kind==='adult'){
  // Only an explicit age-threshold answer is usable. No inference from dates,
  // degree, work history, consent checkboxes, or another age threshold.
  const answer=yesNo(exact??context.facts[EMPLOYMENT_KEYS.over18]);
  // Not over 18 does not establish whether someone is at least 18.
  if(!exact&&answer==='No'&&/at least/i.test(question))return null;
  return answer?{kind:'employment',answer}:null;
 }
 if(kind==='availability'){
  const value=exact??context.facts[EMPLOYMENT_KEYS.availability];
  // A notice period is a duration, not a date or the word Immediately.
  if(/notice period/i.test(question)&&!exact)return null;
  if(!value||value.length>120)return null;
  return {kind:'employment',answer:value};
 }
 // Even exact application answers require a clear country, so identical
 // wording copied from an old job cannot assert authorization elsewhere.
 if(!context.canada)return null;
 const key=kind==='authorization'?EMPLOYMENT_KEYS.canadaAuthorization:EMPLOYMENT_KEYS.canadaSponsorship;
 const answer=yesNo(exact??context.facts[key]);
 return answer?{kind:'employment',answer}:null;
}
