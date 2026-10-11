// Preserve every employer-listed location; the first location is not the
// complete hiring scope for postings with secondary locations.
export function ashbyPosting(job,company){
 const locations=[job.location,...(Array.isArray(job.secondaryLocations)?job.secondaryLocations.map(item=>item?.location):[])];
 const location=[...new Set(locations.filter(value=>typeof value==='string').map(value=>value.trim()).filter(Boolean))].join('; ');
 const employmentTypes={FullTime:'Full time',PartTime:'Part time',Contract:'Contract',Intern:'Internship',Temporary:'Temporary'};
 return {title:job.title,company,location,publishedAt:job.publishedAt,compensation:job.compensation,description:job.descriptionPlain||job.descriptionHtml,employmentType:employmentTypes[job.employmentType]||job.employmentType,remote:job.isRemote===true||job.workplaceType==='Remote',url:job.applyUrl||job.jobUrl};
}
