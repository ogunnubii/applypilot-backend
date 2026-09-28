// Shared, deterministic policy. No model-generated facts are used for form filling.
(() => {
  const domains = ['greenhouse.io','lever.co','myworkdayjobs.com','workdayjobs.com','ashbyhq.com','smartrecruiters.com','workable.com','bamboohr.com','recruitee.com'];
  const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[*✱]/g, '').replace(/\s+/g, ' ').trim();
  function supported(url) {
    try { const u = new URL(url); return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') && domains.some(d => u.hostname === d || u.hostname.endsWith('.'+d)); } catch { return false; }
  }
  function identity(url) {
    const u = new URL(url); u.hash = '';
    u.hostname = u.hostname.replace('job-boards.greenhouse.io','boards.greenhouse.io');
    u.pathname = u.pathname.replace(/\/(apply|application|thanks|thank-you|confirmation)\/?$/i,'').replace(/\/$/,'');
    for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k) || ['source','ref','gh_src','step'].includes(k)) u.searchParams.delete(k);
    u.searchParams.sort(); return u.toString();
  }
  function sameApplication(a,b) { try { return supported(a) && supported(b) && identity(a) === identity(b); } catch { return false; } }
  const sensitive = value => /\b(certify|certification of accuracy|attest|perjury|legally binding|electronic signature|e-signature|signature|agree to|accept the terms|terms and conditions|acknowledge|declare that|accurate and complete|consent to|authorize.*(?:background|credit)|payment|application fee|pay now|purchase|checkout|credit card|card number|cardholder|bank account|social security|national insurance|passport number|ssn)\b/i.test(String(value));
  const receipt = value => (String(value).match(/(?:your )?application (?:has been |was )?(?:successfully )?(?:submitted|received)\b[^\n]{0,100}|thank(?:s| you) for (?:applying|your application)\b[^\n]{0,100}/i)||[])[0] || '';
  function savedAnswer(question, answers) {
    if (sensitive(question)) return null;
    const keys = Object.keys(answers || {}).filter(k => normalize(k) === normalize(question));
    return keys.length === 1 && ['string','number','boolean'].includes(typeof answers[keys[0]]) ? String(answers[keys[0]]) : null;
  }
  globalThis.ApplyPilotPolicy = Object.freeze({domains,normalize,supported,identity,sameApplication,sensitive,receipt,savedAnswer});
})();
