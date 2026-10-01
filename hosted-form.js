import {fieldKind,knownAnswer,normalize,optionMatches,savedAnswer,sensitive} from './local-policy.js';

// Hosted automation is deliberately narrower than the answer library. These
// are stable contact/profile facts; employment eligibility, compensation and
// voluntary self-identification always remain human decisions.
const PROFILE_KINDS=new Set(['name','first','last','email','phone','location','city','region','country','postal','linkedin','github','school','degree','discipline']);
const CANONICAL={name:'Full name',first:'First name',last:'Last name',email:'Email address',phone:'Phone number',location:'Current location',city:'City',region:'Province / State',country:'Country',postal:'Postal code',linkedin:'LinkedIn',github:'GitHub',school:'School',degree:'Degree',discipline:'Field of study'};
const AUTOCOMPLETE={name:'name','given-name':'first','family-name':'last',email:'email',tel:'phone','address-level2':'city','address-level1':'region','postal-code':'postal','country-name':'country'};

function policyText(value){return String(value||'').normalize('NFKC').replace(/([a-z\d])([A-Z])/g,'$1 $2').replace(/[_/.*?\u2731:()-]+/g,' ').replace(/\s+/g,' ').trim();}
const THIRD_PARTY_CONTACT=/\b(?:emergency|alternate|secondary) contact\b|\b(?:reference|referee|recommender|supervisor|manager|recruiter|parent|guardian|spouse|partner|employer|company)(?:'s)?\b|\b(?:next of kin|contact (?:person|for another person))\b/i;
const GENERIC_QUESTION=/^(?:(?:please )?(?:select|choose)(?: one| an? option| one of the following)?(?: below)?|(?:please )?make a selection|selection|option|required field)$/i;

export function protectedHostedQuestion(value){
 const q=policyText(value);
 return sensitive(q)||/\b(?:captcha|security question|assessment|test question|quiz|date of birth|birth date|age|race|racial|ethnic(?:ity)?|ancestry|national origin|country of origin|nationality|hispanic|latin(?:o|a|x)|indigenous|aboriginal|native american|gender|male|female|non binary|transgender|sex(?:ual orientation)?|pronouns?|lgbtq?|disabilit(?:y|ies)|veteran|military status|religion|marital status|voluntary self identification|equal employment|eeo|salary|compensation|desired pay|expected pay|pay expectation|pay rate|hourly rate|wages?|remuneration|bonus|equity|work authori[sz](?:ation|ed)|authori[sz]ed to work|eligible to work|work eligibility|employment eligibility|right to work|permission to work|legally (?:permitted|allowed|eligible) to work|work permit|sponsor(?:ship)?|visa|citizen(?:ship)?|immigration|criminal|convict(?:ed|ion)|felony|background check|security clearance|consent|agree|agreement|accept(?:ance)?|acknowledg(?:e|ement)|certif(?:y|ication)|attest(?:ation)?|declar(?:e|ation)|signature|arbitration|non compete|conflict of interest)\b/i.test(q)||/\b(?:over|at least)\s+(?:18|eighteen)\b/i.test(q);
}

const textParts=field=>[field?.label,field?.ariaLabel,field?.name,field?.id,field?.placeholder].map(x=>String(x||'').trim()).filter(Boolean);
const autocompleteKind=field=>AUTOCOMPLETE[String(field?.autocomplete||'').toLowerCase().trim().split(/\s+/).pop()];

export function hostedFieldKind(field){
 const parts=textParts(field),context=policyText(parts.join(' '));if(protectedHostedQuestion(context)||THIRD_PARTY_CONTACT.test(context))return null;
 const kinds=parts.map(value=>{const spaced=value.replace(/([a-z\d])([A-Z])/g,'$1 $2'),direct=fieldKind(spaced);if(direct)return direct;return fieldKind(spaced.replace(/^(?:applicant|candidate|user|profile)\s+/i,''));}).filter(Boolean);
 const token=autocompleteKind(field);if(token)kinds.push(token);
 const type=String(field?.type||'').toLowerCase();if(type==='email')kinds.push('email');if(type==='tel')kinds.push('phone');
 const unique=[...new Set(kinds)];return unique.length===1&&PROFILE_KINDS.has(unique[0])?unique[0]:null;
}

function trustedAnswer(kind,profile,answers){
 const direct=knownAnswer(CANONICAL[kind],profile,{});
 const saved=[...new Set(Object.entries(answers||{}).filter(([question,value])=>fieldKind(question)===kind&&!protectedHostedQuestion(question)&&['string','number','boolean'].includes(typeof value)&&String(value).trim()).map(([,value])=>String(value).trim()))];
 const normalized=new Set(saved.map(normalize));if(normalized.size>1)return null;
 if(direct&&saved.length&&normalize(direct)!==normalize(saved[0]))return null;
 return direct||saved[0]||null;
}

export function hostedFieldAnswer(field,profile,answers={}){
 const kind=hostedFieldKind(field);if(!kind)return null;
 const answer=trustedAnswer(kind,profile,answers);return answer===null?null:{kind,answer:String(answer)};
}

function questionFor(field){return textParts(field)[0]||'';}

export function hostedOptionChoice(field,options,profile,answers={}){
 const question=questionFor(field),optionContext=(options||[]).flatMap(option=>[option?.label,option?.value]).join(' ');
 if(!question||protectedHostedQuestion(textParts(field).join(' ')+' '+optionContext))return null;
 const trusted=hostedFieldAnswer(field,profile,answers);
 if(!trusted&&GENERIC_QUESTION.test(policyText(question)))return null;
 const answer=trusted?.answer??savedAnswer(question,answers);if(answer===null||answer===undefined||answer==='')return null;
 const matches=(options||[]).filter(option=>!option.disabled&&(trusted?optionMatches(CANONICAL[trusted.kind],option.label,answer,profile):normalize(option.label)===normalize(answer)||String(option.value)===String(answer)));
 return matches.length===1?matches[0]:null;
}

export function approvedHostedRadioIndex(options,answers={}){
 const questions=[...new Set((options||[]).map(option=>normalize(option.question)).filter(Boolean))];
 const context=(options||[]).flatMap(option=>[option?.question,option?.label,option?.value]).join(' ');
 if(questions.length!==1||GENERIC_QUESTION.test(policyText(options?.[0]?.question))||protectedHostedQuestion(context))return -1;
 const answer=savedAnswer(options[0].question,answers);if(answer===null)return -1;
 const matches=(options||[]).map((option,index)=>({option,index})).filter(({option})=>normalize(option.label)===normalize(answer));
 return matches.length===1?matches[0].index:-1;
}

export function requiredUnansweredRadioGroups(radios=[]){
 const groups=new Map();for(const radio of radios){const key=`${radio.form??-1}:${radio.name||radio.question||''}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(radio);}
 const missing=[];for(const group of groups.values())if(group.some(radio=>radio.required)&&!group.some(radio=>radio.checked))missing.push(group[0].name||group[0].question||'Radio question');
 return [...new Set(missing)];
}
