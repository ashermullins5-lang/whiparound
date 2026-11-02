#!/usr/bin/env node
// Whiparound local server. No dependencies; needs Node 18 or newer.
//
//   npm start                 serve on http://localhost:8080 (this computer only)
//   npm run lan               also reachable from your iPad/phone/TV on the same Wi-Fi
//   node dev-server.cjs --port 9000
//   npm run paid              same, plus the paid version's /api (reads keys from .env)
//
// Besides serving the app it relays streams and scoreboards that block browsers (CORS):
//   GET /proxy?url=<http(s) url>        fetch and pass through; HLS playlists are rewritten
//                                       so their segments also go through the relay
//   GET /proxy?raw=1&url=<url>          pass through without rewriting (M3U channel lists, JSON)
//   GET /api/health                     lets the app know the relay is available
//   GET /api/youtube-live?url=<channel> finds the video a YouTube channel is streaming live right now

'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Readable } = require('node:stream');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : dflt;
};
const PORT = Number(opt('--port', process.env.PORT || 8080));
const HOST = flag('--lan') ? '0.0.0.0' : opt('--host', '127.0.0.1');
const ROOT = __dirname;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
// Only ever contacts YouTube. Overridable so tests can point it at a local fake.
const YT_ORIGIN = process.env.WHIP_YOUTUBE_ORIGIN || 'https://www.youtube.com';
const YT_CACHE_MS = Number(process.env.WHIP_YOUTUBE_CACHE_MS || 30000); // shared by every tile following a channel

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, 'Bad path');
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) return send(res, 403, 'Forbidden');
  if (path.basename(file).startsWith('.') || file.includes(`${path.sep}node_modules${path.sep}`)) return send(res, 404, 'Not found');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const isPlaylist = (url, type, firstBytes) =>
  /mpegurl/i.test(type || '') || /\.m3u8(\?|$)/i.test(url) || (firstBytes || '').startsWith('#EXTM3U');

/** Rewrite every URI in an HLS playlist so it is fetched through this relay. */
function rewritePlaylist(text, baseUrl) {
  const wrap = (u) => {
    try {
      return `proxy?url=${encodeURIComponent(new URL(u, baseUrl).href)}`;
    } catch {
      return u;
    }
  };
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_m, u) => `URI="${wrap(u)}"`);
      return wrap(t);
    })
    .join('\n');
}

// ---------- YouTube channel → current live video ----------

