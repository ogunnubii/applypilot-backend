// Shared, deterministic policy. No model-generated facts are used for form filling.
(() => {
  const domains = ['greenhouse.io','lever.co','myworkdayjobs.com','workdayjobs.com','ashbyhq.com','smartrecruiters.com','workable.com','bamboohr.com','recruitee.com'];
  const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[?]/g,'').replace(/[*✱]/g, '').replace(/\s+/g, ' ').trim();
  function supported(url) {
    try { const u = new URL(url); return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') && domains.some(d => u.hostname === d || u.hostname.endsWith('.'+d)); } catch { return false; }
  }
  function identity(url) {
    const u = new URL(url); u.hash = '';
    u.hostname = u.hostname.replace('job-boards.greenhouse.io','boards.greenhouse.io');
    u.pathname = u.pathname.replace(/\/(apply|application|thanks|thank-you|confirmation)\/?$/i,'').replace(/\/$/,'');
    for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k) || ['source','ref','gh_src','step'].includes(k)) u.searchParams.delete(k);
    u.searchParams.sort(); return u.toString();
  }
  function sameApplication(a,b) { try { return supported(a) && supported(b) && identity(a) === identity(b); } catch { return false; } }
  const sensitive = value => /\b(certify|certification of accuracy|attest|perjury|legally binding|AI policy|arbitrat(?:ion|e)|waive|waiver|agree that|electronic signature|e-signature|signature|agree to|accept the terms|terms and conditions|acknowledge|declare that|accurate and complete|consent|criminal|convictions|authorize.*(?:background|credit)|payment|application fee|pay now|purchase|checkout|credit card|card number|cardholder|bank account|social security|national insurance|passport number|ssn)\b/i.test(String(value));
  const receipt = value => (String(value).match(/(?:your )?application (?:has been |was )?(?:successfully )?(?:submitted|received)\b[^\n]{0,100}|thank(?:s| you) for (?:applying|your application)\b[^\n]{0,100}/i)||[])[0] || '';
  function savedAnswer(question, answers) {
    if (sensitive(question)||normalize(question)==='required field') return null;
    const keys = Object.keys(answers || {}).filter(k => normalize(k) === normalize(question));
    return keys.length === 1 && ['string','number','boolean'].includes(typeof answers[keys[0]]) ? String(answers[keys[0]]) : null;
  }

  const aliases={
   name:['full name','your full name','name','your name'],first:['first name','given name'],last:['last name','family name','surname'],
   email:['email','email address','your email','your email address'],phone:['phone','phone number','telephone','telephone number','mobile','mobile phone','mobile number','contact number','contact phone number','primary phone number'],
   location:['location','current location'],city:['location city','city','current city','city of residence','town','town city','city town'],country:['country','country of residence','current country','residence country'],
   region:['state','province','state province','province state'],postal:['postal code','zip code','zip postal code'],
   linkedin:['linkedin','linkedin profile','linkedin url','linkedin profile url'],github:['github','github profile','github url','github profile url'],
   school:['school','university','college university','school name','university name'],degree:['degree','degree type'],discipline:['discipline','field of study','major']
  };
  function fieldKind(question){const q=normalize(question).replace(/[():/_-]/g,' ').replace(/\b(optional|required)\b/g,'').replace(/\s+/g,' ').trim();return Object.keys(aliases).find(k=>aliases[k].includes(q));}
  function knownAnswer(question,profile,answers){
   if(sensitive(question)||normalize(question)==='required field')return null;
   const exact=savedAnswer(question,answers);if(exact!==null)return exact;
   const kind=fieldKind(question);
   if(!kind){
    if(/^what country and time zone are you based in$/.test(normalize(question))&&/^Toronto,\s*Ontario,\s*Canada$/i.test(profile?.location||''))return 'Canada — Eastern Time (America/Toronto)';
    return null;
   }
   const values=[...new Set(Object.keys(answers||{}).filter(k=>fieldKind(k)===kind&&!sensitive(k)).map(k=>String(answers[k]).trim()).filter(Boolean))];
   if(values.length>1)return null;if(values.length===1)return values[0];
   const p=profile||{},parts=String(p.location||'').split(',').map(x=>x.trim()),name=String(p.name||'').trim();
   const direct={name,first:name.split(/\s+/)[0],last:name.split(/\s+/).slice(1).join(' '),email:p.email,phone:p.phone,location:p.location,city:p.city||(parts.length===3?parts[0]:null),country:p.country||(parts.length===3?parts[2]:null),region:p.region||(parts.length===3?parts[1]:null),postal:p.postal,linkedin:p.linkedin,github:p.github};
   return direct[kind]||null;
  }
  function optionMatches(question,option,answer,profile){
   const kind=fieldKind(question),o=normalize(option),a=normalize(answer);
   if(o===a)return true;
   if(kind==='country')return o.replace(/\s*\+\d+\s*$/,'').trim()===a;
   if(kind==='city'){
    const clean=v=>normalize(v).replace(/\bontario\b/g,'on').replace(/[^a-z0-9]+/g,' ').trim();
    return !!profile?.location&&clean(option)===clean(profile.location)&&clean(profile.location).startsWith(clean(answer)+' ');
   }
   return false;
  }

  function employerPageIssue({status=0,title='',text='',hasForm=false}={}){
   let code=Number(status)||0;
   // Text recognition is restricted to an error page's opening, never job prose or a real form.
   if(![403,404,410,429,500,502,503,504].includes(code)&&!hasForm){
    for(const value of [title,String(text).slice(0,1200)]){
    const opening=normalize(value);
    const match=opening.match(/^(?:(?:greenhouse|error|http|http error|service unavailable|bad gateway|gateway timeout)\s*[:\-–]?\s*){0,3}(403|404|410|429|500|502|503|504)\b/);
    if(match){code=Number(match[1]);break;}
    else if(/^(?:greenhouse\s+)?service unavailable\b/.test(opening)){code=503;break;}
    }
   }
   if([500,502,503,504].includes(code))return {code,retryable:true,message:'Employer site temporarily unavailable (HTTP '+code+'). This is not an application confirmation.'};
   if(code===429)return {code,retryable:false,message:'Employer site rate limit (HTTP 429). Wait before opening more applications on this site.'};
   if(code===404||code===410)return {code,retryable:false,message:'Employer application page is unavailable (HTTP '+code+'). Check whether the posting has closed or moved.'};
   if(code===403)return {code,retryable:false,message:'Employer site denied access (HTTP 403). Open the employer page to review its access requirements.'};
   return null;
  }


  function needsInput(job){
   return !!job&&!['duplicate','archived','submitted','interview','rejected','offer'].includes(job.status)&&(['paused','needs_review'].includes(job.status)||job.status==='local_browser'&&(job.local_phase==='blocked'||job.evidence?.stalled)||job.evidence?.blocked===true);
  }
  function attentionOrder(jobs){
   const seen=new Set();
   return (Array.isArray(jobs)?jobs:[]).filter(job=>needsInput(job)&&job.id&&!seen.has(job.id)&&seen.add(job.id)).sort((a,b)=>(Date.parse(a.created_at)||0)-(Date.parse(b.created_at)||0)||String(a.id).localeCompare(String(b.id)));
  }

  globalThis.ApplyPilotPolicy = Object.freeze({needsInput,attentionOrder,employerPageIssue,domains,normalize,supported,identity,sameApplication,sensitive,receipt,savedAnswer,fieldKind,knownAnswer,optionMatches});
})();
