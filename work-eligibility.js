// Evidence-based eligibility filter for the applicant's explicit worldwide search mode.
// Remote in one country is not permission to work remotely from another.
export function workEligibility(job,{incorporatedFromCanada=false}={}){
 const plain=value=>String(value||'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/<[^>]*>/g,' ').replace(/&(?:nbsp|amp);/g,' ').replace(/\s+/g,' ').trim();
 const location=plain(job.location),text=plain([job.title,job.employmentType,job.description].join(' '));
 const canada=/\b(canada|toronto|ontario|vancouver|montreal|ottawa|calgary|quebec)\b/i.test(location);
 const citizenship=/\b(?:US|U\.S\.|United States)\s+(?:citizenship\s+is\s+required|citizens?\s+only)\b|\bmust\s+be\s+(?:a\s+)?(?:US|U\.S\.|United States)\s+citizen\b/i.test(text);
 if(citizenship)return {eligible:false,reason:'Posting requires US citizenship; eligibility needs applicant review'};
 const restrictedRemote=/\b(?:must|need to)\s+(?:be\s+)?(?:based|reside|located|live)\s+in\s+(?!Canada\b)|\b(?:US|USA|United States|UK|United Kingdom|EU|Europe|India)[- ](?:based|only)\b|\b(?:only|restricted to|limited to)\s+(?:the\s+)?(?:US|USA|United States|UK|United Kingdom|EU|Europe)\b|\b(?:excluding|except|not available in)\s+Canada\b/i.test(text);
 const b2b=text.match(/\b(?:b2b\s*(?:\/\s*)?(?:contract(?:or)?|engagement|role)|contract\s+type\s*:\s*b2b|(?:contract|engagement)\s+(?:on a\s+)?b2b\s+basis|corp(?:oration)?[\s-]*(?:to|2)[\s-]*corp|c2c\s+(?:contract|accepted|welcome)|incorporated\s+(?:contractors?|consultants?)|independent\s+contractors?|consulting\s+contract)\b/i);
 const noB2b=/\b(?:no|not accepting|cannot accept|do not accept)\s+(?:b2b|c2c|corp[\s-]*(?:to|2)[\s-]*corp|independent contractors)\b/i.test(text);
 const incorporated=/\b(?:corp(?:oration)?[\s-]*(?:to|2)[\s-]*corp|c2c\s+(?:contract|accepted|welcome)|incorporated\s+(?:contractors?|consultants?)|(?:contract|engagement|role)\s+(?:on a\s+)?b2b\s+basis|b2b\s+(?:contract|engagement|role))\b/i.test(text);
 if(canada&&(!incorporated||noB2b||/\b(?:T4 only|T4 employment|no incorporated)\b/i.test(text)))return {eligible:false,reason:'Canada requires explicit incorporated / C2C / B2B engagement; generic contract or T4 employment is not sufficient'};
 if(b2b&&!noB2b&&!restrictedRemote)return {eligible:true,reason:'Posting specifies '+b2b[0],kind:'business-contract'};
 if(canada)return {eligible:false,reason:'Canadian role has no explicit B2B / consulting-contract evidence'};
 const noSponsor=/\bvisa\s+sponsorship\s+(?:is\s+)?available\s*:?\s*no\b|\b(?:no|without)\s+(?:visa\s+)?sponsorship\b|\b(?:cannot|can't|unable to|do not|don't|not able to|will not)\s+(?:provide|offer|support)?\s*(?:visa\s+)?sponsor|\b(?:visa\s+)?sponsorship\s+(?:is\s+)?(?:not|unavailable)/i.test(text);
 const sponsor=text.match(/\b(?:we\s+(?:can\s+|will\s+|do\s+)?(?:offer|provide|support)\s+(?:work\s+)?visa\s+sponsorship|we\s+(?:can\s+|will\s+|do\s+)?sponsor\s+(?:work\s+)?visas|(?:work\s+)?visa\s+sponsorship\s*:?\s+(?:is\s+)?(?:available|provided|offered|supported)|visa\s+sponsorship\s+(?:and|&)\s+relocation\s+(?:support|assistance|benefits)|(?:offer|provide)\s+sponsorship\s+for\s+(?:work\s+)?visas)\b/i);
 if(sponsor&&!noSponsor){
  const scoped=text.match(/\b(?:sponsor\s+(?:work\s+)?visas|visa\s+sponsorship(?:\s+is\s+available)?)\s+(?:to|in|for)\s+(Germany|France|Ireland|Netherlands|United Kingdom|United States|Canada|Australia|Singapore|Japan)\b/i);
  const aliases={'united states':/united states|\bUSA?\b|san francisco|new york|seattle/i,'united kingdom':/united kingdom|\bUK\b|london|manchester/i,germany:/germany|berlin|munich|hamburg/i};
  if(scoped&&!(aliases[scoped[1].toLowerCase()]||new RegExp(scoped[1],'i')).test(location))return {eligible:false,reason:'Sponsorship is stated for '+scoped[1]+'; this role lists a different location'};
  return {eligible:true,reason:'Posting states '+sponsor[0],kind:'sponsorship'};
 }
 const remote=job.remote===true||/\bremote\b/i.test(location+' '+text);
 const explicitGlobal=/\b(?:worldwide|global|anywhere)\b/i.test(location)||/\b(?:worldwide remote|remote worldwide|globally remote|remote globally|work (?:remotely )?from anywhere(?: in the world)?)\b/i.test(text);
 const internationalContract=/\b(contractor|contract|freelance|consultant)\b/i.test(job.employmentType||'');
 const restricted=/\b(?:must|need to)\s+(?:be\s+)?(?:based|reside|located|live)\s+in\b|\b(?:only|restricted to|limited to)\s+(?:the\s+)?(?:US|USA|United States|UK|United Kingdom|EU|Europe)\b|\b(?:excluding|except|not available in)\s+Canada\b/i.test(text);
 if(remote&&explicitGlobal&&!restricted){
  if(incorporatedFromCanada&&!incorporated)return {eligible:false,reason:'Working remotely from Canada requires explicit incorporated / C2C / B2B engagement'};
  return {eligible:true,reason:'Posting explicitly describes worldwide remote work; employer eligibility checks still apply',kind:'worldwide-remote'};
 }
 if(internationalContract&&!restrictedRemote)return {eligible:true,reason:'International contract engagement in posting',kind:'contract'};
 return {eligible:false,reason:'No explicit sponsorship, eligible remote scope or contract evidence'};
}
