import {supportAssessment,supportRole} from './support-career.js';
import {technologyRole} from './tech-search.js';
// Deterministic matching: no model calls or Work credits.
const groups = [
 ['devops','dev ops','site reliability','sre','platform engineer','cloud engineer','cloud infrastructure','infrastructure engineer','cloud operations engineer','production engineer','build and release engineer','release engineer','ci cd engineer'],
 ['systems administrator','system administrator','sysadmin','systems engineer','system engineer','infrastructure administrator','noc engineer','network operations engineer'],
 ['application support engineer','technical support engineer','cloud support engineer','production support engineer','support engineer'],
 ['technical account manager','tam'], ['registered nurse','nurse','rn'],
 ['building operations','building operator','building superintendent']
];
const clean = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const phrase = (s,p) => (` ${s} `).includes(` ${p} `);
const roleGroup=value=>groups.find(group=>group.some(alias=>phrase(clean(value),alias)));
const advancedLevel=/\b(?:director|vice president|vp|head|manager|lead|senior|sr|staff|principal)\b/g;
const earlyCareer=/\b(?:intern|internship|student|co op|apprentice)\b/;
const occupationHead=/\b(?:engineer|administrator|manager|operator|specialist|analyst|nurse|accountant)\b/g;
const functionConflict=/\b(?:sales|marketing|product|business development|recruiter|recruiting|customer success)\b/g;
const qualificationConflict=/\b(?:aide|assistant|practitioner|orderly|educator)\b/g;
const tokens=(value,pattern)=>new Set([...clean(value).matchAll(pattern)].map(match=>match[0]==='sr'?'senior':match[0]));
function safeHeadAlias(requested,title){
 const group=roleGroup(requested);if(!group)return false;
 if(group.includes('devops'))return /\b(?:devops specialist|sre)\b/.test(title);
 if(group.includes('systems administrator'))return /\bsysadmin\b/.test(title);
 if(group.includes('technical account manager'))return /\btam\b/.test(title);
 if(group.includes('registered nurse'))return /^rn(?:\b|\s)/.test(title)||/\brn\b/.test(title);
 return false;
}
export function locationPriority(job){
 const location=clean(job.location);
 if(['york region','markham','aurora','richmond hill','vaughan','newmarket','king city','stouffville','east gwillimbury','georgina'].some(x=>phrase(location,x)))return 0;
 if(['toronto','north york','scarborough','etobicoke'].some(x=>phrase(location,x)))return 1;
 if(['gta','greater toronto','mississauga','brampton','oakville','burlington','pickering','ajax','whitby','oshawa','milton','caledon'].some(x=>phrase(location,x)))return 2;
 if(job.remote===true||phrase(location,'remote')||phrase(location,'home based'))return 3;
 if(['canada','ontario','vancouver','british columbia','montreal','quebec','ottawa','calgary','alberta','waterloo','winnipeg','halifax','edmonton','saskatchewan','manitoba','new brunswick','nova scotia','newfoundland'].some(x=>phrase(location,x)))return 4;
 return 5;
}
export function matches(job,intent){
 const title=clean(job.title), location=clean(job.location);
 const roleMatch=intent.supportCareer?supportRole(job.title):intent.broadTech?technologyRole(job.title):intent.roles.some(role=>{
  const r=clean(role);
  if(phrase(title,r)) return true;
  const group=roleGroup(r);return !!group&&group.some(x=>phrase(title,x));
 });
 if(!roleMatch)return false;
 if(intent.locationOrder==='york-toronto-gta-remote-canada-worldwide')return true;
 const remote=job.remote===true||phrase(location,'remote')||phrase(location,'home based');
 if(intent.remote && !remote)return false;
 const countries={
  canada:['canada','toronto','ontario','vancouver','british columbia','montreal','quebec','ottawa','calgary','alberta','waterloo','winnipeg','halifax'],
  'york region':['york region','markham','aurora','richmond hill','vaughan','newmarket','king city','stouffville','east gwillimbury','georgina'],
  'greater toronto':['greater toronto','gta','toronto','mississauga','brampton','oakville','burlington','pickering','ajax','whitby','oshawa','milton','caledon'],
  gta:['greater toronto','gta','toronto','mississauga','brampton','oakville','burlington','pickering','ajax','whitby','oshawa','milton','caledon'],
  usa:['usa','united states'],'united states':['usa','united states'],uk:['uk','united kingdom'],'united kingdom':['uk','united kingdom']
 };
 const placeMatches=place=>(countries[place]||[place]).some(value=>phrase(location,value));
 const global=/\b(?:anywhere|worldwide|global)\b/.test(location);
 const localPlaces=Array.isArray(intent.localPlaces)?intent.localPlaces:intent.places||[];
 const remotePlaces=Array.isArray(intent.remotePlaces)?intent.remotePlaces:[];
 if(remote){
  if(intent.remoteAny)return true;
  const allowed=remotePlaces.length?remotePlaces.some(placeMatches)||global:!localPlaces.length||localPlaces.some(placeMatches)||global;
  if(!allowed)return false;
 }else{
  if(localPlaces.length&&!localPlaces.some(placeMatches))return false;
  if(!localPlaces.length&&remotePlaces.length)return false;
 }
 return true;
}

