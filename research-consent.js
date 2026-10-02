import {factDraftConsentWithdrawn} from './draft-provenance.js';
import {hasUsedResearchDraftForJob} from './google-research.js';

export function researchConsentWithdrawn(db,jobId,applicantId){
 const profile=db.prepare('SELECT * FROM applicants WHERE id=?').get(applicantId);if(factDraftConsentWithdrawn(db,jobId,profile))return true;
 if(!hasUsedResearchDraftForJob(db,jobId))return false;
 return !db.prepare('SELECT google_research_consent FROM applicants WHERE id=?').get(applicantId)?.google_research_consent;
}
