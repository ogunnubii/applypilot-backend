import {registerCompanyApplicationPolicyFunctions} from '../company-application-policy.js';
import {registerPreparationHandoffFunctions} from '../preparation-handoff.js';
import {employerKey} from '../employer-limits.js';
import {sameApplication} from '../application-dedup.js';
import {companyKey,historyKey} from '../application-history.js';

// Persisted native triggers need the same functions on EVERY writer connection,
// including a dedicated async connection. This does not install or weaken DDL.
export function registerNativeFunctions(db){
 registerCompanyApplicationPolicyFunctions(db);registerPreparationHandoffFunctions(db);
 db.function('application_employer_key',{deterministic:true},(company,url)=>employerKey({company,url}));
 db.function('same_application',{deterministic:true},(ac,at,au,bc,bt,bu)=>Number(sameApplication({company:ac,title:at,url:au},{company:bc,title:bt,url:bu})));
 db.function('history_company',{deterministic:true},companyKey);db.function('history_title',{deterministic:true},historyKey);
}
