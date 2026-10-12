// Recognize the actual employer refusal, not generic discussion of spam.
// This is evidence of a security block, never receipt evidence or retry consent.
export function employerSecurityRejection(value,url){
 try{if(!['jobs.ashbyhq.com','jobs.eu.ashbyhq.com'].includes(new URL(url).hostname))return null;}catch{return null;}
 const sentences=String(value||'').replace(/[’]/g,"'").split(/[\r\n]+|(?<=[.!?])\s+/).map(s=>s.trim()).filter(Boolean);
 if(!sentences.some((sentence,index)=>/^we couldn't submit your application[.!]?$/i.test(sentence)&&/^your application submission was flagged as possible spam[.!]?$/i.test(sentences[index+1]||'')&&!/\b(?:example|sample|hypothetical|if|when)\b/i.test(sentences[index-1]||'')))return null;
 return 'The employer refused this application as possible spam. This is not a receipt. Automatic applications to this employer are held for review; do not retry or bypass its security check.';
}
