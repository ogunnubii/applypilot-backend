import {hasUsedResearchDraftForJob} from './google-research.js';

export function researchConsentWithdrawn(db,jobId,applicantId){
 if(!hasUsedResearchDraftForJob(db,jobId))return false;
 return !db.prepare('SELECT google_research_consent FROM applicants WHERE id=?').get(applicantId)?.google_research_consent;
}
