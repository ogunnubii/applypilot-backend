import {isAbsolute,resolve,relative,sep} from 'node:path';

// Preserve stored source paths and all ledger rows. Only an explicitly configured
// old upload root is mapped to the restored private resume directory.
export function resolveResumePath(stored,{root=process.env.UPLOAD_DIR,legacyRoot=process.env.LEGACY_UPLOAD_DIR}={}){
 if(!legacyRoot)return stored;
 const fail=()=>{throw Error('Resume path is outside the verified storage roots')};
 if(typeof stored!=='string'||stored.includes('\0')||!root||!isAbsolute(root))fail();
 const normalized=stored.replaceAll('\\','/'),old=legacyRoot.replaceAll('\\','/').replace(/\/$/,'');
 if(!old||!(/^\/[\w-]/.test(old)||/^[A-Za-z]:\//.test(old))||old.split('/').some(x=>x==='..'||x==='.')||normalized.split('/').some(x=>x==='..'||x==='.')||/^[a-z]+:\/\//i.test(normalized))fail();
 let target;
 if(normalized.startsWith(old+'/'))target=resolve(root,...normalized.slice(old.length+1).split('/'));
 else if(isAbsolute(stored))target=resolve(stored);
 else fail();
 const r=relative(resolve(root),target);
 if(!r||r==='..'||r.startsWith('..'+sep)||isAbsolute(r))fail();
 return target;
}
