const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{JSDOM}=require('jsdom');
test('Remembered login is opt-in, restores new tabs, and clears on sign-out',()=>{
 const source=fs.readFileSync(new URL('../assistant-client.js','file://'+__filename.replaceAll('\\','/')),'utf8').split('const $=')[0];
 const dom=new JSDOM('<form><button>Login</button></form>',{url:'https://applypilot-jobs.netlify.app',runScripts:'outside-only'}),w=dom.window;w.eval(source);
 assert.equal(w.rememberOption(w.document.querySelector('form')).checked,false);
 w.saveSession('fixture',false);assert.equal(w.localStorage.getItem('applypilot-remembered-token'),null);
 w.saveSession('remembered',true);w.sessionStorage.clear();assert.equal(w.restoreSession(),'remembered');assert.equal(w.sessionStorage.getItem('applypilot-token'),'remembered');
 w.clearSession();assert.equal(w.restoreSession(),'');dom.window.close();
});
test('Remembered tokens expire after 30 days; ordinary sign-in stays at 12 hours',async()=>{
 process.env.SESSION_SECRET='fixture-secret-with-at-least-thirty-two-characters';const {issueToken,readToken}=await import('../auth.js');
 const before=Date.now(),normal=issueToken('fixture'),remembered=issueToken('fixture',true);const expiry=t=>JSON.parse(Buffer.from(t.split('.')[0],'base64url')).expires;
 assert(Math.abs(expiry(normal)-before-12*3600000)<1000);assert(Math.abs(expiry(remembered)-before-30*24*3600000)<1000);assert.equal(readToken(remembered),'fixture');assert.equal(readToken(remembered+'bad'),null);
});
