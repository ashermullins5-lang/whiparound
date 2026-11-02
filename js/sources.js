// Stream sources: link type detection, M3U playlist parsing, and matching channels to games.

import { uid } from './util.js';

export const KIND_LABEL = {
  hls: 'HLS stream',
  mpegts: 'MPEG-TS stream',
  file: 'Video file',
  youtube: 'YouTube',
  ytlive: 'YouTube channel, live',
  twitch: 'Twitch',
  embed: 'Web page',
  auto: 'Stream',
  demo: 'Demo feed',
  dash: 'DASH (not supported)',
};

export function youtubeId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\.|^m\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'music.youtube.com') {
      if (u.searchParams.get('v')) return u.searchParams.get('v');
      const m = /^\/(?:live|embed|shorts|v)\/([\w-]{6,})/.exec(u.pathname);
      if (m && m[1] === 'live_stream') return null;
      if (m) return m[1];
    }
  } catch {}
  return null;
}

// First path segments that are YouTube pages, not channel names.
const YT_RESERVED = new Set([
  'watch', 'live', 'embed', 'shorts', 'v', 'e', 'playlist', 'results', 'feed', 'channel', 'c', 'user', 'redirect',
  'signin', 'logout', 'premium', 'gaming', 'music', 'kids', 'account', 'about', 'hashtag', 'post', 'source', 't',
  'attribution_link', 'oembed', 'iframe_api', 'supported_browsers', 'new', 'upload', 'howyoutubeworks', 'creators',
  'ads', 'api', 's', 'yt', 'sw.js', 'favicon.ico', 'robots.txt', 'clip', 'trending', 'store', 'premium_benefits',
  'w', 'watch_popup', 'movies', 'search', 'shared', 'explore', 'feeds', 'browse', 'youtubei',
]);
const CHANNEL_TABS = new Set(['live', 'streams', 'featured']);

/**
 * A YouTube channel link that should play whatever the channel is streaming live:
 *   youtube.com/@handle[/live|/streams], youtube.com/channel/UC…[/live], youtube.com/c/name[/live],
 *   youtube.com/user/name[/live], and legacy custom links like youtube.com/thefieldof68[/live].
 * Returns { handle?, channelId?, name?, path, liveUrl } or null.
 */
export function youtubeChannel(url) {
  let u;
  try {
    u = new URL(String(url).trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
  if (host !== 'youtube.com' || !/^https?:$/.test(u.protocol)) return null;
  let parts;
  try {
    parts = u.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  } catch {
    return null;
  }
  if (!parts.length) return null;
  // YouTube's own "embed whatever this channel is streaming" link
  if (parts[0] === 'embed' && parts[1] === 'live_stream') {
    const id = u.searchParams.get('channel') || '';
    return /^UC[\w-]{22}$/.test(id) ? { channelId: id, path: `/channel/${id}`, liveUrl: `https://www.youtube.com/channel/${id}/live` } : null;
  }
  let ref;
  let rest;
  const first = parts[0];
  if (/^@[\w.\-·]{2,}$/u.test(first)) {
    ref = { handle: first, path: `/${first}` };
    rest = parts.slice(1);
  } else if (first === 'channel' && /^UC[\w-]{22}$/.test(parts[1] || '')) {
    ref = { channelId: parts[1], path: `/channel/${parts[1]}` };
    rest = parts.slice(2);
  } else if ((first === 'c' || first === 'user') && /^[\w.-]+$/.test(parts[1] || '')) {
    ref = { name: parts[1], path: `/${first}/${parts[1]}` };
    rest = parts.slice(2);
  } else if (!YT_RESERVED.has(first.toLowerCase()) && /^[\w.-]+$/.test(first)) {
    ref = { name: first, path: `/${first}` };
    rest = parts.slice(1);
  } else {
    return null;
  }
  // The channel home or its live/streams tab means "play live". /videos, /shorts etc. don't.
  if (rest.length > 1 || (rest[0] && !CHANNEL_TABS.has(rest[0].toLowerCase()))) return null;
  return { ...ref, liveUrl: `https://www.youtube.com${ref.path}/live` };
}

export function twitchTarget(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\.|^m\./, '');
    if (host !== 'twitch.tv') return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'videos' && parts[1]) return { video: parts[1] };
    if (parts[0] && !['directory', 'p', 'settings'].includes(parts[0])) return { channel: parts[0] };
  } catch {}
  return null;
}

