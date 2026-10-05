// Explicit search mode: these are job preferences, not claims about qualifications.
export const WORLDWIDE_TECH_INSTRUCTION='Worldwide technology roles: DevOps, SRE, systems administration, IT, platform engineering, AI infrastructure, architecture, software, cloud, security, data and technical support; eligibility: worldwide sponsorship, remote from Canada, or B2B; Canada B2B only';
export function worldwideTechIntent(instruction){return /^Worldwide technology roles:/i.test(String(instruction||''));}
export function technologyRole(title){
 const s=String(title||'').toLowerCase();
 if(/\b(?:recruiter|sales|account executive|marketing|human resources|talent acquisition|manufacturing|civil engineer|mechanical engineer)\b/.test(s))return false;
 return /\b(?:dev[ -]?ops|devsecops|sre|site reliability|sysadmin|systems? administrators?|systems? engineer|it\b|information technology|platform|infrastructure|cloud|software|full[ -]?stack|front[ -]?end|back[ -]?end|network|cyber|security engineer|security architect|security analyst|soc analyst|mlops|aiops|artificial intelligence|machine learning|ai infrastructure|data engineer|data architect|database|technical support|application support|production support|support engineer|help[ -]?desk|service desk|desktop support|endpoint|solutions? architect|enterprise architect|technical architect|automation engineer|observability|release engineer|build engineer|kubernetes|linux|windows engineer|engineering manager|head of engineering|chief technology)\b/.test(s);
}
