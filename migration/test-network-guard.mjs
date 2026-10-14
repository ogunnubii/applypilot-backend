// Test-only preload. Existing tests may replace fetch with their own fixtures.
// The underlying network fetch can reach only synthetic loopback API servers.
const networkFetch=globalThis.fetch;
globalThis.fetch=(input,options)=>{
 const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
 if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('External network fetch is disabled in migration regression tests');
 return networkFetch(input,options);
};
