import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {servePublicSite,publicSiteOrigin,DEFAULT_PUBLIC_SITE_ORIGIN} from '../public-site.js';

async function response(path,options={},method='GET'){
 const result={headers:{},status:null,body:''};
 const res={writeHead(status,headers){result.status=status;Object.assign(result.headers,headers);},end(body){result.body=body?.toString()||'';}};
 result.handled=await servePublicSite({url:path,method,headers:{host:'attacker.example'}},res,{origin:DEFAULT_PUBLIC_SITE_ORIGIN,indexable:true,...options});
 return result;
}
for(const path of ['/','/guides/job-application-checklist'])test(`public HTML is useful and crawlable without JavaScript: ${path}`,async()=>{
 const r=await response(path+'?utm_source=test');assert.equal(r.status,200);assert.equal(r.headers['x-robots-tag'],'index, follow');
 const doc=new JSDOM(r.body).window.document;
 assert.equal(doc.documentElement.lang,'en');assert.equal(doc.querySelectorAll('h1').length,1);assert.ok(doc.querySelector('main').textContent.length>1500);
 assert.ok(doc.title.length>20);assert.ok(doc.querySelector('meta[name="description"]').content.length>70);
 assert.equal(doc.querySelector('link[rel="canonical"]').href,DEFAULT_PUBLIC_SITE_ORIGIN+path);
 assert.equal(doc.querySelector('meta[property="og:url"]').content,DEFAULT_PUBLIC_SITE_ORIGIN+path);
 assert.equal(doc.querySelector('meta[name="robots"]').content,'index,follow');
 assert.ok(doc.querySelector('a[href="/signup"]'));assert.ok(doc.querySelector('a[href="/login"]'));assert.ok(doc.querySelector('a[href="#main"]'));
 assert.equal(doc.querySelectorAll('script[src]').length,0);
 const data=JSON.parse(doc.querySelector('script[type="application/ld+json"]').textContent);
 assert.equal(data['@type'],'WebSite');assert.equal(data.url,DEFAULT_PUBLIC_SITE_ORIGIN+'/');assert.equal(data.aggregateRating,undefined);
 for(const a of doc.querySelectorAll('a[href^="#"]'))assert.ok(doc.getElementById(a.hash.slice(1)),`missing anchor ${a.hash}`);
});
test('sitemap contains only the exact public canonical allowlist',async()=>{
 const r=await response('/sitemap.xml');assert.match(r.headers['content-type'],/xml/);
 const doc=new JSDOM(r.body,{contentType:'application/xml'}).window.document;
 assert.deepEqual([...doc.querySelectorAll('loc')].map(x=>x.textContent),[DEFAULT_PUBLIC_SITE_ORIGIN+'/',DEFAULT_PUBLIC_SITE_ORIGIN+'/guides/job-application-checklist']);
});
test('robots advertises sitemap without hiding private noindex headers',async()=>{
 const r=await response('/robots.txt');assert.match(r.body,/Allow: \/\n/);assert.match(r.body,/Sitemap: https:\/\//);assert.doesNotMatch(r.body,/Disallow/);
});
test('public origin does not depend on untrusted request host; configuration is validated',async()=>{
 assert.equal(publicSiteOrigin('https://example.com/'),'https://example.com');
 for(const value of ['http://example.com','https://user:pass@example.com','https://example.com/path','https://example.com/?x=1','https://example.com/#hash'])assert.throws(()=>publicSiteOrigin(value));
 const r=await response('/',{origin:publicSiteOrigin('https://example.com')});assert.match(r.body,/href="https:\/\/example.com\/"/);assert.doesNotMatch(r.body,/attacker\.example/);
});
test('staging can opt out of indexing without advertising public URLs',async()=>{
 const r=await response('/',{indexable:false});assert.equal(r.headers['x-robots-tag'],'noindex');assert.match(r.body,/noindex,nofollow/);
 assert.match((await response('/robots.txt',{indexable:false})).body,/Disallow: \//);
 assert.doesNotMatch((await response('/sitemap.xml',{indexable:false})).body,/<loc>/);
});
test('private and unknown routes are never served by the public handler',async()=>{
 for(const path of ['/assistant','/signup','/login','/setup','/api/jobs','/api/applicants','/data/resumes/example.pdf','/assets/../server.js','/public/home.html','/unknown'])assert.equal((await response(path)).handled,false,path);
 assert.equal((await response('/',{},'POST')).handled,false);
});
test('HEAD has the same metadata without a response body',async()=>{
 const r=await response('/',{},'HEAD');assert.equal(r.status,200);assert.equal(r.body,'');assert.equal(r.headers['x-robots-tag'],'index, follow');
});
test('stylesheet is served without remote fonts, imports or scripts',async()=>{
 const r=await response('/assets/marketing.css');assert.equal(r.status,200);assert.match(r.headers['content-type'],/text\/css/);assert.doesNotMatch(r.body,/@import|https?:\/\//);assert.match(r.body,/prefers-reduced-motion/);assert.match(r.body,/:focus-visible/);
});
