import {readFile} from 'node:fs/promises';

export const DEFAULT_PUBLIC_SITE_ORIGIN='https://marvelous-vitality-production-c2d8.up.railway.app';
const pages={
 '/':{file:'home.html',title:'ApplyPilot | Job application tracker and application assistant',description:'Organize your job search with ApplyPilot. Keep applicant profiles, saved answers and application progress together, with review when your input is needed.'},
 '/guides/job-application-checklist':{file:'checklist.html',title:'Job application checklist: prepare, review and track | ApplyPilot',description:'A practical checklist for organizing job applications: verify the role, prepare accurate answers, review the form and save confirmation before following up.'}
};
export function publicSiteOrigin(value=process.env.PUBLIC_SITE_ORIGIN||DEFAULT_PUBLIC_SITE_ORIGIN){
 const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('PUBLIC_SITE_ORIGIN must be an HTTPS origin without credentials, path, query or fragment');
 return url.origin;
}
const escapeHTML=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function servePublicSite(req,res,{origin=publicSiteOrigin(),indexable=process.env.SEO_INDEXABLE!=='false'}={}){
 if(!['GET','HEAD'].includes(req.method))return false;
 const path=new URL(req.url,'http://localhost').pathname;
 let content,type='text/html; charset=utf-8';
 if(pages[path]){
  const page=pages[path],canonical=origin+path;
  const schema=JSON.stringify({'@context':'https://schema.org','@type':'WebSite',name:'ApplyPilot',url:origin+'/'}).replace(/</g,'\\u003c');
  const head=`<title>${escapeHTML(page.title)}</title><meta name="description" content="${escapeHTML(page.description)}"><meta name="robots" content="${indexable?'index,follow':'noindex,nofollow'}"><link rel="canonical" href="${escapeHTML(canonical)}"><meta property="og:type" content="website"><meta property="og:site_name" content="ApplyPilot"><meta property="og:title" content="${escapeHTML(page.title)}"><meta property="og:description" content="${escapeHTML(page.description)}"><meta property="og:url" content="${escapeHTML(canonical)}"><meta name="twitter:card" content="summary"><script type="application/ld+json">${schema}</script>`;
  content=(await readFile(new URL('./public/'+page.file,import.meta.url),'utf8')).replace('<!-- SEO_HEAD -->',head);
 }else if(path==='/assets/marketing.css'){
  content=await readFile(new URL('./public/marketing.css',import.meta.url));type='text/css; charset=utf-8';
 }else if(path==='/robots.txt'){
  // Crawlers must be able to read private routes' noindex headers. Authentication,
  // never robots.txt, protects personal data. Only these public pages enter sitemap.
  content=indexable?`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`:'User-agent: *\nDisallow: /\n';type='text/plain; charset=utf-8';
 }else if(path==='/sitemap.xml'){
  content=`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${indexable?Object.keys(pages).map(p=>`<url><loc>${escapeHTML(origin+p)}</loc></url>`).join(''):''}</urlset>`;type='application/xml; charset=utf-8';
 }else return false;
 res.writeHead(200,{'content-type':type,'cache-control':'public, max-age=300','x-content-type-options':'nosniff','x-robots-tag':pages[path]&&indexable?'index, follow':'noindex','referrer-policy':'strict-origin-when-cross-origin','content-security-policy':"default-src 'none'; style-src 'self'; script-src 'none'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"});
 res.end(req.method==='HEAD'?undefined:content);return true;
}
