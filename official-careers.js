// Verified employer-owned careers pages, checked 2026-10-04. These are
// discovery links, not replacement requisitions or permission to bypass a hold.
const ASHBY_BOARDS=Object.freeze({
 hud:'https://www.hud.ai/careers',
 'wispr-flow':'https://wisprflow.ai/careers',
 callosum:'https://www.callosum.com/join-us',
 photoroom:'https://www.photoroom.com/company',
});
export function officialCareers(job){
 try{
  const url=new URL(job.url);
  if(!['jobs.ashbyhq.com','jobs.eu.ashbyhq.com'].includes(url.hostname))return null;
  const href=ASHBY_BOARDS[url.pathname.split('/').filter(Boolean)[0]?.toLowerCase()];
  return href?{url:href,checkedAt:'2026-10-04',note:'Official careers page. The company may still use its hiring platform for applications. Check the current role and avoid applying twice.'}:null;
 }catch{return null;}
}
