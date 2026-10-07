const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
test('remote Canada search preserves its scope despite worldwide support defaults',async()=>{
 const s=await import('../support-career.js');
 const src=read('discovery.js'),start=src.indexOf('const placeWords='),end=src.indexOf('export function profileSearchInstruction');
 const parse=new Function('supportIntent','remoteCanadaIntent','worldwideTechIntent',src.slice(start,end).replace(/export /g,'')+';return parseIntent;')(s.supportIntent,s.remoteCanadaIntent,()=>false);
 const intent=parse(s.CANADA_SUPPORT_INSTRUCTION);assert.equal(intent.remote,true);assert.equal(intent.remoteCanadaOnly,true);assert.deepEqual(intent.remotePlaces,['canada']);assert.deepEqual(intent.localPlaces,[]);
 const {jobIntelligence}=await import('../job-intelligence.js');
 const job={title:'Cloud Support Engineer',location:'Remote Canada',remote:true,description:'CAD 70-90/hour. We accept incorporated contractors.'};
 assert(jobIntelligence(job,intent).eligibility.eligible);assert(jobIntelligence(job,intent).salaryTarget.eligible);
 assert(!jobIntelligence({...job,location:'London hybrid; visa sponsorship'},intent).eligibility.eligible);
 assert(!jobIntelligence({...job,location:'Remote Canada',description:'Full-time permanent T4 employment.'},intent).eligibility.eligible);
 const db={prepare:()=>({all:()=>[{instruction:s.CANADA_SUPPORT_INSTRUCTION}]})};assert.equal(s.supportSearchInstruction(db,'u','p'),s.CANADA_SUPPORT_INSTRUCTION);
});
test('incorporated remote eligibility needs engagement evidence, Canadian scope and stable remote work',async()=>{
 const {workEligibility:f}=await import('../work-eligibility.js'),base={location:'Remote Canada',remote:true},options={remoteCanadaOnly:true,incorporatedFromCanada:true};
 for(const description of ['Rate: CAD 75-95/hr C2C','Engagement: C2C or T4','B2B (Incorporated Entities Only)','Candidates must be incorporated','We welcome incorporated consultants','Contract type: B2B'])assert(f({...base,description},options).eligible,description);
 for(const description of ['Sell to B2B customers. Full time employee.','We were incorporated in 1995. Permanent employment.','Independent contractor','T4 only; C2C not available','C2C contracts are not accepted','B2B contract. Provisionally remote.','C2C contract. Must attend on-site.','C2C contract. Two days hybrid.'])assert(!f({...base,description},options).eligible,description);
 assert(!f({...base,location:'Remote USA',description:'C2C accepted'},options).eligible);
 assert(!f({...base,location:'Toronto',remote:false,description:'C2C accepted'},options).eligible);
});
