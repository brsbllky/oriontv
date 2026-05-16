const CACHE = 'glyph-v3';
const SHELL = ['./index.html', './manifest.json', './app_icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  if (url.pathname === '/sw-hls') {
    e.respondWith(hlsProxy(url));
    return;
  }

  if (url.hostname === 'cdnjs.cloudflare.com') {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(resp => {
          if (resp.ok) caches.open(CACHE).then(c => c.put(e.request, resp.clone()));
          return resp;
        }).catch(() => caches.match(e.request));
      })
    );
    return;
  }

  if (url.origin === location.origin) {
    e.respondWith(caches.match(e.request).then(c => c || fetch(e.request)));
  }
});

async function hlsProxy(url) {
  const targetUrl = url.searchParams.get('url');
  const cfProxy   = url.searchParams.get('cf')  || '';
  const referer   = url.searchParams.get('ref') || '';

  if (!targetUrl) return new Response('Missing url', { status: 400 });

  try {
    let fetchUrl = targetUrl;
    const opts   = { signal: AbortSignal.timeout(22000) };

    if (cfProxy) {
      fetchUrl = cfProxy + '/proxy?url=' + encodeURIComponent(targetUrl);
      if (referer) fetchUrl += '&referer=' + encodeURIComponent(referer);
    } else if (referer) {
      opts.headers = { 'Referer': referer };
    }

    const resp = await fetch(fetchUrl, opts);
    const ct   = resp.headers.get('content-type') || '';

    const looksM3U8 = /mpegurl|m3u/i.test(ct)
      || /\.m3u8?(\?|$)/i.test(targetUrl)
      || /\/live\//i.test(targetUrl)
      || (/\/get\.php/i.test(targetUrl) && targetUrl.includes('type=m3u'));

    if (looksM3U8 && resp.ok) {
      const text = await resp.text();
      if (text.includes('#EXT')) {
        const scope     = self.registration.scope.replace(/\/$/, '');
        const rewritten = rewriteM3U8(text, targetUrl, scope, cfProxy, referer);
        return new Response(rewritten, {
          headers: {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store, no-cache',
          }
        });
      }
    }

    if (resp.ok) {
      const body = await resp.arrayBuffer();
      return new Response(body, {
        headers: {
          'Content-Type': ct || 'video/MP2T',
          'Access-Control-Allow-Origin': '*',
        }
      });
    }

    throw new Error('HTTP ' + resp.status);

  } catch (err) {
    return new Response('SW Proxy Error: ' + err.message, {
      status: 502,
      headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' }
    });
  }
}

function rewriteM3U8(text, baseUrl, scope, cfProxy, referer) {
  let base;
  try { base = new URL(baseUrl); } catch { return text; }
  const baseDir = base.href.substring(0, base.href.lastIndexOf('/') + 1);

  return text.split('\n').map(line => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_, uri) =>
        'URI="' + buildProxyUrl(resolve(uri, base, baseDir), scope, cfProxy, referer) + '"'
      );
    }
    return buildProxyUrl(resolve(t, base, baseDir), scope, cfProxy, referer);
  }).join('\n');
}

function resolve(uri, base, baseDir) {
  if (/^https?:\/\//i.test(uri)) return uri;
  if (uri.startsWith('//'))      return base.protocol + uri;
  if (uri.startsWith('/'))       return base.origin + uri;
  return baseDir + uri;
}

function buildProxyUrl(url, scope, cfProxy, referer) {
  let p = scope + '/sw-hls?url=' + encodeURIComponent(url);
  if (cfProxy) p += '&cf='  + encodeURIComponent(cfProxy);
  if (referer) p += '&ref=' + encodeURIComponent(referer);
  return p;
}
