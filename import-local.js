// Launcher helper: import a profile/history JSON file straight into the local
// database (same rules as POST /api/import). Usage:
//   node --env-file=.env.local import-local.js <file.json> [account-email]
import {readFile} from 'node:fs/promises';
import {db} from './db.js';
import {importBundle} from './profile-import.js';
const [file,email]=process.argv.slice(2);
if(!file){console.error('Usage: import-local.js <file.json> [account-email]');process.exit(2);}
const users=email?db.prepare('SELECT id,email FROM users WHERE lower(email)=lower(?)').all(email):db.prepare('SELECT id,email FROM users').all();
if(users.length!==1){console.error(users.length?'Several accounts exist; pass the account email.':'No local account yet. Open '+(process.env.PUBLIC_ORIGIN||'http://localhost:8080')+'/setup first.');process.exit(2);}
try{
 const result=importBundle(db,users[0].id,JSON.parse(await readFile(file,'utf8')));
 const h=result.history;
 console.log(`Imported into ${users[0].email}: profile ${result.created?'created (confirm consent and add a resume in ApplyPilot)':result.applicant?'updated':'unchanged'}; ${result.updatedFields.length} profile fields and ${result.answersAdded} answers added.`);
 if(h)console.log(`Application history: ${h.added} added, ${h.updated} updated, ${h.blocked} queued jobs blocked as repeats, ${h.active.length} active jobs need your review.`);
 for(const c of result.answerConflicts)console.log(`Kept existing "${c.field}" (imported value differs; not overwritten).`);
}catch(e){console.error('Import failed: '+e.message);process.exitCode=1;}
finally{db.close();}
