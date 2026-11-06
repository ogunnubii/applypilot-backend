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
 const minimumAnnualCAD=value.minimumAnnualCAD==null?null:Number(value.minimumAnnualCAD);
 if(minimumAnnualCAD!==null&&(!Number.isInteger(minimumAnnualCAD)||minimumAnnualCAD<0||minimumAnnualCAD>10000000))throw Error('minimumAnnualCAD must be a whole CAD amount');
 const authorizedCountries=strings(value.authorizedCountries||[],'Authorized countries').map(x=>x.toLowerCase());
 // Outside Canada the applicant needs a visa: such roles qualify only when the
 // posting explicitly offers sponsorship for its own country. foreignWorkplaces
 // limits which arrangements abroad are acceptable (default: remote only).
 const foreignWorkplaces=value.foreignWorkplaces===undefined?['remote']:value.foreignWorkplaces;
 if(!Array.isArray(foreignWorkplaces)||!foreignWorkplaces.length||foreignWorkplaces.some(w=>!['remote','hybrid','on-site'].includes(w)))throw Error('foreignWorkplaces must list remote, hybrid and/or on-site');
 if(!localPlaces.length&&!remotePlaces.length&&!value.remoteWorldwide)throw Error('Specify an on-site or remote location');
 if(value.remoteFromCountry!=='canada')throw Error('Structured eligibility currently supports remoteFromCountry: canada');
 return {version:1,roles,aliases,localPlaces,remotePlaces,remoteWorldwide:value.remoteWorldwide===true,remoteFromCountry:'canada',authorizedCountries,includeRelatedRoles:value.includeRelatedRoles===true,preferBusinessContract:value.preferBusinessContract===true,allowEmploymentFallback:value.allowEmploymentFallback===true,preferRemote:value.preferRemote===true,preferSponsorship:value.preferSponsorship===true,...(value.foreignSponsorship===true?{foreignSponsorship:true,foreignWorkplaces:[...new Set(foreignWorkplaces)]}:{}),...(minimumAnnualCAD!==null?{minimumAnnualCAD}:{})};
}
export function scopeIntent(scope){
 return {scope,roles:[...new Set([...scope.roles,...scope.aliases].map(x=>x.toLowerCase()))],localPlaces:scope.localPlaces,places:scope.localPlaces,remotePlaces:scope.remotePlaces,remoteAny:scope.remoteWorldwide,remote:!scope.localPlaces.length,worldwideEligibility:true};
}
const ontario=/\b(?:ontario|toronto|gta|greater toronto|york region|north york|scarborough|etobicoke|markham|aurora|richmond hill|vaughan|thornhill|concord|maple|woodbridge|newmarket|stouffville|mississauga|brampton|oakville|burlington|pickering|ajax|whitby|oshawa|milton|caledon|ottawa|waterloo|kitchener|hamilton|guelph|barrie|kingston|london,? (?:on|canada))\b/i;
export function ontarioLocation(location){
 const text=String(location||'');
 if(/\b(?:United States|USA|California|Oregon|Ohio|New York|United Kingdom|England|Australia)\b|\bOntario\s*,\s*(?:CA|OR)\b/i.test(text))return false;
 return ontario.test(text)||/\bLondon\s*,\s*ON\b/i.test(text);
}
// A posting is remote only when nothing in it requires office attendance or
// travel. "Remote-Friendly (Travel-Required)" with "in one of our offices at
// least 25% of the time" is not a remote role.
export function remoteContradiction(job){
 const location=String(job.location||''),text=String(job.description||'').replace(/<[^>]*>/g,' ');
 const both=location+' \n '+text;
 if(/\bhybrid\b|\bon[- ]site\b|\bin[- ]office\b|\bin[- ]person\b/i.test(location))return 'The listed location is hybrid or on-site';
 if(/\btravel[- ]required\b|\btravel (?:is )?(?:required|mandatory|expected)\b|\b(?:must|required to|need to|expected to)\s+(?:be\s+(?:able|willing)\s+to\s+)?travel\b|\b(?:requires|required)\s+(?:\w+\s+){0,2}travel\b|\btravel\s+(?:up\s+to\s+)?\d{1,3}\s?%/i.test(both))return 'The posting requires travel';
 if(/\boffices?\b[^.!?\n]{0,90}\b\d{1,3}\s?%|\b\d{1,3}\s?%[^.!?\n]{0,90}\b(?:offices?|on[- ]site|in[- ]person)\b|\b(?:in[- ]office|office|on[- ]site)\s+(?:attendance|presence|days?)\s+(?:is\s+|are\s+)?(?:required|expected|mandatory)\b|\b(?:\w+\s+)?days?\s+(?:a|per)\s+week\s+(?:in|at)\s+(?:the|our|an)\s+office\b|\bhybrid\s+(?:work|role|position|schedule|attendance|policy|model|arrangement)\b|\b(?:must|required to|expected to)\s+(?:work|attend|be)\s+(?:on[- ]site|in[- ]office|in (?:the|our|one of our) offices?)/i.test(text))return 'The posting requires office attendance';
 return '';
}
export function isScopeRemote(job){
 const location=String(job.location||'');
 return (job.remote===true||/\bremote\b|home[- ]based/i.test(location))&&!remoteContradiction(job);
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
// Remote-first is the leading preference; business contracts lead within each
// work arrangement. Preferences never create eligibility evidence.
export function scopePriority(scope,eligibility,job){
 const remote=isScopeRemote(job);
 return (scope.preferRemote&&!remote?100:0)+(scope.preferBusinessContract&&eligibility.kind!=='business-contract'?10:0)+(scope.preferSponsorship&&!eligibility.sponsorshipAvailable&&eligibility.kind!=='sponsorship'?1:0);
}

// Update ranking alone. Do not enable a search, broaden eligibility, alter
// applicant facts, or touch application attempts and receipt protection.
export function setSearchRemotePreference(db,userId,searchId,input){
 const saved=db.prepare('SELECT scope_json FROM searches WHERE id=? AND user_id=?').get(searchId,userId);
 if(!saved)return null;
 const keys=input&&typeof input==='object'&&!Array.isArray(input)?Object.keys(input):null;
 if(!keys?.length||keys.some(key=>!['preferRemote','foreignSponsorship','foreignWorkplaces'].includes(key))||'preferRemote' in input&&typeof input.preferRemote!=='boolean')throw Error('Provide only a true or false remote-first preference');
 if('foreignSponsorship' in input&&typeof input.foreignSponsorship!=='boolean')throw Error('foreignSponsorship must be true or false');
 if(!saved.scope_json)throw Error('This search needs a structured scope before its ranking can be changed');
 let scope=normalizeSearchScope(JSON.parse(saved.scope_json));
 if('preferRemote' in input)scope.preferRemote=input.preferRemote;
 // Sponsored roles abroad: re-normalized so foreignWorkplaces is validated.
 if('foreignSponsorship' in input||'foreignWorkplaces' in input){
  const on=input.foreignSponsorship??scope.foreignSponsorship===true;
  scope=normalizeSearchScope({...scope,foreignSponsorship:on,foreignWorkplaces:input.foreignWorkplaces??scope.foreignWorkplaces});
 }
 db.prepare('UPDATE searches SET scope_json=? WHERE id=? AND user_id=?').run(JSON.stringify(scope),searchId,userId);
 return {scope};
}

// Structured searches do not equate a foreign remote contract with permission
// to perform that work from Canada, or a sponsorship preference with an offer.
export function scopedWorkEligibility(job,scope){
 const result=scopedWorkEligibilityBase(job,scope);
 return result.eligible?payFloor(result,job,scope):result;
}
// Unknown or non-CAD pay is never converted or guessed; it stays unknown.
export function payFloor(result,job,scope){
 const floor=scope?.minimumAnnualCAD;if(!floor)return result;
 const cad=(Array.isArray(job.pay)?job.pay:[]).filter(p=>p&&p.currency==='CAD'&&Number(p.annualMax)>0);
 if(!cad.length)return {...result,payFloor:{minimumAnnualCAD:floor,status:'unknown'}};
 const best=Math.max(...cad.map(p=>Number(p.annualMax)));
 if(best<floor)return {eligible:false,reason:'Published pay is below the CAD '+floor.toLocaleString('en-CA')+' annual-equivalent minimum',payFloor:{minimumAnnualCAD:floor,status:'below',annualMax:best}};
 return {...result,payFloor:{minimumAnnualCAD:floor,status:'met',annualMax:best}};
}
function scopedWorkEligibilityBase(job,scope){
 const abroad=foreignSponsorshipEligibility(job,scope);if(abroad)return abroad;
 const contradiction=(job.remote===true||/\bremote\b/i.test(String(job.location||'')))?remoteContradiction(job):'';
 if(contradiction&&!scopeLocationAllowed(job,scope))return {eligible:false,reason:'Listed as remote, but '+contradiction.charAt(0).toLowerCase()+contradiction.slice(1)};
 if(!scopeLocationAllowed(job,scope))return {eligible:false,reason:'Posting is outside the configured on-site and remote locations'};
 const location=String(job.location||''),text=String(job.description||'').replace(/<[^>]*>/g,' ');
 const remote=isScopeRemote(job);
 if(!text.trim())return {eligible:false,reason:'Employer description is required to verify work eligibility'};
 const canada=ontarioLocation(location)||/\bcanada\b/i.test(location);
 const global=/\b(worldwide|anywhere|global)\b/i.test(location)||/\b(remote worldwide|worldwide remote|work (?:remotely )?from anywhere in the world)\b/i.test(text);
 // Posting locations outrank a company's generic remote-work benefits. A role
 // listed for DACH or the US/UK is not made Canada-eligible by a worldwide slogan.
 const namedForeignRegion=/\b(?:DACH|EMEA|APAC|Europe|European Union|Germany|Deutschland|Austria|Switzerland|United Kingdom|United States|USA|USEAST|USWEST|UK|France|Spain|Italy|Netherlands|Ireland|Poland|Portugal|India|Australia|New Zealand|Singapore|Japan|Brazil|Mexico|London|Berlin|Paris|Bangalore|Bengaluru|New York|San Francisco)\b/i.test(location);
 if(remote&&!canada&&namedForeignRegion&&!/\b(?:worldwide|anywhere|global)\b/i.test(location))return {eligible:false,reason:'The role lists locations outside Canada; a general worldwide-remote statement is insufficient'};
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

// The single country a posting is located in, when it names exactly one
// outside Canada. Multi-country, regional or unnamed locations stay unknown.
const FOREIGN_COUNTRIES=[['united states',{test:t=>/\b(?:USA?|U\.S\.(?:A\.)?)(?=\W|$)/.test(t)||/\b(?:united states|new york|san francisco|seattle|austin|boston|chicago|los angeles)\b/i.test(t)}],['united kingdom',/\b(?:united kingdom|UK|england|scotland|wales)\b|\b(?:london|manchester|edinburgh)\b/i],['germany',/\b(?:germany|deutschland|berlin|munich|hamburg|frankfurt)\b/i],['netherlands',/\b(?:netherlands|amsterdam|rotterdam)\b/i],['ireland',/\b(?:ireland|dublin)\b/i],['france',/\b(?:france|paris)\b/i],['australia',/\b(?:australia|sydney|melbourne)\b/i],['singapore',/\bsingapore\b/i],['japan',/\b(?:japan|tokyo)\b/i],['sweden',/\b(?:sweden|stockholm)\b/i],['denmark',/\b(?:denmark|copenhagen)\b/i],['switzerland',/\b(?:switzerland|zurich|geneva)\b/i],['spain',/\b(?:spain|madrid|barcelona)\b/i],['portugal',/\b(?:portugal|lisbon)\b/i],['poland',/\b(?:poland|warsaw)\b/i],['new zealand',/\b(?:new zealand|auckland)\b/i],['united arab emirates',/\b(?:united arab emirates|UAE|dubai)\b/i]];
export function postingCountry(location){
 const text=String(location||'');
 if(/\bcanada\b/i.test(text)||ontarioLocation(text))return 'canada';
 const found=FOREIGN_COUNTRIES.filter(([,pattern])=>pattern.test(text)).map(([name])=>name);
 return found.length===1&&!/\b(?:worldwide|anywhere|global|EMEA|APAC|LATAM|Europe|EU|DACH|Americas)\b/i.test(text)?found[0]:null;
}
// A role abroad qualifies only with an explicit sponsorship offer for that
// country and an acceptable workplace. Returns null when the rule does not
// apply (Canada, or the scope does not include sponsored roles abroad).
function foreignSponsorshipEligibility(job,scope){
 if(!scope?.foreignSponsorship)return null;
 const country=postingCountry(job.location);
 if(!country||country==='canada')return null;
 const text=String(job.description||'').replace(/<[^>]*>/g,' ');
 if(!text.trim())return {eligible:false,reason:'Employer description is required to verify visa sponsorship'};
 const workplace=isScopeRemote(job)?'remote':/\bhybrid\b/i.test(String(job.location||'')+' '+text.slice(0,4000))?'hybrid':'on-site';
 const evidence=workEligibility({...job,description:text});
 if(evidence.kind!=='sponsorship'||!evidence.eligible)return {eligible:false,country,reason:'Role is in '+country.replace(/\b\w/g,c=>c.toUpperCase())+' and the posting does not explicitly offer visa sponsorship'};
 if(!scope.foreignWorkplaces.includes(workplace))return {eligible:false,country,reason:'Sponsored role abroad is '+workplace+'; your scope accepts '+scope.foreignWorkplaces.join('/')+' roles abroad'};
 return {eligible:true,kind:'foreign-sponsorship',country,workplace,sponsorshipAvailable:true,reason:evidence.reason+' for '+(workplace==='on-site'?'an':'a')+' '+workplace+' role in '+country.replace(/\b\w/g,c=>c.toUpperCase())};
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
 // LinkedIn/Indeed postings are only known once the applicant's browser reads
 // the bound job page. Until then eligibility is unknown (never assumed);
 // afterwards the saved posting assessment decides. Submission still requires
 // a fresh eligible assessment (single-application reservation).
 if(globalThis.ApplyPilotPolicy?.nativeBoard?.(job.url||'')){
  if(!metadata.native)return null;
  if(!metadata.native.eligible)return {eligibility:{eligible:false,reason:metadata.native.blocker||'Posting outside the saved scope'},searchPriority:0};
 }
 const posting={...metadata,title:job.title};
 // Role fit is checked before work eligibility so a weak match never opens.
 const fit=roleFit(job.title||metadata.title,scope);
 if(!fit.fit)return {eligibility:{eligible:false,reason:'Weak role fit: '+fit.reason,roleFit:fit},searchPriority:0};
 const eligibility=scopedWorkEligibility(posting,scope);
 return {eligibility,searchPriority:scopePriority(scope,eligibility,posting)};
}

// Deterministic role fit against the saved scope roles. A title must name one
// of the roles (or, with includeRelatedRoles, the Cloud/DevOps/SRE/Platform
// family). Client-application engineering (mobile, desktop, macOS, ChromeOS,
// front-end) is not infrastructure work even when it says "platform".
const ROLE_SYNONYMS=[[/\bsre\b/g,'site reliability engineer'],[/\bdev\s*ops\b/g,'devops'],[/\bdevsecops\b/g,'devops security'],[/\binfra\b/g,'infrastructure'],[/\bk8s\b/g,'kubernetes'],[/\bswe\b/g,'software engineer']];
const roleKey=value=>ROLE_SYNONYMS.reduce((t,[pattern,to])=>t.replace(pattern,to),String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,' ')).replace(/\s+/g,' ').trim();
const ROLE_STOP=new Set(['senior','sr','staff','principal','lead','junior','jr','ii','iii','iv','i','the','of','and','a']);
const CLIENT_APP=/\b(?:mobile|client|desktop|ios|android|macos|mac os|chromeos|chrome os|windows app|frontend|front end|web app|ui|ux|design|game|graphics|firmware)\b/;
const INFRA_FAMILY=/\b(?:site reliability|devops|cloud|infrastructure|platform engineer(?:ing)?|reliability|kubernetes|production engineer(?:ing)?|systems engineer)\b/;
export function roleFit(title,scope){
 const t=roleKey(title);
 if(!t)return {fit:false,reason:'The job title is missing'};
 const roles=[...(scope?.roles||[]),...(scope?.aliases||[])].map(roleKey).filter(Boolean);
 const named=roles.find(role=>{const tokens=role.split(' ').filter(w=>!ROLE_STOP.has(w));return tokens.length&&tokens.every(w=>new RegExp('\\b'+w+'\\b').test(t));});
 const client=t.match(CLIENT_APP);
 if(client&&!/\b(?:site reliability|devops|cloud|infrastructure)\b/.test(t))return {fit:false,reason:'Client-application engineering role ('+client[0]+'), not '+(scope?.roles?.slice(0,4).join(' / ')||'your saved roles')};
 if(named)return {fit:true,reason:'Title matches '+named};
 if(scope?.includeRelatedRoles&&INFRA_FAMILY.test(t))return {fit:true,reason:'Related Cloud/DevOps/SRE/Platform role'};
 return {fit:false,reason:'Title does not match your saved roles ('+(scope?.roles?.slice(0,4).join(' / ')||'none saved')+')'};
}

export function searchScopeSignature(scope){return createHash('sha256').update(JSON.stringify(normalizeSearchScope(scope))).digest('hex');}

