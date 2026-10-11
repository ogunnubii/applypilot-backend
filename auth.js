import {scryptSync,randomBytes,timingSafeEqual,createHmac,createHash} from 'node:crypto';
const secret=process.env.SESSION_SECRET;if(!secret||secret.length<32)throw Error('Set SESSION_SECRET to a random value of at least 32 characters');
export function hashPassword(password){if(typeof password!=='string'||password.length<12||password.length>128)throw Error('Password must be between 12 and 128 characters');const salt=randomBytes(16).toString('hex');return `${salt}:${scryptSync(password,salt,64).toString('hex')}`;}
export function verifyPassword(password,stored){
 if(typeof password!=='string'||password.length>128||typeof stored!=='string')return false;
 const [salt,hash,...extra]=stored.split(':');if(extra.length||! /^[a-f0-9]{32}$/.test(salt)||! /^[a-f0-9]{128}$/.test(hash))return false;
 return timingSafeEqual(scryptSync(password,salt,64),Buffer.from(hash,'hex'));
}
export function issueToken(id,remember=false){const expires=Date.now()+(remember===true?30*24:12)*60*60*1000,payload=Buffer.from(JSON.stringify({id,expires,nonce:randomBytes(16).toString('hex')})).toString('base64url'),signature=createHmac('sha256',secret).update(payload).digest('base64url');return `${payload}.${signature}`;}
const fingerprint=token=>createHash('sha256').update(token).digest('hex');
export function installSessions(db){db.exec('CREATE TABLE IF NOT EXISTS revoked_sessions(token_hash TEXT PRIMARY KEY,expires INTEGER NOT NULL)');}
export function readToken(token,db){
 if(typeof token!=='string'||token.length>4096)return null;
 const [payload,signature,...extra]=token.split('.');if(!payload||!signature||extra.length||!/^[A-Za-z0-9_-]+$/.test(payload)||!/^[A-Za-z0-9_-]+$/.test(signature))return null;
 const expected=createHmac('sha256',secret).update(payload).digest();let actual;try{actual=Buffer.from(signature,'base64url');}catch{return null;}
 if(signature!==actual.toString('base64url')||payload!==Buffer.from(payload,'base64url').toString('base64url')||expected.length!==actual.length||!timingSafeEqual(expected,actual))return null;
 try{const d=JSON.parse(Buffer.from(payload,'base64url'));if(typeof d.id!=='string'||!d.id||!Number.isFinite(d.expires)||d.expires<=Date.now())return null;
  if(db&&(!db.prepare('SELECT 1 FROM users WHERE id=?').get(d.id)||db.prepare('SELECT 1 FROM revoked_sessions WHERE token_hash=?').get(fingerprint(token))))return null;
  return d.id;
 }catch{return null;}
}
export function revokeToken(db,token){if(!readToken(token,db))return;const {expires}=JSON.parse(Buffer.from(token.split('.')[0],'base64url'));db.prepare('DELETE FROM revoked_sessions WHERE expires<=?').run(Date.now());db.prepare('INSERT OR IGNORE INTO revoked_sessions VALUES(?,?)').run(fingerprint(token),expires);}