/** "/@handle/live" for a youtube.com channel link, or null if it isn't one. */
function channelLivePath(link) {
  let u;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || !/^(www\.|m\.)?youtube\.com$/i.test(u.hostname)) return null;
  const m = /^\/(@[^/?#\s]{2,}|channel\/UC[\w-]{22}|c\/[\w.-]+|user\/[\w.-]+|[\w.-]+)(?:\/(?:live|streams|featured))?\/?$/u.exec(
    decodeURIComponent(u.pathname)
  );
  if (!m) return null;
  return `/${m[1].split('/').map(encodeURIComponent).join('/')}/live`;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" };
const decodeHtml = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
    {
      if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
  );

/** Pull a JSON object assigned in a page script (e.g. `var ytInitialPlayerResponse = {...};`) with a brace-balanced scan. */
function extractJson(html, name) {
  const starts = [
    new RegExp(`var\\s+${name}\\s*=\\s*\\{`),
    new RegExp(`window\\[["']${name}["']\\]\\s*=\\s*\\{`),
    new RegExp(`${name}\\s*=\\s*\\{`),
  ];
  for (const re of starts) {
    const m = re.exec(html);
    if (!m) continue;
    const from = m.index + m[0].length - 1;
    let depth = 0;
    let inStr = false;
    for (let i = from; i < html.length; i++) {
      const c = html[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          return JSON.parse(html.slice(from, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

/**
 * Read a youtube.com/<channel>/live page. While a channel is live (or has a stream scheduled),
 * YouTube serves that video's watch page at /live; otherwise it serves the channel page.
 * Channel pages also mention other videos and other channels, so we only trust the canonical
 * link and this page's own player data, never the first "isLive" or "channelId" in the HTML.
 */
function parseYouTubeLive(html) {
  if (/<title>\s*Before you continue to YouTube|action="https:\/\/consent\.youtube\.com\//.test(html)) return { consent: true };
  const canonical = /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1] || '';
  const ogUrl = /<meta property="og:url" content="([^"]+)"/.exec(html)?.[1] || '';
  const isChannelPage = /youtube\.com\/(channel\/|@|c\/|user\/)/.test(canonical);
  const player = extractJson(html, 'ytInitialPlayerResponse');
  const data = isChannelPage || !player ? extractJson(html, 'ytInitialData') : null;
  const vd = player?.videoDetails || {};
  const lbd = player?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails;
  const status = player?.playabilityStatus?.status;

  let videoId = /[?&]v=([\w-]{11})/.exec(canonical)?.[1] || null;
  if (!videoId && !isChannelPage && !data?.metadata?.channelMetadataRenderer) {
    videoId = vd.videoId || data?.currentVideoEndpoint?.watchEndpoint?.videoId || null;
  }

  let live = false;
  let upcoming = false;
  if (videoId && player && vd.videoId === videoId) {
    upcoming = vd.isUpcoming === true || status === 'LIVE_STREAM_OFFLINE';
    live = !upcoming && (vd.isLive === true || lbd?.isLiveNow === true) && lbd?.isLiveNow !== false && !lbd?.endTimestamp;
  } else if (videoId) {
    // Couldn't read the player data (YouTube changed its markup). A watch page under /live is
    // almost always the live or scheduled stream; use the plain flags as a hint.
    upcoming = /"isUpcoming":true|LIVE_STREAM_OFFLINE|"upcomingEventData":\{/.test(html);
    live = !upcoming && !/"isLiveNow":false/.test(html);
  }

  const channelId =
    /\/channel\/(UC[\w-]{22})/.exec(canonical)?.[1] ||
    /\/channel\/(UC[\w-]{22})/.exec(ogUrl)?.[1] ||
    data?.metadata?.channelMetadataRenderer?.externalId ||
    (videoId && vd.videoId === videoId ? vd.channelId : null) ||
    /<meta itemprop="(?:channelId|identifier)" content="(UC[\w-]{22})"/.exec(html)?.[1] ||
    null;
  const rawTitle =
    (videoId && vd.videoId === videoId && vd.title) ||
    /<meta name="title" content="([^"]*)"/.exec(html)?.[1] ||
    /<meta property="og:title" content="([^"]*)"/.exec(html)?.[1] ||
    (/<title>([^<]*)<\/title>/.exec(html)?.[1] || '').replace(/\s*-\s*YouTube\s*$/, '');
  const out = {
    videoId,
    live,
    upcoming,
    // false when the channel turned off playing on other sites; unknown counts as playable
    embeddable: player?.playabilityStatus?.playableInEmbed !== false,
    channelId: channelId && /^UC[\w-]{22}$/.test(channelId) ? channelId : null,
    title: decodeHtml(String(rawTitle)).trim().slice(0, 300),
  };
  // "Sign in to confirm you're not a bot": the server was refused, but the browser's embed may still play.
  if (status === 'LOGIN_REQUIRED') out.blocked = true;
  return out;
}

/** GET a youtube.com page, following at most 3 redirects and only within youtube.com. Caps the body at 8 MB. */
async function fetchYouTube(path) {
  let url = new URL(path + (path.includes('?') ? '&' : '?') + 'hl=en', YT_ORIGIN);
  for (let hop = 0; hop < 4; hop++) {
    const r = await fetch(url, {
      redirect: 'manual',
      headers: {
        'User-Agent': CHROME_UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: 'SOCS=CAI; CONSENT=YES+cb',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      const next = new URL(r.headers.get('location'), url);
      if (/^consent\.youtube\.com$|^accounts\.google\.com$/i.test(next.hostname)) return { consent: true };
      const sameSite = next.origin === new URL(YT_ORIGIN).origin || /^(www\.|m\.)?youtube\.com$/i.test(next.hostname);
      if (!sameSite || !/^https?:$/.test(next.protocol)) throw new Error('YouTube redirected somewhere unexpected');
      // Rebase onto YT_ORIGIN by setting fields, never by re-parsing a path (a "//host" path would escape).
      const rebased = new URL(YT_ORIGIN);
      rebased.pathname = next.pathname.replace(/^\/+/, '/');
      rebased.search = next.search;
      if (rebased.origin !== new URL(YT_ORIGIN).origin) throw new Error('YouTube redirected somewhere unexpected');
      url = rebased;
      continue;
    }
    if (!r.body) return { status: r.status, html: '' };
    const chunks = [];
    let size = 0;
    for await (const chunk of r.body) {
      size += chunk.length;
      if (size > 8_000_000) break;
      chunks.push(chunk);
    }
    return { status: r.status, html: Buffer.concat(chunks).toString('utf8') };
  }
  throw new Error('Too many redirects');
}

const ytCache = new Map(); // path -> { at, status, body }

// ---------- Free, legal games: which official free channels are live right now ----------

const YT_API = process.env.WHIP_YOUTUBE_API_ORIGIN || 'https://www.googleapis.com';

/**
 * YouTube Data API fallback for channels that bot-checked the page lookup. Costs about 2 quota
 * units per channel (uploads playlist + one videos call), well within the free daily quota.
 */
async function apiLiveCheck(src, key) {
  const get = async (path) => {
    const r = await fetch(`${YT_API}/youtube/v3/${path}&key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`YouTube API ${r.status}`);
    return r.json();
  };
  const uploads = 'UU' + src.youtubeChannelId.slice(2);
  const list = await get(`playlistItems?part=contentDetails&maxResults=15&playlistId=${uploads}`);
  const ids = (list.items || []).map((i) => i.contentDetails?.videoId).filter(Boolean);
  if (!ids.length) return null;
  const vids = await get(`videos?part=snippet,liveStreamingDetails,status&id=${ids.join(',')}`);
  const soon = Date.now() + 3 * 3600e3;
  const pick =
    (vids.items || []).find((v) => v.snippet?.liveBroadcastContent === 'live') ||
    (vids.items || [])
      .filter((v) => v.snippet?.liveBroadcastContent === 'upcoming' && new Date(v.liveStreamingDetails?.scheduledStartTime || 0).getTime() < soon)
      .sort((a, b) => new Date(a.liveStreamingDetails.scheduledStartTime) - new Date(b.liveStreamingDetails.scheduledStartTime))[0];
  if (!pick) return { none: true };
  return {
    videoId: pick.id,
    title: pick.snippet?.title || '',
    live: pick.snippet.liveBroadcastContent === 'live',
    upcoming: pick.snippet.liveBroadcastContent === 'upcoming',
    embeddable: pick.status?.embeddable !== false,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Check each YouTube channel in the free-sources catalog and list the ones that are live or about
 * to start. Used by /api/free-now here and by scripts/free-now.mjs in the scheduled job.
 */
async function checkFreeNow(sources, { gapMs = 1500, retryMs = 6000, prev = null, apiKey = '', log = () => {} } = {}) {
  const live = [];
  const errors = [];
  const blocked = [];
  const channels = sources.filter((s) => s.kind === 'youtube' && /^UC[\w-]{22}$/.test(s.youtubeChannelId || ''));
  const look = async (src) => {
    const r = await fetchYouTube(`/channel/${src.youtubeChannelId}/live`);
    if (r.consent) throw new Error('consent page');
    if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
    const info = parseYouTubeLive(r.html || '');
    if (info.consent) throw new Error('consent page');
    return info;
  };
  // A stream the previous check saw in the last 45 minutes, for channels YouTube won't show us now.
  const prevFresh = prev && Date.now() - new Date(prev.updatedAt).getTime() < 45 * 60e3 ? prev.live || [] : [];
  for (const [i, src] of channels.entries()) {
    if (i) await sleep(gapMs); // polite: one request at a time
    try {
      let info = await look(src);
      if (info.blocked && !info.videoId) {
        await sleep(retryMs); // YouTube's bot check is per request; one retry often gets through
        info = await look(src);
      }
      if (info.blocked && !info.videoId && apiKey) {
        try {
          const viaApi = await apiLiveCheck(src, apiKey);
          if (viaApi?.none) {
            log(`${src.name}: not live (via YouTube API)`);
            continue;
          }
          if (viaApi) info = { ...viaApi, blocked: false };
        } catch (e) {
          log(`${src.name}: YouTube API failed (${e.message})`);
        }
      }
      if (info.blocked && !info.videoId) {
        blocked.push(src.id);
        const carried = prevFresh.find((x) => x.sourceId === src.id);
        log(`${src.name}: bot check${carried ? ', keeping the last result' : ''}`);
        if (carried) live.push({ ...carried, carried: true });
        continue;
      }
      // YouTube sometimes answers a server with a "confirm you're not a bot" page. It still names
      // the video, and /live only serves a video while the channel is live or about to go live,
      // so that counts as on air. (People's own browsers play it normally.)
      const onAir = !!(info.blocked && info.videoId && !info.live && !info.upcoming);
      const status = info.live ? 'live' : onAir ? 'onair' : info.upcoming ? 'upcoming' : null;
      log(`${src.name}: ${status || 'not live'}${info.blocked ? ' (bot check)' : ''}`);
      if (info.videoId && status) {
        const title = info.title && !/^youtube$/i.test(info.title) ? info.title : `${src.name} live stream`;
        live.push({ sourceId: src.id, source: src.name, sports: src.sports || [], videoId: info.videoId, title, status, embeddable: info.embeddable });
      }
    } catch (e) {
      errors.push({ sourceId: src.id, error: String(e.message || e) });
      log(`${src.name}: error ${e.message || e}`);
    }
  }
  return { updatedAt: new Date().toISOString(), live, errors, blocked, checked: channels.length };
}

// The helper checks in the background (at start, then every 10 minutes) and answers instantly
// with the latest result, so opening the app never waits on a full round of checks.
let freeNowLatest = null;
let freeNowRun = null;
function refreshFreeNow() {
  if (freeNowRun) return freeNowRun;
  let sources = [];
  try {
    sources = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'free-sources.json'), 'utf8')).sources || [];
  } catch {
    return Promise.resolve(null);
  }
  freeNowRun = checkFreeNow(sources, { gapMs: 600 })
    .then((body) => (freeNowLatest = body))
    .catch(() => freeNowLatest)
    .finally(() => (freeNowRun = null));
  return freeNowRun;
}
async function freeNow(req, res) {
  const out = (code, obj) =>
    send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
  const stale = !freeNowLatest || Date.now() - new Date(freeNowLatest.updatedAt).getTime() > 10 * 60e3;
  if (stale) refreshFreeNow();
  // First run after start: wait for it (the app allows for that); later, answer at once.
  const body = freeNowLatest || (await refreshFreeNow());
  if (!body) return out(404, { error: 'No free-sources catalog' });
  return out(200, body);
}

async function youtubeLive(req, res, params) {
  const json = (code, obj) => send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  const path = channelLivePath(params.get('url') || '');
  if (!path) return json(400, { error: "That isn't a YouTube channel link." });
  const hit = ytCache.get(path);
  if (hit && Date.now() - hit.at < YT_CACHE_MS) return json(hit.status, hit.body);
  let status = 200;
  let body;
  try {
    const r = await fetchYouTube(path);
    const parsed = r.consent ? { consent: true } : r.status === 404 ? null : r.status >= 400 ? undefined : parseYouTubeLive(r.html);
    if (parsed?.consent) {
      status = 502;
      body = { error: 'YouTube showed a cookie-consent page instead of the channel. Paste the live video link instead.' };
    } else if (parsed === null) {
      status = 404;
      body = { error: "YouTube couldn't find that channel. Check the link." };
    } else if (parsed === undefined) {
      status = 502;
      body = { error: `YouTube answered ${r.status}. Trying again in a minute.` };
    } else if (!parsed.videoId && !parsed.channelId) {
      status = 502;
      body = { error: "Couldn't read the channel page. YouTube may be blocking automated requests from this network; paste the live video link instead." };
    } else {
      body = parsed;
    }
  } catch (e) {
    status = 502;
    body = { error: `Couldn't reach YouTube: ${e.cause?.code || e.message}` };
  }
  if (ytCache.size > 200) ytCache.clear();
  ytCache.set(path, { at: Date.now(), status, body });
  return json(status, body);
}

async function proxy(req, res, params) {
  const target = params.get('url');
  const raw = params.get('raw') === '1';
  let url;
  try {
    url = new URL(target);
  } catch {
    return send(res, 400, 'Missing or invalid url');
  }
  if (!/^https?:$/.test(url.protocol)) return send(res, 400, 'Only http and https links can be relayed');

  const headers = { 'User-Agent': req.headers['user-agent'] || UA, Accept: '*/*' };
  if (req.headers.range) headers.Range = req.headers.range;
  const ctl = new AbortController();
  req.on('close', () => ctl.abort());
  let up;
  try {
    up = await fetch(url, { headers, redirect: 'follow', signal: ctl.signal });
  } catch (e) {
    if (ctl.signal.aborted) return;
    return send(res, 502, `Could not reach ${url.host}: ${e.cause?.code || e.message}`, { 'Access-Control-Allow-Origin': '*' });
  }
  const type = up.headers.get('content-type') || '';
  const out = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'Content-Type': type || 'application/octet-stream',
  };
  for (const h of ['content-range', 'accept-ranges', 'last-modified']) {
    const v = up.headers.get(h);
    if (v) out[h] = v;
  }

  const finalUrl = up.url || url.href;
  const small = Number(up.headers.get('content-length') || 0) < 2_000_000;
  const maybePlaylist =
    isPlaylist(finalUrl, type) || (small && /text|octet|mpegurl/i.test(type) && /\.m3u8?|playlist|manifest|index/i.test(finalUrl));
  if (!raw && maybePlaylist) {
    // Buffer it, but only rewrite when it really is a playlist; anything else goes out byte-for-byte.
    const buf = Buffer.from(await up.arrayBuffer().catch(() => new ArrayBuffer(0)));
    if (buf.subarray(0, 16).toString('utf8').replace(/^﻿/, '').startsWith('#EXTM3U')) {
      const body = rewritePlaylist(buf.toString('utf8').replace(/^﻿/, ''), finalUrl);
      out['Content-Type'] = 'application/vnd.apple.mpegurl';
      res.writeHead(up.status, out);
      return res.end(body);
    }
    out['Content-Length'] = buf.length;
    res.writeHead(up.status, out);
    return res.end(buf);
  }

  const len = up.headers.get('content-length');
  if (len) out['Content-Length'] = len;
  res.writeHead(up.status, out);
  if (!up.body) return res.end();
  const stream = Readable.fromWeb(up.body);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

// The paid version's /api endpoints (the same files Vercel runs). Without their keys in the
// environment, /api/config answers { paywall: false } and the app stays fully unlocked.
async function runPaidApi(name, req, res) {
  let mod;
  try {
    mod = await import(require('node:url').pathToFileURL(path.join(ROOT, 'api', `${name}.js`)).href);
  } catch {
    return send(res, 404, 'Not found'); // e.g. `npm install` hasn't been run
  }
  const handler = mod[req.method];
  if (!handler) return send(res, 405, 'Method not allowed');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  const request = new Request(`http://${req.headers.host || 'localhost'}${req.url}`, {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const response = await handler(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

const server = http.createServer((req, res) => {
  let u;
  try {
    u = new URL(req.url, 'http://localhost');
  } catch {
    return send(res, 400, 'Bad request');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range' });
    return res.end();
  }
  // The paid API takes POSTs (checkout, portal, Stripe webhooks), so route it before the GET-only check.
  const paidApi = /^\/api\/(config|me|checkout|portal|stripe-webhook|scores)$/.exec(u.pathname);
  if (paidApi) return void runPaidApi(paidApi[1], req, res).catch((e) => {
    if (!res.headersSent) send(res, 500, String(e?.message || e));
  });
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  if (u.pathname.endsWith('/api/health')) {
    return send(res, 200, JSON.stringify({ ok: true, proxy: true }), { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  }
  if (u.pathname.endsWith('/api/free-now')) return void freeNow(req, res).catch((e) => {
    if (!res.headersSent) send(res, 500, String(e?.message || e));
  });
  if (u.pathname.endsWith('/api/youtube-live')) return void youtubeLive(req, res, u.searchParams).catch((e) => {
    if (!res.headersSent) send(res, 500, String(e?.message || e));
  });
  if (u.pathname.endsWith('/proxy')) return void proxy(req, res, u.searchParams).catch((e) => {
    if (!res.headersSent) send(res, 500, String(e?.message || e));
    else res.destroy();
  });
  serveStatic(req, res, u.pathname);
});

module.exports = { parseYouTubeLive, channelLivePath, rewritePlaylist, fetchYouTube, checkFreeNow, server };

if (require.main === module) setTimeout(refreshFreeNow, 500);
if (require.main === module) server.listen(PORT, HOST, () => {
  console.log(`\n  Whiparound is running\n`);
  console.log(`  On this computer:  http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) {
        if (a.family === 'IPv4' && !a.internal) console.log(`  On your Wi-Fi:      http://${a.address}:${PORT}`);
      }
    }
  } else {
    console.log(`  (Add --lan to open it from an iPad, phone or TV browser on the same Wi-Fi.)`);
  }
  console.log(`  Demo:              http://localhost:${PORT}/?demo\n`);
});
