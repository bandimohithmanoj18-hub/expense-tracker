const CACHE='spendwise-shell-v3';
const SHELL=['/','/styles.css','/app.js','/favicon.svg','/manifest.webmanifest','/icons/apple-touch-icon.png','/icons/spendwise-192.png','/icons/spendwise-512.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key))))));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(url.origin!==location.origin||url.pathname.startsWith('/api/'))return;
  event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request).then(response=>{
    if(response.ok&&event.request.method==='GET')caches.open(CACHE).then(cache=>cache.put(event.request,response.clone()));
    return response;
  }).catch(()=>event.request.mode==='navigate'?caches.match('/'):Promise.reject(new Error('Offline')))));
});
