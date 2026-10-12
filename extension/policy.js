// Shared, deterministic policy. No model-generated facts are used for form filling.
(() => {
  const domains = ['greenhouse.io','lever.co','myworkdayjobs.com','workdayjobs.com','ashbyhq.com','smartrecruiters.com','workable.com','bamboohr.com','recruitee.com'];
  function customApplication(url){
    try{const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443')return null;
      const host=u.hostname.replace(/^www\./,'');
      if(host==='iitjobs.com'&&/^\/job\/[^/]+-\d+\/?$/.test(u.pathname))return 'iitjobs';
      if(host==='randstad.ca'&&/^\/jobs\/[^/]+_\d+\/?$/.test(u.pathname))return 'randstad';
      if(host==='join.jfrog.com'&&/^\/job\/\d+-[^/]+\/?$/.test(u.pathname))return 'jfrog';
      if(host==='careers-kinaxis.icims.com'&&/^\/jobs\/\d+\//.test(u.pathname))return 'icims';
      if(host==='careers.deloitte.ca'&&/^\/job\/[^/]+\/\d+-en_US\/?$/.test(u.pathname))return 'deloitte';
    }catch{}return null;
  }
  const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[?]/g,'').replace(/[*✱]/g, '').replace(/\s+/g, ' ').trim();
  function greenhouseIdentity(url){
    try{const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443')return null;
      if(u.hostname==='careers.trivago.com'&&/^\/apply\/?$/.test(u.pathname)&&u.searchParams.getAll('gh_jid').length===1&&/^\d+$/.test(u.searchParams.get('gh_jid')))return 'https://boards.greenhouse.io/trivago/jobs/'+u.searchParams.get('gh_jid');
      if(!['boards.greenhouse.io','job-boards.greenhouse.io'].includes(u.hostname))return null;
      if(/^\/embed\/job_app\/?$/.test(u.pathname)&&u.searchParams.getAll('for').length===1&&u.searchParams.getAll('token').length===1&&/^[a-z0-9_-]+$/i.test(u.searchParams.get('for'))&&/^\d+$/.test(u.searchParams.get('token')))return 'https://boards.greenhouse.io/'+u.searchParams.get('for')+'/jobs/'+u.searchParams.get('token');
      if(/^\/[a-z0-9_-]+\/jobs\/\d+\/?$/i.test(u.pathname))return 'https://boards.greenhouse.io'+u.pathname.replace(/\/$/,'');
    }catch{}return null;
  }
  function trustedFrame(sender,url){
    if(sender.frameId===0)return sameApplication(sender.url,url);
    try{const u=new URL(sender.url);return Number.isInteger(sender.frameId)&&sender.frameId>0&&/^\/embed\/job_app\/?$/.test(u.pathname)&&!!greenhouseIdentity(sender.url)&&sameApplication(sender.url,url)&&sameApplication(sender.tab?.url,url);}catch{return false;}
  }
  function supported(url) {
    try { const u = new URL(url); return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') && (domains.some(d => u.hostname === d || u.hostname.endsWith('.'+d))||customApplication(url)||u.hostname==='careers.trivago.com'&&!!greenhouseIdentity(url)); } catch { return false; }
  }
  function identity(url) {
    const canonical=greenhouseIdentity(url);if(canonical)return canonical;
    const u = new URL(url); u.hash = '';
    const custom=customApplication(url);
    if(custom){u.hostname=u.hostname.replace(/^www\./,'');u.search='';if(custom==='icims')u.pathname=u.pathname.match(/^\/jobs\/\d+/)[0];}
    u.hostname = u.hostname.replace('job-boards.greenhouse.io','boards.greenhouse.io');
    if (/(?:^|\.)(?:myworkdayjobs|workdayjobs)\.com$/i.test(u.hostname)) u.pathname = u.pathname.replace(/^\/[a-z]{2}(?:-[a-z]{2})?(?=\/)/i,'');
    u.pathname = u.pathname.replace(/\/(apply|application|thanks|thank-you|confirmation)\/?$/i,'').replace(/\/$/,'');
    for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k) || ['source','ref','gh_src','step','lang','locale','language'].includes(k.toLowerCase())) u.searchParams.delete(k);
    u.searchParams.sort(); return u.toString();
  }
  function sameApplication(a,b) { try { return supported(a) && supported(b) && identity(a) === identity(b); } catch { return false; } }
  const submissionDeclaration = value => /\bby\s+(?:clicking|selecting|pressing|submitting|sending|completing)[\s\S]{0,240}?\b(?:agree|accept|certify|attest|consent|acknowledge|declare|authorize|waive)\b/i.test(String(value));
  const sensitive = value => /\b(certify|certification of accuracy|attest|perjury|legally binding|AI policy|arbitrat(?:ion|e)|waive|waiver|agree that|electronic signature|e-signature|signature|agree to|accept the terms|terms and conditions|acknowledge|declare that|accurate and complete|consent|criminal|convictions|authorize.*(?:background|credit)|payment|application fee|pay now|purchase|checkout|credit card|card number|cardholder|bank account|social security|national insurance|passport number|ssn)\b/i.test(String(value));
  const receipt = value => {
    const text=String(value);
    // Match affirmative receipt sentences, not a substring inside a failure,
    // hypothetical instruction or quoted example. Keep the original text so
    // contradictory qualifiers cannot be discarded before evidence is saved.
    const sentences=text.split(/[\r\n]+|(?<=[.!?])\s+/);
    const failed=/\bno (?:job )?application (?:was )?(?:received|submitted)\b|\b(?:not|never) (?:been )?(?:submitted|received|processed|sent|delivered|accepted)\b|\b(?:could(?:n['’]t| not)|can(?:not|['’]t)|unable to|failed to) (?:be )?(?:submit(?:ted)?|receiv(?:e|ed)|process(?:ed)?|sen[dt]|deliver(?:ed)?|accept(?:ed)?)\b|\b(?:submission|delivery)(?: (?:has |had )?failed| was unsuccessful)\b|\bunsuccessful\b|\ban? error occurred\b|\bwith errors?\b|\b(?:pending|awaiting|queued)\b/i;
    // A polite thank-you must not mask an application failure on the next
    // sentence. Ignore unrelated footer instructions such as Do not reply.
    if(sentences.some((sentence,index)=>failed.test(sentence)&&(/\b(?:application|submission|delivery)\b/i.test(sentence)||/^\s*it\b/i.test(sentence)&&/\bapplication\b/i.test(sentences[index-1]||''))))return '';
    for(const sentence of sentences){
      const line=sentence.trim().replace(/^(?:Applicant verified|Browser extension observed):\s*/i,'');
      const existing=line.match(/^(?:(?:your )?application (?:has been |was )?(?:successfully )?(?:submitted|received)\b|thank(?:s| you) for (?:applying|your application)\b)[^\r\n]*/i);
      if(existing&&!failed.test(line)&&! /\breceived an? error\b/i.test(line))return existing[0].slice(0,400);
    }
    // Randstad's actual receipt uses "sent to". Require the affirmative sentence
    // on its own line, not a future instruction, quotation or pending message.
    // Callers still require a matching application and a recorded receipt event.
    const sent=(text.match(/(?:^|[\r\n])\s*(?:(?:Applicant verified|Browser extension observed): )?(Your job application has been sent to [^\r\n.!?]{2,100}[.!])(?=\s|$)/i)||[])[1]||'';
    return /\b(?:pending|not|awaiting|queued|failed)\b/i.test(sent)?'':sent;
  };
  function savedAnswer(question, answers) {
    if (sensitive(question)||normalize(question)==='required field') return null;
    const keys = Object.keys(answers || {}).filter(k => normalize(k) === normalize(question));
    return keys.length === 1 && ['string','number','boolean'].includes(typeof answers[keys[0]]) ? String(answers[keys[0]]) : null;
  }

  // Multi-select answers are explicit lists, never inferred from a skills
  // paragraph or split on commas (an option itself may contain a comma).
  function savedOptionSelections(question, options, answers) {
    const value=savedAnswer(question,answers);
    if(value===null||!Array.isArray(options)||!options.length||options.length>80||sensitive(options.map(o=>o.label).join(' ')))return null;
    let labels;
    if(value.trim().startsWith('[')){try{labels=JSON.parse(value);}catch{return null;}}
    else labels=value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean);
    if(!Array.isArray(labels)||!labels.length||labels.length>80||labels.some(v=>typeof v!=='string'||!v.trim())||new Set(labels.map(normalize)).size!==labels.length)return null;
    const result=[];
    for(const label of labels){const matches=options.filter(o=>!o.disabled&&normalize(o.label)===normalize(label));if(matches.length!==1)return null;result.push(matches[0]);}
    return result;
  }

  const aliases={
   name:['full name','your full name','name','your name','first and last name','your first and last name','first & last name','your first & last name'],first:['first name','given name'],last:['last name','family name','surname'],
   email:['email','email address','your email','your email address'],phone:['phone','phone number','telephone','telephone number','mobile','mobile phone','mobile number','contact number','contact phone number','primary phone number'],
   location:['location','current location','where are you currently located city & country','where are you currently located city and country','where are you currently located city country'],city:['location city','city','current city','city of residence','town','town city','city town'],country:['country','country of residence','current country','residence country'],
   timezone:['time zone','timezone','your time zone','your timezone','current time zone','primary time zone','work time zone','which time zone do you primarily work in','what time zone do you primarily work in','which time zone do you work in','what time zone do you work in','which time zone are you based in','what time zone are you based in','which time zone are you in','what time zone are you in'],
   region:['state','province','state province','province state'],postal:['postal code','zip code','zip postal code'],
   linkedin:['linkedin','linkedin profile','linkedin url','linkedin profile url'],github:['github','github profile','github url','github profile url'],
   website:['website','website url','personal website','personal website url','portfolio','portfolio url','portfolio website','portfolio website url','website portfolio','website or portfolio','personal site','personal site url'],
   school:['school','university','college university','school name','university name'],degree:['degree','degree type'],discipline:['discipline','field of study','major']
  };
  function fieldKind(question){const q=normalize(question).replace(/[():/_-]/g,' ').replace(/\btimezone\b/g,'time zone').replace(/\b(optional|required)\b/g,'').replace(/\s+/g,' ').trim();const direct=Object.keys(aliases).find(k=>aliases[k].includes(q));if(direct)return direct;
    // Confirming the applicant's present work/residency location is a contact
    // fact. Keep the whole question anchored so relocation and eligibility
    // questions cannot borrow that answer. Inline city/country help is common.
    if(/^(?:location )?(?:please )?confirm your (?:current )?work residency location(?: city (?:and |& )?country)?$/.test(q)||/^(?:current )?location city (?:and |& )?country$/.test(q))return 'location';
    if(aliases.timezone.includes(q.replace(/^(?:applicant|candidate|user|profile)\s+/,'')))return 'timezone';
    // Anchored wording variants only: no fuzzy matching or employer/third-party URLs.
    const prompted=q.replace(/^(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:provide|enter|share|list)\s+(?:a\s+)?(?:link\s+to\s+)?(?:your\s+)?/,'').replace(/^(?:what is|what's)\s+your\s+/,'');
    const personal=prompted.replace(/^your\s+/,'').replace(/\s+below$/,'').replace(/\s+link$/,'').trim();
    if(aliases.website.includes(personal))return 'website';
    const social=personal.replace(/\s+(?:profile\s+)?(?:url|link)$/,'').replace(/\s+profile$/,'').trim();
    if(['linkedin','github'].includes(social))return social;
    if(/^(?:please\s+)?(?:enter|provide|share)\s+your\s+/.test(q)||/^(?:what is|what's)\s+your\s+/.test(q)){
      return ['name','first','last','email','phone','city','country','region','postal','timezone'].find(k=>aliases[k].includes(prompted));
    }
    return undefined;
  }
  // These are display labels for clock-rule regions, not a city-to-timezone
  // inference. Fixed offsets/EST/PST alone do not identify a DST-observing zone.
  const timeZoneRegions=[
   {name:'eastern',short:'et',pair:'est/edt',offset:'05',ids:['america/toronto','america/new_york']},
   {name:'central',short:'ct',pair:'cst/cdt',offset:'06',ids:['america/winnipeg','america/chicago']},
   {name:'mountain',short:'mt',pair:'mst/mdt',offset:'07',ids:['america/edmonton','america/denver']},
   {name:'pacific',short:'pt',pair:'pst/pdt',offset:'08',ids:['america/vancouver','america/los_angeles']}
  ];
  function timeZoneIdentity(value){
   const text=normalize(value);
   if(/^(?:[a-z_]+(?:\/[a-z0-9_+\-]+)+|utc|gmt)$/.test(text))try{
    const id=normalize(new Intl.DateTimeFormat('en',{timeZone:String(value).trim()}).resolvedOptions().timeZone);
    return {id,region:timeZoneRegions.find(region=>region.ids.includes(id))?.name};
   }catch{}
   for(const region of timeZoneRegions){
    const labels=[`${region.name} time`,`${region.name} time zone`,`${region.name} time (${region.short})`,`${region.name} time (${region.pair})`,`${region.name} time (us & canada)`,`${region.name} time (us and canada)`,`north american ${region.name} time`];
    const withoutOffset=text.replace(new RegExp(`^\\((?:utc|gmt)-${region.offset}:00\\)\\s*`),'');
    if(labels.includes(withoutOffset))return {region:region.name};
   }
   const annotated=text.match(/^(.+) \(([a-z_]+(?:\/[a-z0-9_+\-]+)+)\)$/);
   if(annotated){const label=timeZoneIdentity(annotated[1]),zone=timeZoneIdentity(annotated[2]);if(label?.region&&zone?.id&&label.region===zone.region)return zone;}
   return null;
  }
  function sameTimeZone(a,b){
   if(normalize(a)===normalize(b))return true;
   const left=timeZoneIdentity(a),right=timeZoneIdentity(b);if(!left||!right)return false;
   if(left.id&&right.id)return left.id===right.id;
   return !!left.region&&left.region===right.region;
  }
  function explicitTimeZone(profile,answers){
   const values=[profile?.timezone,profile?.timeZone,profile?.time_zone,...Object.entries(answers||{}).filter(([question])=>fieldKind(question)==='timezone'&&!sensitive(question)).map(([,value])=>value)].filter(value=>typeof value==='string'&&value.trim()).map(value=>value.trim());
   return values.length&&values.every((value,index)=>values.slice(index+1).every(other=>sameTimeZone(value,other)))?values[0]:null;
  }
  function knownAnswer(question,profile,answers){
   if(sensitive(question)||normalize(question)==='required field')return null;
   const kind=fieldKind(question);
   if(kind==='timezone')return explicitTimeZone(profile,answers);
   const exact=savedAnswer(question,answers);if(exact!==null)return exact;
   if(!kind)return null;
   const values=[...new Set(Object.keys(answers||{}).filter(k=>fieldKind(k)===kind&&!sensitive(k)).map(k=>String(answers[k]).trim()).filter(Boolean))];
   if(values.length>1)return null;if(values.length===1)return values[0];
   const p=profile||{},parts=String(p.location||'').split(',').map(x=>x.trim()),name=String(p.name||'').trim();
   const direct={name,first:name.split(/\s+/)[0],last:name.split(/\s+/).slice(1).join(' '),email:p.email,phone:p.phone,location:p.location,city:p.city||(parts.length===3?parts[0]:null),country:p.country||(parts.length===3?parts[2]:null),region:p.region||(parts.length===3?parts[1]:null),postal:p.postal,linkedin:p.linkedin,github:p.github,website:p.website};
   return direct[kind]||null;
  }
  function optionMatches(question,option,answer,profile){
   const kind=fieldKind(question),o=normalize(option),a=normalize(answer);
   if(o===a)return true;
   if(kind==='timezone')return sameTimeZone(option,answer);
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
   return (Array.isArray(jobs)?jobs:[]).filter(job=>needsInput(job)&&job.id&&!seen.has(job.id)&&seen.add(job.id)).sort((a,b)=>(Number(a.queue_position)||Infinity)-(Number(b.queue_position)||Infinity)||(Date.parse(a.created_at)||0)-(Date.parse(b.created_at)||0)||String(a.id).localeCompare(String(b.id)));
  }

const languagePlain=v=>String(v||'').replace(/<[^>]*>/g,' ').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
function frenchApplication(job={}){
 let metadata={};try{metadata=JSON.parse(job.job_metadata_json||'{}')}catch{}
 const lang=String(job.language||job.formLanguage||metadata.formLanguage||'').toLowerCase();
 if(/^fr(?:-|$)/.test(lang)||metadata.frenchApplication===true)return true;
 const title=languagePlain(job.title),text=languagePlain([job.title,job.description,job.required_fields_json].join(' '));
 if(/\b(?:ingenieur|ingenieure|gestionnaire|developpeur|developpeuse|administrateur|administratrice|conseiller|conseillere|technicien|technicienne)\b/.test(title))return true;
 if(/(?:[?&](?:lang|locale|language)=fr(?:[-_][a-z]+)?(?:&|$)|\/fr(?:[-_](?:ca|fr))?\/)/i.test(job.url||''))return true;
 const signals=['postuler','candidature','votre experience','vos competences','curriculum vitae','lettre de motivation','prenom','courriel','autorise a travailler','nous recherchons','vous serez','rejoignez'];
 return signals.filter(s=>text.includes(s)).length>=2;
}

  globalThis.ApplyPilotPolicy = Object.freeze({customApplication,submissionDeclaration,greenhouseIdentity,trustedFrame,frenchApplication,needsInput,attentionOrder,employerPageIssue,domains,normalize,supported,identity,sameApplication,sensitive,receipt,savedAnswer,savedOptionSelections,fieldKind,knownAnswer,optionMatches});
})();
