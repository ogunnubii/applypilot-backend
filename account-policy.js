// New public accounts are explicitly marked; historical/invite accounts retain
// their existing notification behavior. No route can self-verify a mailbox.
export function installAccountPolicy(db){db.exec('CREATE TABLE IF NOT EXISTS public_account_security(user_id TEXT PRIMARY KEY REFERENCES users(id),email_verified_at TEXT)');}
export function canEmailAccount(db,userId){const row=db.prepare('SELECT email_verified_at FROM public_account_security WHERE user_id=?').get(userId);return !row||!!row.email_verified_at;}