export function detectKind(url) {
  const raw = String(url || '').trim();
  if (raw.startsWith('demo:')) return 'demo';
  if (youtubeId(raw)) return 'youtube';
  if (youtubeChannel(raw)) return 'ytlive';
  if (twitchTarget(raw)) return 'twitch';
  let path = raw.toLowerCase();
  try {
    path = new URL(raw).pathname.toLowerCase();
  } catch {}
  if (/\.m3u8?$/.test(path) || /\/(index|playlist|master)\.m3u8/.test(path) || /[?&](type|format)=m3u8/i.test(raw)) return 'hls';
  if (/\.mpd$/.test(path)) return 'dash';
  if (/\.(ts|flv)$/.test(path)) return 'mpegts';
  if (/\.(mp4|m4v|webm|mov|ogv|mkv)$/.test(path)) return 'file';
  if (/\.(html?|php|aspx?)$/.test(path)) return 'embed';
  return 'auto';
}

export function isLikelyUrl(s) {
  return /^(https?:\/\/|demo:)/i.test(String(s || '').trim());
}

export function makeSource({ name, url, network = '', group = '', logo = '', playlist = '' }) {
  const clean = String(url).trim();
  return {
    id: uid('src'),
    name: (name || '').trim() || guessName(clean),
    url: clean,
    kind: detectKind(clean),
    network: network.trim(),
    group: group.trim(),
    logo: logo.trim(),
    playlist,
    addedAt: Date.now(),
  };
}

function guessName(url) {
  const yt = youtubeId(url);
  if (yt) return `YouTube ${yt}`;
  const ch = youtubeChannel(url);
  if (ch) return `${ch.handle || ch.name || ch.channelId} (live)`;
  const tw = twitchTarget(url);
  if (tw) return tw.channel ? `Twitch: ${tw.channel}` : `Twitch video ${tw.video}`;
  try {
    const u = new URL(url);
    const file = u.pathname.split('/').filter(Boolean).pop() || '';
    return `${u.hostname}${file ? ' · ' + decodeURIComponent(file) : ''}`;
  } catch {
    return url.slice(0, 40);
  }
}

/**
 * Parse an extended M3U playlist (IPTV, Channels DVR, Plex, Jellyfin, HDHomeRun exports).
 * Returns [{name, url, group, logo, tvgId}]
 */
export function parseM3U(text, { limit = 25000 } = {}) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const out = [];
  let pending = null;
  let groupOverride = '';
  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      const attrRe = /([\w-]+)="([^"]*)"/g;
      let m;
      const head = line.slice(0, findTitleComma(line));
      while ((m = attrRe.exec(head))) attrs[m[1].toLowerCase()] = m[2];
      const title = line.slice(findTitleComma(line) + 1).trim();
      pending = {
        name: title || attrs['tvg-name'] || 'Channel',
        group: attrs['group-title'] || '',
        logo: attrs['tvg-logo'] || '',
        tvgId: attrs['tvg-id'] || '',
        chno: attrs['tvg-chno'] || attrs['channel-number'] || '',
      };
      groupOverride = '';
      continue;
    }
    if (line.startsWith('#EXTGRP:')) {
      groupOverride = line.slice(8).trim();
      continue;
    }
    if (line.startsWith('#')) continue;
    // A URI line.
    if (!/^(https?|rtmp|rtsp|udp|rtp):\/\//i.test(line)) {
      pending = null;
      continue;
    }
    const entry = pending || { name: guessName(line), group: '', logo: '', tvgId: '', chno: '' };
    if (groupOverride && !entry.group) entry.group = groupOverride;
    entry.url = line;
    out.push(entry);
    pending = null;
    groupOverride = '';
    if (out.length >= limit) break;
  }
  return out;
}