// Discovery can retain a comparable title for review, while automatic
// submission requires a direct title/family match and a known-compatible
// location. Leadership and early-career variants are automatic only when the
// applicant explicitly requested that level.
export function matchAssessment(job,intent,profileFocus=''){
 const matched=matches(job,intent);if(!matched)return {matched:false,strong:false,score:0};
 if(intent.supportCareer)return {...supportAssessment(job),locationPriority:locationPriority(job)};
 const title=clean(job.title),requested=intent.roles.map(clean),profile=clean(profileFocus);
 if(intent.broadTech){const infrastructure=/devops|sre|site reliability|platform|infrastructure|cloud|sysadmin|systems|architecture|architect/.test(title),junior=/\b(?:intern|internship|graduate|junior)\b/.test(title);return {matched:true,strong:!junior,score:junior?55:infrastructure?96:84,locationPriority:locationPriority(job)};}
 const titleLevels=tokens(title,advancedLevel),titleHeads=tokens(title,occupationHead),titleFunctions=tokens(title,functionConflict),titleQualifications=tokens(title,qualificationConflict);
 const candidates=requested.map(role=>{
  const exact=!!role&&phrase(title,role),group=roleGroup(role),family=!!group&&group.some(alias=>phrase(title,alias));if(!exact&&!family)return null;
  const roleLevels=tokens(role,advancedLevel),roleHeads=tokens(role,occupationHead),roleFunctions=tokens(role,functionConflict),roleQualifications=tokens(role,qualificationConflict);
  const levelMismatch=[...titleLevels].some(level=>!roleLevels.has(level))||[...roleLevels].some(level=>!titleLevels.has(level))||earlyCareer.test(title)!==earlyCareer.test(role);
  const compatibleHead=[...titleHeads].some(head=>roleHeads.has(head))||safeHeadAlias(role,title);
  const functionMismatch=[...titleFunctions].some(token=>!roleFunctions.has(token));
  const qualificationMismatch=[...titleQualifications].some(token=>!roleQualifications.has(token));
  const blocked=levelMismatch||functionMismatch||qualificationMismatch;
  let score=exact?100:family&&compatibleHead?86:70;if(profile&&phrase(profile,role))score+=3;if(blocked)score-=25;
  return {score,strong:score>=80&&!blocked};
 }).filter(Boolean);
 const location=clean(job.location),priority=locationPriority(job);
 const global=/\b(?:worldwide|anywhere|global)\b/.test(location),canadian=/\b(?:canada|ontario|toronto|york region|markham|aurora|richmond hill|vaughan|newmarket|mississauga|brampton|ottawa|montreal|vancouver|calgary|waterloo)\b/.test(location);
 const locationStrong=intent.locationOrder?priority<3||priority===4||global||priority===3&&canadian:true;
 let score=Math.max(0,...candidates.map(candidate=>candidate.score));if(!locationStrong)score-=25;
 return {matched:true,strong:locationStrong&&candidates.some(candidate=>candidate.strong),score:Math.max(0,Math.min(100,score)),locationPriority:priority};
}
