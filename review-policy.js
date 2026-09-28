// Job descriptions can discuss payments, certifications or security without asking
// the applicant to make a declaration. Stop for actual commitments and data requests.
export function requiresHumanReview(text) {
  return /\b(?:i (?:hereby )?(?:certify|attest|declare|agree|acknowledge|authorize)|by (?:submitting|clicking|applying|continuing)[\s\S]{0,240}(?:agree|acknowledge|consent|certify|authorize)|under penalty of perjury|electronic signature|e-signature|sign (?:this|the) (?:agreement|declaration)|accept (?:the |these )?terms|agree to|consent to|accurate and complete|authorize[\s\S]{0,60}(?:background|credit) check|application fee|pay now|card number|cardholder|bank account number|social security number|passport number|national insurance number)\b/i.test(String(text));
}