// The comma that separates attributes from the title is the first comma outside quotes.
function findTitleComma(line) {
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === ',' && !inQ) return i;
  }
  return line.length;
}

// ---------- Matching channels to games ----------

const NOISE = /\b(hd|fhd|uhd|sd|4k|hevc|h265|east|west|us|usa|uk|ca|live|tv|channel|network|net|backup|alt|\d{3,4}p)\b/g;

export function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/^[a-z]{2,3}\s*[:|]\s*/, '') // "US: ", "UK | "
    .replace(/[^a-z0-9+&]+/g, ' ')
    .replace(NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const tokens = (s) => normName(s).split(' ').filter(Boolean);

/**
 * Rank library sources for a game.
 * - remembered: the user already picked this source for this game
 * - team: the channel name mentions a team (event channels, YouTube titles)
 * - network: the channel carries the broadcast network (ESPN, CBS, ...)
 */
export function matchSources(game, library, memory = {}) {
  if (!game) return [];
  const results = new Map();
  const put = (src, score, why) => {
    const cur = results.get(src.id);
    if (!cur || cur.score < score) results.set(src.id, { source: src, score, why });
  };
  const remembered = memory.gameStreams?.[game.key];
  const nets = game.networks.map((n) => normName(n)).filter(Boolean);
  // Each team's recognizable names ("kansas city chiefs", "chiefs"). Matching counts teams, not spellings,
  // so "Kansas City Chiefs" alone is one team, not both.
  const teamNames = [game.home, game.away]
    .filter(Boolean)
    .map((t) => [...new Set([t.name, t.short, t.location && t.short && t.location !== t.short ? `${t.location} ${t.short}` : ''].map((x) => normName(x)))].filter((x) => x.length >= 4));

  for (const src of library) {
    if (src.id === remembered) {
      put(src, 100, 'Picked before');
      continue;
    }
    const n = normName(src.name);
    const tags = normName(src.network);
    const words = new Set([...tokens(src.name), ...tokens(src.network)]);
    const padded = ` ${n} `;
    const teamsNamed = teamNames.filter((names) => names.some((w) => padded.includes(` ${w} `))).length;
    if (teamsNamed >= 2) put(src, 90, 'Both teams in name');
    else if (teamsNamed === 1) put(src, 60, 'Team in name');
    for (const net of nets) {
      const netWords = net.split(' ');
      const exact = n === net || tags === net;
      const contains = netWords.every((w) => words.has(w));
      if (exact) put(src, 75, `${net.toUpperCase()} channel`);
      else if (contains) put(src, 55, `Carries ${net.toUpperCase()}`);
    }
    const rememberedNet = game.networks.find((net) => memory.networkStreams?.[net] === src.id);
    if (rememberedNet) put(src, 80, `Your ${rememberedNet} channel`);
  }
  return [...results.values()].sort((a, b) => b.score - a.score);
}

/** Search the library by name, group or network. */
export function searchLibrary(library, q, limit = 120) {
  const query = normName(q);
  if (!query) return library.slice(0, limit);
  const words = query.split(' ');
  const out = [];
  for (const s of library) {
    const hay = `${normName(s.name)} ${normName(s.group)} ${normName(s.network)}`;
    if (words.every((w) => hay.includes(w))) out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

// Public test streams for checking that playback works. Not sports.
export const TEST_STREAMS = [
  { name: 'Test pattern · Apple fMP4 (HLS)', url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8', group: 'Test streams' },
  { name: 'Test film · Mux Big Buck Bunny (HLS)', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', group: 'Test streams' },
];
