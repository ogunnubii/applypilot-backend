import {createHash} from 'node:crypto';
import {workEligibility} from './work-eligibility.js';
// Explicit discovery constraints, separate from ranking preferences. No applicant
// facts are inferred from a request to prioritize sponsorship or contract work.
export const MAX_SEARCH_INSTRUCTION=100000;
export function searchInstruction(value){
 const text=String(value||'').trim();
 if(text.length>MAX_SEARCH_INSTRUCTION)throw Error('Search instructions must be at most 100000 characters; nothing was saved');
 return text;
}
export function normalizeSearchScope(value){
 if(value==null)return null;
 if(typeof value!=='object'||Array.isArray(value))throw Error('Search scope must be an object');
 const strings=(items,label)=>{
  if(!Array.isArray(items)||items.some(x=>typeof x!=='string'||!x.trim()))throw Error(label+' must be a list of nonempty strings');
  if(items.length>2000||items.some(x=>x.length>300))throw Error(label+' exceeds the supported size; nothing was saved');
  return [...new Map(items.map(x=>[x.trim().replace(/\s+/g,' ').toLowerCase(),x.trim().replace(/\s+/g,' ')])).values()];
 };
 const roles=strings(value.roles,'Roles'),aliases=strings(value.aliases||[],'Title aliases');if(!roles.length)throw Error('Include at least one role');
 const localPlaces=strings(value.localPlaces||[],'On-site locations').map(x=>x.toLowerCase());
 const remotePlaces=strings(value.remotePlaces||[],'Remote locations').map(x=>x.toLowerCase());
 const authorizedCountries=strings(value.authorizedCountries||[],'Authorized countries').map(x=>x.toLowerCase());
 if(!localPlaces.length&&!remotePlaces.length&&!value.remoteWorldwide)throw Error('Specify an on-site or remote location');
 if(value.remoteFromCountry!=='canada')throw Error('Structured eligibility currently supports remoteFromCountry: canada');
 return {version:1,roles,aliases,localPlaces,remotePlaces,remoteWorldwide:value.remoteWorldwide===true,remoteFromCountry:'canada',authorizedCountries,includeRelatedRoles:value.includeRelatedRoles===true,preferBusinessContract:value.preferBusinessContract===true,allowEmploymentFallback:value.allowEmploymentFallback===true,preferRemote:value.preferRemote===true,preferSponsorship:value.preferSponsorship===true};
}
export function scopeIntent(scope){
 return {scope,roles:[...new Set([...scope.roles,...scope.aliases].map(x=>x.toLowerCase()))],localPlaces:scope.localPlaces,places:scope.localPlaces,remotePlaces:scope.remotePlaces,remoteAny:scope.remoteWorldwide,remote:!scope.localPlaces.length,worldwideEligibility:true};
}
const ontario=/\b(?:ontario|toronto|gta|greater toronto|york region|north york|scarborough|etobicoke|markham|aurora|richmond hill|vaughan|newmarket|stouffville|mississauga|brampton|oakville|burlington|pickering|ajax|whitby|oshawa|milton|caledon|ottawa|waterloo|kitchener|hamilton|guelph|barrie|kingston|london,? (?:on|canada))\b/i;
export function ontarioLocation(location){
 const text=String(location||'');
 if(/\b(?:United States|USA|California|Oregon|Ohio|New York|United Kingdom|England|Australia)\b|\bOntario\s*,\s*(?:CA|OR)\b/i.test(text))return false;
 return ontario.test(text)||/\bLondon\s*,\s*ON\b/i.test(text);
}
export function isScopeRemote(job){
 const location=String(job.location||''),description=String(job.description||'');
 return (job.remote===true||/\bremote\b|home[- ]based/i.test(location))&&!/\bhybrid\b|\bon[- ]site\b/i.test(location)&&! /\bhybrid\s+(?:work|role|position|schedule|attendance)|\b(?:must|required to|expected to)\s+(?:work|attend|be)\s+(?:on[- ]site|in[- ]office)/i.test(description);
}
export function scopeLocationAllowed(job,scope){
 const location=String(job.location||'');
 const remote=isScopeRemote(job);
 const matches=place=>place==='ontario'?ontarioLocation(location):new RegExp('\\b'+place.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','i').test(location);
 if(!remote)return scope.localPlaces.some(matches);
 return scope.remoteWorldwide||scope.remotePlaces.some(matches)||/\bworldwide|anywhere|global\b/i.test(location);
}
export function searchPriority(job){
 let metadata=job.metadata;try{metadata ||= JSON.parse(job.job_metadata_json||'{}')}catch{}
 return Number(metadata?.searchPriority)||0;
}
// Ranking is lexicographic: contract preference outranks remote/sponsorship
// bonuses and fit/diversity. It never creates eligibility evidence.
export function scopePriority(scope,eligibility,job){
 const remote=isScopeRemote(job);
 return (scope.preferBusinessContract&&eligibility.kind!=='business-contract'?100:0)+(scope.preferRemote&&!remote?10:0)+(scope.preferSponsorship&&!eligibility.sponsorshipAvailable&&eligibility.kind!=='sponsorship'?1:0);
}

// Structured searches do not equate a foreign remote contract with permission
// to perform that work from Canada, or a sponsorship preference with an offer.
export function scopedWorkEligibility(job,scope){
 if(!scopeLocationAllowed(job,scope))return {eligible:false,reason:'Posting is outside the configured on-site and remote locations'};
 const location=String(job.location||''),text=String(job.description||'').replace(/<[^>]*>/g,' ');
 const remote=isScopeRemote(job);
 if(!text.trim())return {eligible:false,reason:'Employer description is required to verify work eligibility'};
 const canada=ontarioLocation(location)||/\bcanada\b/i.test(location);
 const global=/\b(worldwide|anywhere|global)\b/i.test(location)||/\b(remote worldwide|worldwide remote|work (?:remotely )?from anywhere(?: in the world)?)\b/i.test(text);
 const restriction=/\banywhere\s+in\s+(?:the\s+)?(?:US|USA|United States|UK|United Kingdom|Europe)\b|\b(?:US|USA|United States|UK|EU|Europe)[ -]only\b|\b(?:must|need to)\s+(?:be\s+)?(?:based|reside|located|live)\s+in\s+(?!Canada\b)|\b(?:only|restricted to|limited to)\s+(?:the\s+)?(?:US|USA|United States|UK|EU|Europe)\b|\b(?:excluding|except|not available in)\s+Canada\b/i.test(location+' '+text);
 const foreignAuthorization=/\b(?:must|need to|required to)\s+(?:already\s+)?(?:be\s+)?(?:legally\s+)?(?:authorized|eligible)\s+to\s+work\s+in\s+(?:the\s+)?(?:US|USA|U\.S\.?|United States|UK|United Kingdom)(?=\W|$)|\b(?:US|United States)\s+work\s+authorization\s+(?:is\s+)?required/i.test(text);
 if(foreignAuthorization)return {eligible:false,restriction:'foreign-work-authorization',reason:'Posting requires foreign work authorization; Canadian authorization is insufficient'};
 if(restriction||remote&&!canada&&!global)return {eligible:false,reason:'Remote posting does not establish permission to work from Canada'};
 if(!scope.authorizedCountries.includes('canada'))return {eligible:false,reason:'Canadian work authorization has not been explicitly configured; applicant review required'};
 const sponsorshipAvailable=/\b(?:we (?:offer|provide|support) (?:work )?visa sponsorship|visa sponsorship (?:is )?(?:available|provided|offered|supported))\b/i.test(text)&&! /\b(?:no|without) (?:visa )?sponsorship|sponsorship (?:is )?(?:not|unavailable)|(?:cannot|will not|do not) sponsor/i.test(text)&&! /sponsorship[^.!?]{0,40}\b(?:Germany|France|United States|UK|United Kingdom|Australia|India)\b/i.test(text);
 const evidence={...workEligibility(job),sponsorshipAvailable};
 if(evidence.eligible&&evidence.kind==='business-contract')return evidence;
 // Never override hard citizenship restrictions with an employee fallback.
 if(/citizenship/.test(evidence.reason))return evidence;
 if(!scope.allowEmploymentFallback)return {eligible:false,reason:'No explicit incorporated / C2C / B2B engagement; employee fallback is disabled'};
 if(evidence.eligible&&evidence.kind==='sponsorship')return evidence;
 if(canada||remote&&global)return {eligible:true,kind:'canada-employment-fallback',sponsorshipAvailable,reason:'Employee fallback in an allowed location with configured Canadian work authorization; employer-specific requirements still require truthful answers'};
 return {eligible:false,reason:'No compatible location and work authorization evidence'};
}

// Recheck a newly configured scope against pre-existing pending jobs without
// rewriting their receipts, attempts, status, or historical search metadata.
export function currentSearchScope(db,job){
 if(!db.prepare('PRAGMA table_info(searches)').all().some(c=>c.name==='scope_json'))return null;
 const search=db.prepare('SELECT scope_json FROM searches WHERE user_id=? AND applicant_id=? AND enabled=1 AND scope_json IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1').get(job.user_id,job.applicant_id);
 return search?normalizeSearchScope(JSON.parse(search.scope_json)):null;
}
export function currentScopeAssessment(db,job){
 const scope=currentSearchScope(db,job);if(!scope)return null;
 let metadata={};try{metadata=JSON.parse(job.job_metadata_json||'{}')}catch{}
 const posting={...metadata,title:job.title};
 const eligibility=scopedWorkEligibility(posting,scope);
 return {eligibility,searchPriority:scopePriority(scope,eligibility,posting)};
}

export function searchScopeSignature(scope){return createHash('sha256').update(JSON.stringify(normalizeSearchScope(scope))).digest('hex');}
