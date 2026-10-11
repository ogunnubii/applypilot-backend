import {isIP} from 'node:net';
import {installAccountPolicy} from './account-policy.js';
import {randomUUID,createHash} from 'node:crypto';
import {hashPassword,verifyPassword,issueToken,installSessions} from './auth.js';
export function installAccounts(db){
 installSessions(db);installAccountPolicy(db);
 db.exec(`CREATE TABLE IF NOT EXISTS auth_attempts(bucket TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL);`);
 // Enforce ownership for new/changed relationships without rewriting legacy data.
 for(const table of ['jobs','searches'])for(const action of ['INSERT','UPDATE'])db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_tenant_${action.toLowerCase()} BEFORE ${action} ON ${table} WHEN NOT EXISTS(SELECT 1 FROM applicants WHERE id=NEW.applicant_id AND user_id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'Applicant does not belong to account'); END;`);
}
export function allowAuthAttempt(db,address,email=''){
 const clock=Date.now(),window=10*60*1000;
 db.prepare('DELETE FROM auth_attempts WHERE expires<=?').run(clock);
 // Socket IP is deliberately used rather than trusting spoofable forwarding headers.
 const buckets=[[`ip:${address}`,40],[`email:${email}`,12]];
 for(const [value,limit]of buckets){const key=createHash('sha256').update(value).digest('hex'),row=db.prepare('SELECT count FROM auth_attempts WHERE bucket=?').get(key);if(row?.count>=limit)return false;}
 for(const [value]of buckets){const key=createHash('sha256').update(value).digest('hex');db.prepare('INSERT INTO auth_attempts VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1').run(key,clock+window);}return true;
}
export function normalizeEmail(value){if(typeof value!=='string'||value.trim().length>254)return '';const email=value.trim().toLowerCase();return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)?email:'';}
export function createAccount(db,input,{publicSignup=true}={}){
 const email=normalizeEmail(input?.email);if(!email)throw Error('Valid email required');
 const hash=hashPassword(input.password),id=randomUUID();
 // Case-insensitive lookup preserves existing accounts created before public signup.
 if(db.prepare('SELECT 1 FROM users WHERE lower(email)=?').get(email)){const error=Error('Unable to create account with these details. Try signing in.');error.status=409;throw error;}
 db.exec('BEGIN IMMEDIATE');try{
  db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run(id,email,hash,new Date().toISOString());
  if(publicSignup)db.prepare('INSERT INTO public_account_security(user_id) VALUES(?)').run(id);
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}
 return {token:issueToken(id,input.remember===true),user:{id,email,emailVerified:false}};
}
const dummyHash=hashPassword('constant-dummy-password-not-an-account');
export function loginAccount(db,input){
 const email=normalizeEmail(input?.email),user=db.prepare('SELECT id,email,password_hash FROM users WHERE lower(email)=?').get(email);
 const valid=verifyPassword(input?.password,user?.password_hash||dummyHash);if(!user||!valid)return null;
 return {token:issueToken(user.id,input.remember===true),user:{id:user.id,email:user.email,emailVerified:false}};
}

// Opt-in exact peer allowlist. Never trust X-Forwarded-For from arbitrary clients.
export function authClientAddress(req,env=process.env){
 const normalize=value=>{const ip=String(value||'').trim().toLowerCase();return ip.startsWith('::ffff:')&&isIP(ip.slice(7))===4?ip.slice(7):ip;};
 const peer=normalize(req.socket?.remoteAddress)||'unknown';
 const configured=String(env.AUTH_TRUSTED_PROXY_IPS||'').split(',').map(normalize).filter(Boolean);
 if(configured.some(ip=>!isIP(ip)))throw Error('AUTH_TRUSTED_PROXY_IPS must contain only exact proxy IP addresses');
 const trusted=new Set(configured);if(!trusted.has(peer))return peer;
 const header=req.headers?.['x-forwarded-for'];if(typeof header!=='string')return peer;
 const chain=header.split(',').map(normalize);if(chain.length>20||chain.some(ip=>!isIP(ip)))return peer;
 for(let i=chain.length-1;i>=0;i--)if(!trusted.has(chain[i]))return chain[i];
 return peer;
}
