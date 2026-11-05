// Rebuild web/applypilot-local.zip from extension/ (same file list as the
// server's download). Fails if the manifest references a file not packaged.
import {writeFile,readFile} from 'node:fs/promises';
import {extensionArchive,EXTENSION_FILES} from './extension-package.js';
const manifest=JSON.parse(await readFile(new URL('./extension/manifest.json',import.meta.url),'utf8'));
const referenced=new Set([manifest.background?.service_worker,manifest.action?.default_popup,...(manifest.content_scripts||[]).flatMap(c=>c.js||[])].filter(Boolean));
const missing=[...referenced].filter(f=>!EXTENSION_FILES.includes(f));
if(missing.length){console.error('Extension files missing from the package list: '+missing.join(', '));process.exit(1);}
const out=new URL('./web/applypilot-local.zip',import.meta.url);
await writeFile(out,await extensionArchive());
console.log('Extension '+manifest.version+' packaged at web/applypilot-local.zip');
