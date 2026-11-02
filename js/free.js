// Free, legal games: a built-in list of official free sources (data/free-sources.json) plus a
// "what's live right now" file (free-now.json) that a scheduled job refreshes every ~15 minutes.
// Only rights holders' own free streams and licensed free services are listed.

const CATALOG_URL = 'data/free-sources.json';

/**
 * Where the live list comes from, in order:
 * 1. the local helper (npm start) checks on demand at /api/free-now
 * 2. a github.io site reads the file the scheduled job publishes to the repo's "free-now" branch
 * 3. a copy deployed next to the site
 */
function liveUrls() {
  const urls = [];
  if (location.protocol.startsWith('http')) urls.push(new URL('api/free-now', location.href).href);
  const gh = /^([\w-]+)\.github\.io$/i.exec(location.hostname);
  const repo = location.pathname.split('/').filter(Boolean)[0];
  if (gh && repo) urls.push(`https://raw.githubusercontent.com/${gh[1]}/${repo}/free-now/free-now.json`);
  urls.push(new URL('data/free-now.json', location.href).href);
  return urls;
}

async function getJson(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    // 'no-cache' revalidates (a cheap 304) instead of reusing an old copy; no custom headers, so no preflight.
    const r = await fetch(url, { signal: ctl.signal, cache: 'no-cache' });
    if (!r.ok || !/json|text\/plain/.test(r.headers.get('content-type') || '')) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function loadCatalog() {
  const data = await getJson(new URL(CATALOG_URL, location.href).href, 6000);
  return Array.isArray(data?.sources) ? data.sources : [];
}

/** What's live (or about to start) on the catalog's YouTube channels. Never throws. */
export async function loadFreeNow() {
  for (const url of liveUrls()) {
    // The local helper's first check of every channel can take a while after it starts.
    const data = await getJson(url, /\/api\/free-now$/.test(url) ? 30000 : 6000);
    if (data && Array.isArray(data.live)) {
      // Ignore a stale file (the job stopped running): nothing in it can be trusted as live.
      const age = Date.now() - new Date(data.updatedAt || 0).getTime();
      if (!(age < 3 * 3600e3)) return { live: [], updatedAt: data.updatedAt || null, stale: true, from: url };
      const blocked = data.checked > 0 && (data.errors || []).length >= data.checked;
      return { live: data.live.filter((x) => /^[\w-]{11}$/.test(x.videoId || '')), updatedAt: data.updatedAt, stale: false, blocked, from: url };
    }
  }
  return { live: [], updatedAt: null, stale: false, missing: true, from: null };
}

export const watchUrl = (videoId) => `https://www.youtube.com/watch?v=${videoId}`;
