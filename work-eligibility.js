// Evidence-based eligibility filter for the applicant's explicit worldwide search mode.
// Remote in one country is not permission to work remotely from another.
export function workEligibility(job){
 const plain=value=>String(value||'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/<[^>]*>/g,' ').replace(/&(?:nbsp|amp);/g,' ').replace(/\s+/g,' ').trim();
 const location=plain(job.location),text=plain([job.title,job.employmentType,job.description].join(' '));
 const canada=/\b(canada|toronto|ontario|vancouver|montreal|ottawa|calgary|quebec)\b/i.test(location);
 const b2b=text.match(/\b(?:b2b\s+(?:contract|engagement|role)|(?:contract|engagement)\s+(?:on a\s+)?b2b\s+basis|corp(?:oration)?[\s-]*(?:to|2)[\s-]*corp|c2c\s+(?:contract|accepted|welcome)|incorporated\s+(?:contractors?|consultants?)|independent\s+contractors?|consulting\s+contract)\b/i);
 const noB2b=/\b(?:no|not accepting|cannot accept|do not accept)\s+(?:b2b|c2c|corp[\s-]*(?:to|2)[\s-]*corp|independent contractors)\b/i.test(text);
 if(b2b&&!noB2b)return {eligible:true,reason:'Posting specifies '+b2b[0],kind:'business-contract'};
 if(canada)return {eligible:false,reason:'Canadian role has no explicit B2B / consulting-contract evidence'};
 const noSponsor=/\b(?:no|without)\s+(?:visa\s+)?sponsorship\b|\b(?:cannot|can't|unable to|do not|don't|not able to|will not)\s+(?:provide|offer|support)?\s*(?:visa\s+)?sponsor|\b(?:visa\s+)?sponsorship\s+(?:is\s+)?(?:not|unavailable)/i.test(text);
 const sponsor=text.match(/\b(?:we\s+(?:can\s+|will\s+|do\s+)?(?:offer|provide|support)\s+(?:work\s+)?visa\s+sponsorship|we\s+(?:can\s+|will\s+|do\s+)?sponsor\s+(?:work\s+)?visas|(?:work\s+)?visa\s+sponsorship\s+(?:is\s+)?(?:available|provided|offered|supported)|(?:offer|provide)\s+sponsorship\s+for\s+(?:work\s+)?visas)\b/i);
 if(sponsor&&!noSponsor)return {eligible:true,reason:'Posting states '+sponsor[0],kind:'sponsorship'};
 const remote=job.remote===true||/\bremote\b/i.test(location+' '+text);
 const explicitGlobal=/\b(?:worldwide|global|anywhere)\b/i.test(location)||/\b(?:worldwide remote|remote worldwide|globally remote|remote globally|work (?:remotely )?from anywhere(?: in the world)?)\b/i.test(text);
 const internationalContract=/\b(contractor|contract|freelance|consultant)\b/i.test(job.employmentType||'');
 const restricted=/\b(?:must|need to)\s+(?:be\s+)?(?:based|reside|located|live)\s+in\b|\b(?:only|restricted to|limited to)\s+(?:the\s+)?(?:US|USA|United States|UK|United Kingdom|EU|Europe)\b|\b(?:excluding|except|not available in)\s+Canada\b/i.test(text);
 if(remote&&explicitGlobal&&!restricted)return {eligible:true,reason:'Posting explicitly describes worldwide remote work; employer eligibility checks still apply',kind:'worldwide-remote'};
 if(internationalContract)return {eligible:true,reason:'International contract engagement in posting',kind:'contract'};
 return {eligible:false,reason:'No explicit sponsorship, eligible remote scope or contract evidence'};
}
