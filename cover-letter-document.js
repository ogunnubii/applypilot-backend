import {chromium} from 'playwright';
import {buildZip} from './extension-package.js';

export const documentTypes={docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',pdf:'application/pdf'};
export function coverLetterFormat(accept=''){
 const types=String(accept).toLowerCase().split(',').map(v=>v.trim()).filter(Boolean);
 return ['docx','pdf'].find(ext=>!types.length||types.some(t=>t==='.'+ext||t===documentTypes[ext]||t==='application/*'||t==='*/*'))||null;
}
const xml=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
export async function renderCoverLetter(text,format,{launch=()=>chromium.launch({headless:true})}={}){
 if(typeof text!=='string'||!text.trim()||text.length>4000)throw Error('A cover letter must contain 1–4,000 characters.');
 if(format==='docx')return buildZip([
  ['[Content_Types].xml','<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
  ['_rels/.rels','<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
  ['word/document.xml','<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+text.split(/\r?\n/).map(line=>'<w:p><w:pPr><w:spacing w:after="160"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr><w:t xml:space="preserve">'+xml(line)+'</w:t></w:r></w:p>').join('')+'<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/></w:sectPr></w:body></w:document>']
 ]);
 if(format!=='pdf')throw Error('The employer must accept PDF or DOCX cover letters.');
 let browser;
 try{
  browser=await launch();const page=await browser.newPage();
  await page.route('**/*',route=>route.abort());
  await page.setContent('<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>@page{size:Letter;margin:.75in}body{font:11pt/1.45 Arial,sans-serif;color:#111}p{white-space:pre-wrap;margin:0 0 12pt}</style>'+text.split(/\n\s*\n/).map(p=>'<p>'+xml(p)+'</p>').join(''));
  return await page.pdf({format:'Letter',preferCSSPageSize:true});
 }finally{await browser?.close();}
}
