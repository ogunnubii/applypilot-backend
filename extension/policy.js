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
  const sensitive = value => /\b(certify|certification of accuracy|attest|perjury|legally binding|electronic signature|e-signature|signature|agree to|accept the terms|terms and conditions|acknowledge|declare that|accurate and complete|consent to|authorize.*(?:background|credit)|payment|application fee|pay now|purchase|checkout|credit card|card number|cardholder|bank account|social security|national insurance|passport number|ssn)\b/i.test(String(value));
  const receipt = value => (String(value).match(/(?:your )?application (?:has been |was )?(?:successfully )?(?:submitted|received)\b[^\n]{0,100}|thank(?:s| you) for (?:applying|your application)\b[^\n]{0,100}/i)||[])[0] || '';
  function savedAnswer(question, answers) {
    if (sensitive(question)) return null;
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
   if(sensitive(question))return null;
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
  globalThis.ApplyPilotPolicy = Object.freeze({domains,normalize,supported,identity,sameApplication,sensitive,receipt,savedAnswer,fieldKind,knownAnswer});
})();
