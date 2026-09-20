// Deterministic matching: no model calls or Work credits.
const groups = [
 ['devops','dev ops','site reliability','sre','platform engineer','cloud engineer','cloud infrastructure'],
 ['systems administrator','system administrator','sysadmin','systems engineer','system engineer'],
 ['technical account manager','tam'], ['registered nurse','nurse','rn'],
 ['building operations','building operator','building superintendent']
];
const clean = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const phrase = (s,p) => (` ${s} `).includes(` ${p} `);
export function matches(job,intent){
 const title=clean(job.title), location=clean(job.location);
 const roleMatch=intent.roles.some(role=>{
  const r=clean(role);
  if(r.split(' ').every(w=>phrase(title,w))) return true;
  return groups.some(g=>g.some(x=>phrase(r,x))&&g.some(x=>phrase(title,x)));
 });
 if(!roleMatch)return false;
 if(intent.remote && !(job.remote===true||phrase(location,'remote')))return false;
 const countries={canada:['canada','toronto','ontario','vancouver','british columbia','montreal','quebec','ottawa','calgary','alberta','waterloo','winnipeg','halifax'],usa:['usa','united states'],'united states':['usa','united states'],uk:['uk','united kingdom'],'united kingdom':['uk','united kingdom']};
 if(intent.places.length&&!intent.places.some(p=>(countries[p]||[p]).some(x=>phrase(location,x))||job.remote===true&&/\b(anywhere|worldwide|global)\b/.test(location)))return false;
 return true;
}
