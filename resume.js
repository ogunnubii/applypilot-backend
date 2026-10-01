import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {inflateRawSync} from 'node:zlib';

const run=promisify(execFile);
const roles=[
  [/\bdevops\b/i,'DevOps Engineer'],[/\bcloud\s*(?:and|&|\/)\s*devops\b|\bcloud\s+engineer\b/i,'Cloud Engineer'],
  [/\bsite reliability\b|\bSRE\b/i,'Site Reliability Engineer'],[/\bplatform engineer\b/i,'Platform Engineer'],
  [/\binfrastructure engineer\b/i,'Infrastructure Engineer'],[/\bsoftware engineer\b/i,'Software Engineer'],
  [/\bsystems? (?:administrator|engineer)\b/i,'Systems Engineer'],[/\bnetwork engineer\b/i,'Network Engineer'],
  [/\bIT support\b|\bhelp desk\b|\bservice desk\b/i,'IT Support'],[/\boperations manager\b/i,'Operations Manager'],
  [/\bproperty (?:manager|management|operations)\b/i,'Property Manager'],[/\bbuilding (?:operations|superintendent|manager)\b/i,'Building Operations'],
  [/\bexecutive director\b/i,'Executive Director'],[/\bproject manager\b/i,'Project Manager'],
  [/\bregistered nurse\b|\bnursing\b/i,'Nurse'],[/\baccountant\b/i,'Accountant'],
];

function extractDocx(bytes){
  let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50){end=i;break}
  if(end<0)throw Error('Could not read DOCX archive');
  const count=bytes.readUInt16LE(end+10);let offset=bytes.readUInt32LE(end+16);
  for(let i=0;i<count&&offset+46<=bytes.length;i++){
    if(bytes.readUInt32LE(offset)!==0x02014b50)break;
    const method=bytes.readUInt16LE(offset+10),compressed=bytes.readUInt32LE(offset+20),uncompressed=bytes.readUInt32LE(offset+24),nameSize=bytes.readUInt16LE(offset+28),extraSize=bytes.readUInt16LE(offset+30),commentSize=bytes.readUInt16LE(offset+32);
    const name=bytes.subarray(offset+46,offset+46+nameSize).toString();
    if(name==='word/document.xml'){
      if(uncompressed>2_000_000)throw Error('Resume text is too large');
      const local=bytes.readUInt32LE(offset+42);
      if(bytes.readUInt32LE(local)!==0x04034b50)throw Error('Invalid DOCX document');
      const start=local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28);
      const compressedBytes=bytes.subarray(start,start+compressed);
      const xml=(method===8?inflateRawSync(compressedBytes,{maxOutputLength:2_000_000}):method===0?compressedBytes:null)?.toString('utf8');
      if(!xml)throw Error('Unsupported DOCX compression');
      return xml.replace(/<\/w:p>/g,'\n').replace(/<w:tab\b[^>]*\/>/g,' ').replace(/<[^>]+>/g,'').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,(_,entity)=>{
        const map={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};return map[entity]||String.fromCodePoint(parseInt(entity.slice(entity[1]==='x'?2:1),entity[1]==='x'?16:10));
      });
    }
    offset+=46+nameSize+extraSize+commentSize;
  }
  throw Error('Resume document text was not found');
}

export async function resumeText(path,kind){
  let text;
  if(kind==='.pdf')({stdout:text}=await run('pdftotext',['-layout',path,'-'],{timeout:10000,maxBuffer:1_000_000}));
  else text=extractDocx(await readFile(path));
  return text;
}

export async function resumeRoles(path,kind){
  const text=await resumeText(path,kind);
  const lines=text.split(/\n/).map(x=>x.trim()).filter(Boolean),head=lines.slice(0,65).join('\n').slice(0,6500);
  const found=roles.map(([pattern,label])=>({label,position:head.search(pattern)})).filter(x=>x.position>=0).sort((a,b)=>a.position-b.position);
  return [...new Set(found.map(x=>x.label))].slice(0,4);
}
