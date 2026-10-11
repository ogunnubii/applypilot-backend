// Compare only valid personal LinkedIn URLs. Button labels, checkboxes and
// incomplete captured text are not competing applicant identities.
export function canonicalLinkedIn(value){
 const text=String(value??'').trim();
 try{
  const url=new URL(/^(?:www\.)?linkedin\.com\//i.test(text)?'https://'+text:text);
  if(!['http:','https:'].includes(url.protocol)||!['linkedin.com','www.linkedin.com'].includes(url.hostname)||url.username||url.password||url.port||url.hash||!/^\/in\/[^\s/?#]+\/?$/.test(url.pathname)||[...url.searchParams.keys()].some(key=>!key.startsWith('utm_')))return null;
  return 'https://www.linkedin.com'+url.pathname.replace(/\/$/,'').toLowerCase();
 }catch{return null;}
}

// GitHub profile paths are case-insensitive; formatting variants of the same
// approved account must not look like conflicting applicant identities.
export function canonicalGitHub(value){
 const text=String(value??'').trim();
 try{
  const url=new URL(/^(?:www\.)?github\.com\//i.test(text)?'https://'+text:text);
  if(!['http:','https:'].includes(url.protocol)||!['github.com','www.github.com'].includes(url.hostname)||url.username||url.password||url.port||url.hash||!/^\/[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/?$/i.test(url.pathname)||[...url.searchParams.keys()].some(key=>!key.startsWith('utm_')))return null;
  return 'https://github.com'+url.pathname.replace(/\/$/,'').toLowerCase();
 }catch{return null;}
}

