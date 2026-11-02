// Whiparound: multiview for live sports.
// Controller for the grid of tiles, the games panel, Auto Whip, and the dialogs.

import { $, $$, esc, h, icon, formatKickoff, secondsAgo, contrastOn, debounce } from './util.js';
import { LEAGUES, DEFAULT_LEAGUES, league as leagueById, leagueShort, watchLinks } from './leagues.js';
import { Scoreboard, statusText, situationText } from './scores.js';
import { heatLevel } from './excitement.js';
import { makeSource, matchSources, searchLibrary, parseM3U, normName, KIND_LABEL, TEST_STREAMS, isLikelyUrl, youtubeChannel, detectKind } from './sources.js';
import { createStorage } from './storage.js';
import { Player } from './player.js';
import { createDemo } from './demo.js';
import { logoFor, onLogosReady, setLogosEnabled } from './logos.js';
import { entitlements, layoutAllowed, UPGRADE_REASONS, PLAN_ROWS } from './plan.js';
import { loadConfig, createAccount } from './account.js';
import { loadCatalog, loadFreeNow, watchUrl } from './free.js';

// ---------------------------------------------------------------------------
// Setup & state
// ---------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
// EMBED: a single-file preview build that always runs the demo (see README).
const EMBED = !!window.WHIP_EMBED;
const DEMO = EMBED || params.has('demo');
const demo = DEMO ? createDemo() : null;
const storage = createStorage('main');

const LAYOUTS = [
  { id: '1', label: 'Single', slots: 1, main: true, rects: [[0, 0, 24, 16]] },
  { id: '2', label: 'Side by side', slots: 2, rects: [[0, 0, 11.5, 16], [12.5, 0, 11.5, 16]] },
  { id: '1+2', label: 'Main + 2', slots: 3, main: true, rects: [[0, 0, 15.5, 16], [16.5, 0, 7.5, 7.5], [16.5, 8.5, 7.5, 7.5]] },
  { id: '2x2', label: 'Quad', slots: 4, rects: [[0, 0, 11.5, 7.5], [12.5, 0, 11.5, 7.5], [0, 8.5, 11.5, 7.5], [12.5, 8.5, 11.5, 7.5]] },
  { id: '1+3', label: 'Main + 3', slots: 4, main: true, rects: [[0, 0, 17.5, 16], [18.5, 0, 5.5, 4.66], [18.5, 5.67, 5.5, 4.66], [18.5, 11.34, 5.5, 4.66]] },
  {
    id: '3x3', label: 'Nine', slots: 9,
    rects: [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => [c * 8.33, r * 5.5, 7.33, 5]))
  },
];
const layoutById = (id) => LAYOUTS.find((l) => l.id === id) || LAYOUTS[3];
const TILE_COUNT = 9;

function defaults() {
  const tiles = Array.from({ length: TILE_COUNT }, (_, i) => ({ id: `t${i}`, sourceId: null, gameKey: null, noGame: false, filledAt: 0 }));
  return {
    v: 1,
    layout: '2x2',
    soloFrom: null,
    tiles,
    order: tiles.map((t) => t.id),
    audio: 't0',
    muted: false,
    autoWhip: false,
    autoFill: false,
    alerts: true,
    holdSec: 25,
    leagues: [...DEFAULT_LEAGUES],
    filter: 'all',
    panel: window.innerWidth >= 1000,
    ticker: true,
    gameStreams: {},
    networkStreams: {},
    seenIntro: false,
    freeAuto: true,
  };
}

function loadState() {
  const s = defaults();
  const saved = storage.loadSettings();
  if (!saved || saved.v !== 1) return s;
  Object.assign(s, saved);
  const byId = new Map((saved.tiles || []).map((t) => [t.id, t]));
  s.tiles = defaults().tiles.map((t) => ({ ...t, ...(byId.get(t.id) || {}) }));
  const ids = s.tiles.map((t) => t.id);
  const order = Array.isArray(saved.order) ? saved.order : [];
  s.order = order.length === TILE_COUNT && ids.every((id) => order.includes(id)) ? order : ids;
  s.leagues = (Array.isArray(saved.leagues) ? saved.leagues : DEFAULT_LEAGUES).filter((id) => leagueById(id));
  return s;
}

function demoState() {
  const s = defaults();
  const { gameStreams } = demo.setup();
  Object.assign(s, {
    layout: '1+3',
    autoWhip: true,
    autoFill: false,
    holdSec: 12,
    leagues: demo.leagues,
    gameStreams,
    seenIntro: true,
    panel: window.innerWidth >= 1000,
  });
  ['d1', 'd2', 'd3', 'd4'].forEach((id, i) => {
    s.tiles[i].sourceId = `demo-${id}`;
    s.tiles[i].gameKey = `nfl:${id}`;
  });
  return s;
}

const S = DEMO ? demoState() : loadState();

// Paid mode: only when this copy is served with the hosted backend (/api/config says so).
// Your own copy (the local helper, or a static host with no backend) and the demo keep everything unlocked.
let PAID = false;
let config = null;
let account = null;
let ent = entitlements('personal');
const allowedLayout = (id) => layoutAllowed(ent, id);
const whipOn = () => S.autoWhip && ent.autoWhip;
let library = [];
const libIndex = new Map();
function setLibrary(list) {
  library = list;
  libIndex.clear();
  for (const s of list) libIndex.set(s.id, s);
}
const src = (id) => (id ? libIndex.get(id) || null : null);
const tileById = (id) => S.tiles.find((t) => t.id === id);

const persist = debounce(() => {
  if (!DEMO) storage.saveSettings(S);
}, 250);
const persistLib = () => (DEMO ? Promise.resolve(true) : storage.saveLibrary(library));

// ---------------------------------------------------------------------------
// Network: optional local relay (dev-server.cjs, `npm start`) for CORS-blocked streams and scores
// ---------------------------------------------------------------------------

let proxyOn = false;
// Absolute URL: mpegts.js fetches from a Web Worker, which can't resolve relative paths.
const proxyFor = (u, raw = false) =>
  proxyOn && /^https?:\/\//i.test(u) ? new URL(`proxy?${raw ? 'raw=1&' : ''}url=${encodeURIComponent(u)}`, location.href).href : null;

async function detectProxy() {
  if (EMBED || !location.protocol.startsWith('http')) return;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch('api/health', { cache: 'no-store', signal: ctl.signal });
    clearTimeout(t);
    proxyOn = r.ok && (await r.json()).proxy === true;
  } catch {
    proxyOn = false;
  }
}

let scoresViaProxy = false;
async function fetchJSON(url) {
  if (!scoresViaProxy) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (!proxyOn) throw e;
      scoresViaProxy = true;
    }
  }
  const r = await fetch(proxyFor(url, true), { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** Ask the local helper which video a YouTube channel is streaming live. */
async function resolveYouTubeLive(liveUrl) {
  const r = await fetch(new URL(`api/youtube-live?url=${encodeURIComponent(liveUrl)}`, location.href), { cache: 'no-store' });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `Couldn't check the channel (${r.status}).`);
  return body;
}

async function fetchText(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`The server answered ${r.status}`);
    return await r.text();
  } catch (e) {
    if (!proxyOn) {
      throw new Error(
        /answered/.test(e.message) ? e.message : "Couldn't download it. The server may block browsers (CORS). Run Whiparound on your computer with npm start, or download the file and import it below."
      );
    }
    const r = await fetch(proxyFor(url, true), { cache: 'no-store' });
    if (!r.ok) throw new Error(`The server answered ${r.status}`);
    return r.text();
  }
}

// ---------------------------------------------------------------------------
// Scoreboard
// ---------------------------------------------------------------------------

const board = new Scoreboard({ leagues: S.leagues, demo, fetchJSON });
onLogosReady(() => {
  renderTiles();
  renderGames();
  renderTicker();
});
board.addEventListener('update', onBoardUpdate);
board.addEventListener('score', (e) => onScore(e.detail));

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

const grid = $('#grid');
const views = new Map();

function createTileView(t) {
  const el = h(`
    <section class="tile" data-tile="${t.id}" aria-label="Tile">
      <div class="media"></div>
      <button class="tile-empty" type="button" data-act="pick">
        <span class="plus">${icon('plus')}</span>
        <strong>Add a stream</strong>
        <span class="sub">Pick a game or one of your channels. You can also drag a game here.</span>
      </button>
      <div class="tile-status"></div>
      <div class="flash"></div>
      <div class="bug" hidden></div>
      <div class="tile-top"><span class="slot-num"></span><span class="tile-name"></span><span class="audio-ind">${icon('sound')}</span></div>
      <div class="hot-badge" hidden></div>
      <div class="tile-actions">
        <button type="button" data-act="audio" title="Sound on this tile">${icon('sound')}</button>
        <button type="button" data-act="main" title="Make this the main tile">${icon('main')}</button>
        <button type="button" data-act="pick" title="Change stream or game">${icon('swap')}</button>
        <button type="button" data-act="pip" title="Picture in picture" hidden>${icon('pip')}</button>
        <button type="button" data-act="airplay" title="AirPlay" hidden>${icon('airplay')}</button>
        <button type="button" data-act="clear" title="Empty this tile">${icon('close')}</button>
      </div>
    </section>`);
  const v = {
    id: t.id,
    el,
    media: $('.media', el),
    statusEl: $('.tile-status', el),
    flashEl: $('.flash', el),
    bug: $('.bug', el),
    hot: $('.hot-badge', el),
    name: $('.tile-name', el),
    num: $('.slot-num', el),
    empty: $('.tile-empty', el),
    actions: $('.tile-actions', el),
    state: 'idle',
    msg: '',
    loadedKey: null,
  };
  v.player = new Player(v.media, {
    proxy: (u) => proxyFor(u),
    liveResolver: () => (proxyOn ? resolveYouTubeLive : null),
    onState: (s, msg) => onPlayerState(v, s, msg),
    onInfo: (info) => onStreamInfo(v, info),
  });

  el.addEventListener('click', (e) => onTileClick(v, e));
  el.addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    toggleSolo(v.id);
  });
  el.addEventListener('dragstart', (e) => {
    if (!tileById(v.id).sourceId) return e.preventDefault();
    e.dataTransfer.setData('application/x-whip-tile', v.id);
    e.dataTransfer.effectAllowed = 'move';
  });
  el.addEventListener('dragover', (e) => {
    const types = [...e.dataTransfer.types];
    if (types.includes('application/x-whip-game') || types.includes('application/x-whip-tile')) {
      e.preventDefault();
      el.classList.add('drop-target');
    }
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drop-target');
    const gameKey = e.dataTransfer.getData('application/x-whip-game');
    const fromTile = e.dataTransfer.getData('application/x-whip-tile');
    if (gameKey) dropGameOnTile(gameKey, v.id);
    else if (fromTile && fromTile !== v.id) swapTiles(fromTile, v.id);
  });
  return v;
}

function onPlayerState(v, s, msg) {
  v.state = s;
  v.msg = msg || '';
  renderTileStatus(v);
  if (s === 'playing') renderTile(v);
}

/** A channel tile found (or switched to) a live video: show its title and link the game it names. */
function onStreamInfo(v, info) {
  v.liveTitle = info.title || '';
  const t = tileById(v.id);
  // Re-link only when the channel moved to a different stream; a reload of the same video keeps
  // whatever the viewer chose, and "No game" is always respected.
  const newStream = info.videoId && info.videoId !== t.liveVideoId;
  if (info.videoId) t.liveVideoId = info.videoId;
  const key = newStream && !t.noGame && v.liveTitle ? gameFromTitle(v.liveTitle) : null;
  if (key && key !== t.gameKey) {
    t.gameKey = key;
    renderGames();
  }
  persist();
  renderTile(v);
}

/** The one live or upcoming game whose two teams both appear in a stream title. */
function gameFromTitle(title) {
  const pseudo = { id: '__title', name: title, network: '' };
  const hits = board
    .list()
    .filter((g) => g.state !== 'post')
    .filter((g) => (matchSources(g, [pseudo], {})[0]?.score ?? 0) >= 90);
  return hits.length === 1 ? hits[0].key : null;
}

/** For YouTube tiles that can't play here, a way out to YouTube itself. */
function youtubeOutLink(v) {
  const s = src(tileById(v.id).sourceId);
  if (!s || (s.kind !== 'ytlive' && s.kind !== 'youtube')) return '';
  const href = s.kind === 'ytlive' ? youtubeChannel(s.url)?.liveUrl || s.url : s.url;
  return `<a class="btn small" href="${esc(href)}" target="_blank" rel="noopener">${icon('external')}Open on YouTube</a>`;
}

function renderTileStatus(v) {
  const el = v.statusEl;
  el.className = 'tile-status';
  if (v.state === 'loading' || v.state === 'buffering') {
    el.innerHTML = `<div class="spinner"></div>${v.msg ? `<div class="msg">${esc(v.msg)}</div>` : ''}`;
  } else if (v.state === 'tap') {
    el.innerHTML = `<div class="msg">${esc(v.msg || 'Tap to play')}</div>`;
  } else if (v.state === 'waiting') {
    el.classList.add('err', 'wait');
    el.innerHTML = `<div class="wait-dot" aria-hidden="true"></div><div class="msg">${esc(v.msg)}</div>
      <div class="row"><button class="btn small" type="button" data-act="pick">${icon('swap')}Change</button>${youtubeOutLink(v)}</div>`;
  } else if (v.state === 'error') {
    el.classList.add('err');
    el.innerHTML = `<div class="msg">${esc(v.msg)}</div>
      <div class="row">
        <button class="btn small" type="button" data-act="retry">${icon('retry')}Try again</button>
        <button class="btn small" type="button" data-act="pick">${icon('swap')}Change</button>${youtubeOutLink(v)}
      </div>`;
  } else {
    el.innerHTML = '';
  }
}

function onTileClick(v, e) {
  const btn = e.target.closest('[data-act]');
  if (btn) {
    e.stopPropagation();
    return tileAction(v, btn.dataset.act);
  }
  const t = tileById(v.id);
  if (!t.sourceId) return openPicker({ tileId: v.id });
  revealTileUi(v);
  if (v.state === 'tap') v.player.resume();
  setAudio(v.id, { manual: true });
}

function tileAction(v, act) {
  switch (act) {
    case 'pick':
      return openPicker({ tileId: v.id });
    case 'audio':
      if (S.audio === v.id && !S.muted) return toggleMute();
      return setAudio(v.id, { manual: true });
    case 'main':
      return makeMain(v.id, { manual: true });
    case 'pip':
      return v.player.pip();
    case 'airplay':
      return v.player.airplay();
    case 'clear':
      return clearTile(v.id);
    case 'retry':
      v.loadedKey = null;
      return syncPlayers();
  }
}

function revealTileUi(v) {
  v.el.classList.add('ui-on');
  clearTimeout(v.uiTimer);
  v.uiTimer = setTimeout(() => v.el.classList.remove('ui-on'), 3000);
}

const visibleIds = () => S.order.slice(0, layoutById(S.layout).slots);

function syncPlayers() {
  const vis = visibleIds();
  for (const t of S.tiles) {
    const v = views.get(t.id);
    const slot = vis.indexOf(t.id);
    const visible = slot !== -1;
    v.el.hidden = !visible;
    v.el.style.gridArea = visible ? `s${slot}` : '';
    v.el.draggable = visible && !!t.sourceId;
    const source = src(t.sourceId);
    const key = source ? `${source.id}|${source.url}` : null;
    if (visible && source) {
      if (v.loadedKey !== key) {
        v.loadedKey = key;
        v.liveTitle = '';
        v.player.load(source);
      }
    } else if (v.loadedKey) {
      v.loadedKey = null;
      v.player.destroy();
    }
  }
}

function applyAudio() {
  const vis = visibleIds();
  const playable = vis.filter((id) => src(tileById(id).sourceId));
  if (!playable.includes(S.audio)) S.audio = playable[0] || vis[0];
  for (const v of views.values()) v.player.setMuted(S.muted || v.id !== S.audio);
}

/** Team logo when it has loaded; the team's letters on its color until then (or if there's no logo). */
function teamMark(t, cls = '') {
  const logo = logoFor(t);
  if (logo) {
    return `<img class="tlogo ${logo.dark ? '' : 'lite'} ${cls}" src="${esc(logo.url)}" alt="${esc(t.abbr)}" title="${esc(t.name)}" referrerpolicy="no-referrer" decoding="async">`;
  }
  return `<span class="tchip ${cls}" style="--tc:${esc(t.color)};--tct:${contrastOn(t.color)}" title="${esc(t.name)}">${esc(t.abbr)}</span>`;
}

function bugHtml(g) {
  const poss = g.situation?.possession;
  const side = (t, key) =>
    `<div class="bug-team" style="--tc:${esc(t.color)}">${logoFor(t) ? teamMark(t, 'bug-logo') : ''}<b>${esc(t.abbr)}</b><span class="pts">${
      g.state === 'pre' ? '' : esc(t.score ?? 0)
    }</span>${poss === key ? '<span class="pos" title="Possession"></span>' : ''}</div>`;
  const sit = situationText(g);
  return `${side(g.away, 'away')}${side(g.home, 'home')}<div class="bug-status"><span>${esc(statusText(g, formatKickoff))}</span>${
    sit ? `<span class="sit ${g.situation?.isRedZone ? 'rz' : ''}">${esc(sit)}</span>` : ''
  }</div>`;
}

function renderTile(v) {
  const t = tileById(v.id);
  const source = src(t.sourceId);
  const game = board.get(t.gameKey);
  const slot = S.order.indexOf(t.id);
  v.el.classList.toggle('has-empty', !source);
  v.empty.hidden = !!source;
  v.actions.hidden = !source;
  v.num.textContent = String(slot + 1);
  v.name.textContent = source ? (v.liveTitle && v.loadedKey ? `${source.name} · ${v.liveTitle}` : source.name) : '';
  v.el.setAttribute('aria-label', source ? `Tile ${slot + 1}: ${source.name}` : `Tile ${slot + 1}, empty`);
  const isAudio = !!source && S.audio === t.id && !S.muted;
  v.el.classList.toggle('is-audio', isAudio);
  const audioBtn = $('[data-act="audio"]', v.el);
  audioBtn.innerHTML = icon(isAudio ? 'sound' : 'mute');
  audioBtn.title = isAudio ? 'Mute' : 'Sound on this tile';
  const heat = game?.heat;
  if (source && game && game.state === 'in' && heat?.reason && heat.score >= 35) {
    v.hot.hidden = false;
    v.hot.className = `hot-badge ${heat.score >= 55 ? '' : 'hot'}`;
    v.hot.innerHTML = `${icon('flame')}${esc(heat.reason)}`;
  } else {
    v.hot.hidden = true;
  }
  v.el.classList.toggle('is-hot', !!(source && game && heat?.score >= 55));
  if (source && game) {
    v.bug.hidden = false;
    const html = bugHtml(game);
    if (v.bugHtml !== html) {
      v.bug.innerHTML = html;
      v.bugHtml = html;
    }
  } else {
    v.bug.hidden = true;
  }
  $('[data-act="pip"]', v.el).hidden = !v.player.canPip;
  $('[data-act="airplay"]', v.el).hidden = !v.player.canAirPlay;
}

const renderTiles = () => views.forEach(renderTile);

function refresh({ games = true } = {}) {
  syncPlayers();
  applyAudio();
  renderTiles();
  renderBar();
  if (games) renderGames();
  renderWelcome();
  persist();
}

// ---------------------------------------------------------------------------
// Tile operations
// ---------------------------------------------------------------------------

let lastWhipAt = 0;
const holdWhip = () => (lastWhipAt = Date.now());

function setAudio(id, { manual = false } = {}) {
  S.audio = id;
  if (manual) {
    if (S.muted) S.muted = false;
    holdWhip();
  }
  refresh({ games: false });
}

function toggleMute() {
  S.muted = !S.muted;
  refresh({ games: false });
}

function makeMain(id, { manual = false } = {}) {
  const i = S.order.indexOf(id);
  if (i > 0) [S.order[0], S.order[i]] = [S.order[i], S.order[0]];
  S.audio = id;
  if (manual) {
    S.muted = false;
    holdWhip();
  }
  refresh();
}

function swapTiles(a, b) {
  const i = S.order.indexOf(a);
  const j = S.order.indexOf(b);
  [S.order[i], S.order[j]] = [S.order[j], S.order[i]];
  holdWhip();
  refresh();
}

function toggleSolo(id) {
  if (S.layout !== '1') {
    S.soloFrom = S.layout;
    S.layout = '1';
    applyLayoutAttr();
    makeMain(id, { manual: true });
  } else if (S.soloFrom) {
    S.layout = allowedLayout(S.soloFrom) ? S.soloFrom : '2';
    S.soloFrom = null;
    applyLayoutAttr();
    refresh();
  }
}

function setLayout(id) {
  if (!allowedLayout(id)) return openUpgrade('layout');
  S.layout = id;
  S.soloFrom = null;
  applyLayoutAttr();
  refresh();
}

function applyLayoutAttr() {
  grid.dataset.layout = S.layout;
}

function clearTile(id) {
  const t = tileById(id);
  t.sourceId = null;
  t.gameKey = null;
  t.noGame = false;
  refresh();
}

function rememberPick(gameKey, sourceId) {
  S.gameStreams[gameKey] = sourceId;
  const keys = Object.keys(S.gameStreams);
  if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete S.gameStreams[k];
  const g = board.get(gameKey);
  const s = src(sourceId);
  if (!g || !s) return;
  const words = new Set([...normName(s.name).split(' '), ...normName(s.network).split(' ')]);
  for (const net of g.networks) {
    const n = normName(net);
    if (n && (normName(s.network) === n || n.split(' ').every((w) => words.has(w)))) S.networkStreams[net] = sourceId;
  }
}

function assign(tileId, sourceId, gameKey, { noGame = false } = {}) {
  const t = tileById(tileId);
  t.sourceId = sourceId;
  t.gameKey = gameKey || null;
  t.noGame = noGame && !gameKey;
  t.filledAt = Date.now();
  t.liveVideoId = null;
  if (gameKey && sourceId) rememberPick(gameKey, sourceId);
  // Make sure the tile is on screen.
  const vis = visibleIds();
  if (!vis.includes(tileId)) {
    const target = vis.find((id) => !tileById(id).sourceId) || vis[vis.length - 1];
    swapOrder(tileId, target);
  }
  const audioHasSource = !!src(tileById(S.audio)?.sourceId);
  if (!audioHasSource) S.audio = tileId;
  refresh();
}

function swapOrder(a, b) {
  const i = S.order.indexOf(a);
  const j = S.order.indexOf(b);
  [S.order[i], S.order[j]] = [S.order[j], S.order[i]];
}

/** Best guess at which game a channel is showing, when exactly one live/upcoming game fits. */
function guessGameFor(source) {
  const games = board.list().filter((g) => g.state !== 'post');
  const hits = games
    .map((g) => ({ g, m: matchSources(g, [source], S)[0] }))
    .filter((x) => x.m && x.m.score >= 55)
    .sort((a, b) => b.m.score - a.m.score);
  if (!hits.length) return null;
  if (hits.length === 1 || hits[0].m.score > hits[1].m.score) return hits[0].g.key;
  const live = hits.filter((x) => x.g.state === 'in');
  return live.length === 1 ? live[0].g.key : null;
}

function defaultTileFor(gameKey) {
  const vis = visibleIds();
  const showing = vis.find((id) => gameKey && tileById(id).gameKey === gameKey);
  if (showing) return showing;
  const empty = vis.find((id) => !tileById(id).sourceId);
  if (empty) return empty;
  const ranked = vis
    .filter((id) => id !== S.audio)
    .map((id) => ({ id, score: board.get(tileById(id).gameKey)?.heat?.score ?? -1 }))
    .sort((a, b) => a.score - b.score);
  return ranked[0]?.id || vis[0];
}

function dropGameOnTile(gameKey, tileId) {
  const g = board.get(gameKey);
  const best = g ? matchSources(g, library, S)[0] : null;
  if (best && best.score >= 75) assign(tileId, best.source.id, gameKey);
  else openPicker({ tileId, gameKey });
}

// ---------------------------------------------------------------------------
// Auto Whip
// ---------------------------------------------------------------------------

function runWhip() {
  if (!whipOn()) return;
  const now = Date.now();
  if (now - lastWhipAt < S.holdSec * 1000) return;
  const L = layoutById(S.layout);
  // In single view, Whip rotates through every tile you've set up, like a whip-around show.
  const pool = (L.slots === 1 ? S.order : visibleIds()).filter((id) => src(tileById(id).sourceId));
  const rated = pool
    .map((id) => ({ id, g: board.get(tileById(id).gameKey) }))
    .filter((x) => x.g && x.g.state === 'in')
    .map((x) => ({ ...x, score: x.g.heat?.score ?? 0 }))
    .sort((a, b) => b.score - a.score);
  const focusId = L.main ? S.order[0] : S.audio;
  const best = rated[0];
  if (best && best.id !== focusId) {
    const cur = rated.find((x) => x.id === focusId)?.score ?? 0;
    if (best.score >= 30 && best.score >= cur + 12) return whipTo(best.id, best.g);
  }
  autoFill(now);
}

function whipTo(id, g) {
  holdWhip();
  if (layoutById(S.layout).main) {
    const i = S.order.indexOf(id);
    if (i > 0) [S.order[0], S.order[i]] = [S.order[i], S.order[0]];
  }
  S.audio = id;
  refresh();
  showBanner(g);
}

function autoFill(now) {
  if (!S.autoFill || !ent.autoFill) return;
  const vis = visibleIds();
  const onScreen = new Set(vis.map((id) => tileById(id).gameKey).filter(Boolean));
  const candidates = board
    .list()
    .filter((g) => g.state === 'in' && !onScreen.has(g.key) && (g.heat?.score ?? 0) >= 45)
    .map((g) => ({ g, m: matchSources(g, library, S).find((m) => m.score >= 90) }))
    .filter((x) => x.m)
    .sort((a, b) => b.g.heat.score - a.g.heat.score);
  const c = candidates[0];
  if (!c) return;
  let target = vis.find((id) => !tileById(id).sourceId);
  if (!target) {
    const cold = vis
      .filter((id) => id !== S.audio && S.order.indexOf(id) !== 0 && now - (tileById(id).filledAt || 0) > 60000)
      .map((id) => ({ id, score: board.get(tileById(id).gameKey)?.heat?.score ?? 0 }))
      .sort((a, b) => a.score - b.score)[0];
    if (cold && cold.score + 25 <= c.g.heat.score) target = cold.id;
  }
  if (!target) return;
  const t = tileById(target);
  t.sourceId = c.m.source.id;
  t.gameKey = c.g.key;
  t.noGame = false;
  t.filledAt = now;
  refresh();
  toast({ title: c.g.heat.reason || 'Hot game', text: `${gameLine(c.g)} is now on tile ${S.order.indexOf(target) + 1}.`, kind: 'hot' });
}

let bannerTimer = 0;
function showBanner(g) {
  const b = $('#whipBanner');
  const detail = situationText(g) || statusText(g, formatKickoff);
  b.innerHTML = `${icon('bolt')}<span class="tag">${esc(g.heat?.reason || 'Hot game')}</span><span class="txt">${esc(gameLine(g))} · ${esc(detail)}</span>`;
  b.hidden = false;
  b.style.animation = 'none';
  void b.offsetWidth;
  b.style.animation = '';
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => (b.hidden = true), 5000);
}

const gameLine = (g) =>
  g.state === 'pre'
    ? `${g.away?.abbr} @ ${g.home?.abbr}`
    : `${g.away?.abbr} ${g.away?.score ?? 0} @ ${g.home?.abbr} ${g.home?.score ?? 0}`;

// Alerts for hot games that aren't on screen.
const alerted = new Map();
let lastAlertAt = 0;
function alertHot() {
  if (!S.alerts || !ent.alerts) return;
  const now = Date.now();
  if (now - lastAlertAt < 20000) return;
  const onScreen = new Set(visibleIds().map((id) => tileById(id).gameKey).filter(Boolean));
  const g = board
    .list()
    .filter((x) => x.state === 'in' && !onScreen.has(x.key) && x.heat?.score >= 55 && x.heat.reason)
    .sort((a, b) => b.heat.score - a.heat.score)[0];
  if (!g) return;
  const prev = alerted.get(g.key);
  if (prev && prev.reason === g.heat.reason && now - prev.at < 5 * 60000) return;
  alerted.set(g.key, { reason: g.heat.reason, at: now });
  lastAlertAt = now;
  toast({
    title: g.heat.reason,
    text: `${leagueShort(g.league)} · ${gameLine(g)} · ${situationText(g) || statusText(g)}`,
    kind: 'hot',
    ttl: 9000,
    actions: [{ label: 'Watch', primary: true, fn: () => openPicker({ gameKey: g.key }) }],
  });
}

function onScore({ game, side, label }) {
  const team = game[side];
  for (const id of visibleIds()) {
    if (tileById(id).gameKey !== game.key) continue;
    const v = views.get(id);
    const logo = logoFor(team);
    v.flashEl.innerHTML = `<div class="flash-card" style="--fc:${esc(team.color)};--fct:${contrastOn(team.color)}">${
      logo ? `<img class="flash-logo" src="${esc(logo.url)}" alt="" referrerpolicy="no-referrer">` : ''
    }${esc(label)}<small>${esc(team.abbr)}</small></div>`;
    clearTimeout(v.flashTimer);
    v.flashTimer = setTimeout(() => (v.flashEl.innerHTML = ''), 5100);
  }
}

let firstUpdate = true;
function onBoardUpdate() {
  // Link tiles to games automatically when the channel clearly matches one.
  let linked = false;
  for (const t of S.tiles) {
    if (t.sourceId && !t.gameKey && !t.noGame && board.list().length) {
      const s = src(t.sourceId);
      const title = views.get(t.id)?.liveTitle;
      const key = (title && gameFromTitle(title)) || (s && guessGameFor(s));
      if (key) {
        t.gameKey = key;
        linked = true;
      }
    }
  }
  if (linked) persist();
  renderTiles();
  renderGames();
  renderTicker();
  renderFeedStatus();
  if (!firstUpdate) {
    runWhip();
    alertHot();
  }
  firstUpdate = false;
}

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

function buildBar() {
  const box = $('#layouts');
  box.innerHTML = LAYOUTS.map(
    (l) => `<button class="layout-btn" type="button" role="radio" data-layout="${l.id}" title="${esc(l.label)} (L)" aria-label="${esc(l.label)}">
      <svg viewBox="0 0 24 16" aria-hidden="true">${l.rects
        .map(([x, y, w, hh]) => `<rect x="${x}" y="${y}" width="${w}" height="${hh}" rx="1" fill="currentColor"/>`)
        .join('')}</svg></button>`
  ).join('');
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-layout]');
    if (b) setLayout(b.dataset.layout);
  });
  $('#whipBtn').addEventListener('click', toggleWhip);
  $('#muteBtn').addEventListener('click', toggleMute);
  $('#channelsBtn').addEventListener('click', () => openChannels());
  $('#gamesBtn').addEventListener('click', togglePanel);
  $('#panelClose').addEventListener('click', togglePanel);
  $('#fsBtn').addEventListener('click', toggleFullscreen);
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#helpBtn').addEventListener('click', openHelp);
  $('#demoTag').hidden = !DEMO;
  $('#planBtn').addEventListener('click', () => (account?.state.plan === 'pro' ? openAccount() : openUpgrade('generic')));
  $('#accountBtn').addEventListener('click', () => (account?.state.user ? openAccount() : openSignIn()));
}

function renderBar() {
  $$('#layouts .layout-btn').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.layout === S.layout));
    const locked = !allowedLayout(b.dataset.layout);
    b.classList.toggle('locked', locked);
    b.title = `${LAYOUTS.find((l) => l.id === b.dataset.layout).label}${locked ? ' (Pro)' : ' (L)'}`;
  });
  const whipBtn = $('#whipBtn');
  whipBtn.setAttribute('aria-pressed', String(whipOn()));
  whipBtn.classList.toggle('locked', !ent.autoWhip);
  whipBtn.title = ent.autoWhip ? 'Auto Whip (W)' : 'Auto Whip (Pro)';
  const planBtn = $('#planBtn');
  const accountBtn = $('#accountBtn');
  planBtn.hidden = accountBtn.hidden = !PAID;
  if (PAID) {
    const pro = account?.state.plan === 'pro';
    planBtn.classList.toggle('is-pro', pro);
    planBtn.innerHTML = pro ? `${icon('check')}<span>Pro</span>` : `${icon('bolt')}<span>Go Pro</span>`;
    planBtn.title = pro ? 'Your plan' : 'See what Pro unlocks';
    accountBtn.title = account?.state.user ? `Signed in as ${account.state.user.email}` : 'Sign in';
    accountBtn.classList.toggle('signed-in', !!account?.state.user);
  }
  const mute = $('#muteBtn');
  mute.setAttribute('aria-pressed', String(S.muted));
  mute.innerHTML = icon(S.muted ? 'mute' : 'sound');
  mute.title = S.muted ? 'Unmute (M)' : 'Mute all (M)';
  $('#gamesBtn').setAttribute('aria-pressed', String(S.panel));
  const app = $('#app');
  app.classList.toggle('panel-closed', !S.panel);
  app.classList.toggle('no-ticker', !S.ticker);
}

function toggleWhip() {
  if (!ent.autoWhip) return openUpgrade('autoWhip');
  S.autoWhip = !S.autoWhip;
  lastWhipAt = 0;
  renderBar();
  persist();
  toast({
    title: S.autoWhip ? 'Auto Whip on' : 'Auto Whip off',
    text: S.autoWhip
      ? 'The game with the most going on gets the main tile and the sound. Link games to tiles so Whip can rate them.'
      : 'Tiles stay where you put them.',
    ttl: 4000,
  });
  if (S.autoWhip) runWhip();
}

const overlayPanel = matchMedia('(max-width: 900px) and (orientation: landscape)');
function togglePanel() {
  S.panel = !S.panel;
  renderBar();
  persist();
}

function setCinema(on) {
  $('#app').classList.toggle('cinema', on);
  $('#cinemaExit').hidden = !on;
}

function toggleFullscreen() {
  const d = document;
  if (d.fullscreenElement || d.webkitFullscreenElement) {
    (d.exitFullscreen || d.webkitExitFullscreen).call(d);
    return setCinema(false);
  }
  if ($('#app').classList.contains('cinema')) return setCinema(false);
  setCinema(true);
  const el = d.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (req) {
    try {
      Promise.resolve(req.call(el)).catch(() => {});
    } catch {}
  }
}
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) setCinema(false);
});

// ---------------------------------------------------------------------------
// Games panel & ticker
// ---------------------------------------------------------------------------

const gamesEl = $('#games');

function teamRow(g, side) {
  const t = g[side];
  if (!t) return '';
  const other = g[side === 'home' ? 'away' : 'home'];
  const lead = g.state !== 'pre' && (t.score ?? 0) > (other?.score ?? 0);
  const poss = g.state === 'in' && g.situation?.possession === side;
  return `<div class="g-team ${lead ? 'lead' : ''}">
    <span class="g-mark">${teamMark(t)}</span>
    <span class="g-name">${t.rank ? `<span class="rank">${t.rank}</span>` : ''}${esc(t.short || t.name)}${poss ? '<span class="poss" title="Possession"></span>' : ''}</span>
    <span class="g-score">${g.state === 'pre' ? '' : esc(t.score ?? 0)}</span>
  </div>`;
}

function gameRow(g, onScreenSlot) {
  const heat = g.heat || { score: 0 };
  const lvl = g.state === 'in' ? heatLevel(heat.score) : 'cool';
  const sit = situationText(g);
  const nets = g.networks.slice(0, 2).join(' · ');
  const heatTag =
    g.state === 'in' && heat.reason && heat.score >= 20
      ? `<span class="g-heat ${lvl}">${lvl !== 'warm' ? icon('flame') : ''}${esc(heat.reason)}</span>`
      : '';
  const foot =
    heatTag || sit || onScreenSlot
      ? `<div class="g-foot">${heatTag}<span class="g-sit">${esc(sit)}</span>${
          onScreenSlot ? `<span class="g-onscreen">Tile ${onScreenSlot}</span>` : ''
        }</div>`
      : '';
  return `<button type="button" class="game ${g.state} h-${lvl} ${onScreenSlot ? 'on-screen' : ''}" data-key="${esc(g.key)}" draggable="true"
      aria-label="${esc(`${g.away?.name} at ${g.home?.name}, ${statusText(g, formatKickoff)}`)}">
    <div class="g-teams">${teamRow(g, 'away')}${teamRow(g, 'home')}</div>
    <div class="g-side"><span class="g-status">${esc(statusText(g, formatKickoff))}</span>${
      S.filter === 'all' ? `<span class="g-net">${esc(leagueShort(g.league))}${nets ? ' · ' + esc(nets) : ''}</span>` : nets ? `<span class="g-net">${esc(nets)}</span>` : ''
    }</div>
    ${foot}
  </button>`;
}

function renderGames() {
  const all = board.list();
  const enabled = S.leagues;
  if (S.filter !== 'all' && !enabled.includes(S.filter)) S.filter = 'all';
  const liveCount = (id) => all.filter((g) => g.state === 'in' && (id === 'all' || g.league === id)).length;
  const withGames = enabled.filter((id) => all.some((g) => g.league === id));
  $('#filters').innerHTML = ['all', ...withGames]
    .map((id) => {
      const n = liveCount(id);
      return `<button class="chip" type="button" role="tab" data-filter="${id}" aria-selected="${S.filter === id}">${
        id === 'all' ? 'All' : esc(leagueShort(id))
      }${n ? `<span class="count">${n}</span>` : ''}</button>`;
    })
    .join('');

  const games = all.filter((g) => S.filter === 'all' || g.league === S.filter);
  const slotOf = new Map();
  visibleIds().forEach((id, i) => {
    const k = tileById(id).gameKey;
    if (k && tileById(id).sourceId) slotOf.set(k, i + 1);
  });
  const order = new Map(LEAGUES.map((l, i) => [l.id, i]));
  const hot = games.filter((g) => g.state === 'in' && g.heat?.score >= 35).sort((a, b) => b.heat.score - a.heat.score);
  const live = games
    .filter((g) => g.state === 'in' && !hot.includes(g))
    .sort((a, b) => order.get(a.league) - order.get(b.league) || b.heat.score - a.heat.score);
  const pre = games.filter((g) => g.state === 'pre').sort((a, b) => new Date(a.date) - new Date(b.date)).slice(0, 60);
  const post = games.filter((g) => g.state === 'post').sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 40);

  const section = (title, list, ico = '') =>
    list.length ? `<h3>${ico}${esc(title)}</h3>${list.map((g) => gameRow(g, slotOf.get(g.key))).join('')}` : '';
  let html =
    section('Hot right now', hot, icon('flame')) + section('Live', live) + section('Coming up', pre) + section('Final', post);
  const freeHtml = S.filter === 'all' ? freeSectionHtml() : '';
  if (!html && freeHtml) html = '<p class="empty">No scoreboard games right now in the leagues you follow.</p>';
  else if (!html) {
    html = board.updatedAt
      ? `<p class="empty">No games today in the leagues you follow. Add more in Settings.</p>`
      : board.errors.size
      ? `<p class="empty">Can't reach the scoreboard right now. Retrying…</p>`
      : `<p class="empty">Loading today's games…</p>`;
  }
  // Keep the "More free places" list open across refreshes if the viewer opened it.
  const moreOpen = !!$('.free-more[open]', gamesEl);
  gamesEl.innerHTML = freeHtml + html;
  if (moreOpen) $('.free-more', gamesEl)?.setAttribute('open', '');
}

$('#filters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-filter]');
  if (!b) return;
  S.filter = b.dataset.filter;
  renderGames();
  persist();
});
gamesEl.addEventListener('click', (e) => {
  const watch = e.target.closest('[data-free-watch]');
  if (watch) return watchFree(watch.dataset.freeWatch);
  const tryIt = e.target.closest('[data-free-try]');
  if (tryIt) return tryFreeChannel(tryIt.dataset.freeTry);
  const row = e.target.closest('.game');
  if (!row) return;
  if (overlayPanel.matches) {
    S.panel = false;
    renderBar();
  }
  openPicker({ gameKey: row.dataset.key });
});
gamesEl.addEventListener('dragstart', (e) => {
  const row = e.target.closest('.game');
  if (!row) return;
  e.dataTransfer.setData('application/x-whip-game', row.dataset.key);
  e.dataTransfer.setData('text/plain', row.dataset.key);
  e.dataTransfer.effectAllowed = 'copy';
});

// ---------- Score ticker: cycles through the scores a league at a time ----------

const TICKER_MS = 5000;
const tk = { pages: [], index: 0, timer: 0, hover: false, focus: false, sig: '', html: '' };
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

function tickerPages(width) {
  const now = Date.now();
  const order = new Map(LEAGUES.map((l, i) => [l.id, i]));
  const rank = (g) => (g.state === 'in' ? 0 : g.state === 'post' ? 1 : 2);
  const groups = new Map();
  for (const g of board.list()) {
    if (g.state === 'pre' && new Date(g.date) - now > 6 * 3600e3) continue;
    if (!groups.has(g.league)) groups.set(g.league, []);
    groups.get(g.league).push(g);
  }
  // A steady order, so the cycle doesn't jump around as scores change: leagues with live games
  // first, then games live → final → upcoming, each by start time.
  const hasLive = (list) => (list.some((g) => g.state === 'in') ? 0 : 1);
  const leagues = [...groups.entries()].sort((a, b) => hasLive(a[1]) - hasLive(b[1]) || order.get(a[0]) - order.get(b[0]));
  const per = Math.max(1, Math.min(6, Math.floor(width / 200)));
  const pages = [];
  for (const [league, list] of leagues) {
    list.sort((a, b) => rank(a) - rank(b) || new Date(a.date) - new Date(b.date) || a.key.localeCompare(b.key));
    const shown = list.slice(0, 36);
    for (let i = 0; i < shown.length; i += per) pages.push({ league, keys: shown.slice(i, i + per).map((g) => g.key) });
  }
  return pages;
}

function tickerCardInner(g) {
  const side = (t, other) => {
    const lead = g.state !== 'pre' && (t?.score ?? 0) > (other?.score ?? 0);
    const trail = g.state === 'post' && !lead;
    return `<span class="tk-team ${trail ? 'trail' : ''}">${logoFor(t) ? teamMark(t, 'tk-logo') : ''}<b>${esc(t?.abbr)}</b>${
      g.state === 'pre' ? '' : `<span class="s">${esc(t?.score ?? 0)}</span>`
    }</span>`;
  };
  return `${side(g.away, g.home)}${side(g.home, g.away)}<span class="st">${esc(statusText(g, formatKickoff))}</span>`;
}
const tickerCardClass = (g) => `tk ${g.state} ${g.heat?.score >= 35 ? 'hot' : ''}`;
const tickerCard = (g) =>
  `<button type="button" class="${tickerCardClass(g)}" data-key="${esc(g.key)}" title="${esc(`${g.away?.name} at ${g.home?.name}`)}">${tickerCardInner(g)}</button>`;

const tickerPageHtml = (p) =>
  p ? p.keys.map((k) => board.get(k)).filter(Boolean).map(tickerCard).join('') : `<span class="tk-empty">Scores show up here once games start.</span>`;

function showTickerPage(animate) {
  const stage = $('#tkStage');
  const p = tk.pages[tk.index];
  const focusedKey = stage.contains(document.activeElement) ? document.activeElement.dataset?.key : null;
  // The progress bar restarts below, so the flip timer restarts with it.
  clearTimeout(tk.timer);
  tk.timer = 0;
  $('#tkLeague').textContent = p ? leagueShort(p.league) : 'Scores';
  $('#tkCount').textContent = tk.pages.length > 1 ? `${tk.index + 1}/${tk.pages.length}` : '';
  tk.html = tickerPageHtml(p);
  const next = document.createElement('div');
  next.className = 'tk-page';
  next.innerHTML = tk.html;
  for (const old of [...stage.children]) {
    if (animate && !reduceMotion.matches) {
      old.classList.remove('in');
      old.classList.add('out');
      setTimeout(() => old.remove(), 400);
    } else {
      old.remove();
    }
  }
  if (animate && !reduceMotion.matches) next.classList.add('in');
  stage.append(next);
  // Keep keyboard users on the ticker: same game if it's still shown, else the first one.
  if (focusedKey !== null) {
    const target = $$('.tk', next).find((b) => b.dataset.key === focusedKey) || $('.tk', next);
    target?.focus({ preventScroll: true });
  }
  const bar = $('#tkProgress');
  bar.hidden = tk.pages.length <= 1;
  bar.style.animation = 'none';
  void bar.offsetWidth;
  bar.style.animation = '';
}

function scheduleTicker() {
  if (tk.timer || tk.pages.length <= 1) return;
  tk.timer = setTimeout(() => {
    tk.timer = 0;
    if (!tk.hover && !tk.focus && !document.hidden && S.ticker && tk.pages.length > 1) {
      tk.index = (tk.index + 1) % tk.pages.length;
      showTickerPage(true);
    }
    scheduleTicker();
  }, TICKER_MS);
}

/** Rebuild the cycle after a score update, staying on the games currently shown. */
function renderTicker() {
  // While the ticker is hidden (turned off, cinema mode) it has no width; keep the last layout.
  const width = $('#tkStage').clientWidth;
  if (!width) return;
  const pages = tickerPages(width);
  const sig = pages.map((p) => `${p.league}:${p.keys.join(',')}`).join('|');
  if (sig !== tk.sig) {
    const shownKeys = tk.pages[tk.index]?.keys.join() ?? null;
    const showing = tk.pages[tk.index]?.keys[0];
    tk.pages = pages;
    tk.sig = sig;
    const at = showing ? pages.findIndex((p) => p.keys.includes(showing)) : -1;
    tk.index = at >= 0 ? at : 0;
    // Only redraw (and restart the 5s clock) if what's on screen actually changed.
    if (pages[tk.index]?.keys.join() !== shownKeys || !$('#tkStage .tk-page:not(.out)')) showTickerPage(false);
    else $('#tkCount').textContent = pages.length > 1 ? `${tk.index + 1}/${pages.length}` : '';
  }
  if (sig === tk.sig) {
    // Same games: update each card in place so a focused card keeps focus.
    const cur = $('#tkStage .tk-page:not(.out)');
    for (const btn of cur ? $$('.tk[data-key]', cur) : []) {
      const g = board.get(btn.dataset.key);
      if (!g) continue;
      const inner = tickerCardInner(g);
      if (btn.dataset.html !== inner) {
        btn.innerHTML = inner;
        btn.dataset.html = inner;
      }
      const cls = tickerCardClass(g);
      if (btn.className !== cls) btn.className = cls;
    }
  }
  scheduleTicker();
}

const ticker = $('#ticker');
ticker.addEventListener('click', (e) => {
  const card = e.target.closest('.tk[data-key]');
  if (card) openPicker({ gameKey: card.dataset.key });
});
// Pause while a mouse is over it or a keyboard user is in it. Touch taps don't pause it:
// phones fire a hover on tap and may never fire the matching leave.
const resumeTicker = () => {
  if (tk.hover || tk.focus) return;
  ticker.classList.remove('paused');
  showTickerPage(false);
  scheduleTicker();
};
ticker.addEventListener('pointerenter', (e) => {
  if (e.pointerType !== 'mouse') return;
  tk.hover = true;
  ticker.classList.add('paused');
});
ticker.addEventListener('pointerleave', (e) => {
  if (e.pointerType !== 'mouse' || !tk.hover) return;
  tk.hover = false;
  resumeTicker();
});
ticker.addEventListener('focusin', () => {
  tk.focus = true;
  ticker.classList.add('paused');
});
ticker.addEventListener('focusout', (e) => {
  if (ticker.contains(e.relatedTarget)) return;
  tk.focus = false;
  resumeTicker();
});
// Re-split the pages whenever the ticker's width changes: rotation, resizing, or being shown again.
let tickerWidth = 0;
new ResizeObserver(() => {
  const w = $('#tkStage').clientWidth;
  if (!w || Math.abs(w - tickerWidth) < 8) return;
  tickerWidth = w;
  tk.sig = '';
  renderTicker();
}).observe($('#tkStage'));

function renderFeedStatus() {
  const el = $('#feedStatus');
  el.className = 'feed-status';
  if (DEMO) {
    el.classList.add('ok');
    el.textContent = 'Simulated games';
  } else if (board.updatedAt && board.ok) {
    el.classList.add('ok');
    el.textContent = `Updated ${secondsAgo(board.updatedAt)}`;
  } else if (board.errors.size) {
    el.classList.add('bad');
    el.textContent = board.updatedAt ? `Last update ${secondsAgo(board.updatedAt)}` : "Can't reach scores";
    el.title = [...board.errors.values()][0] || '';
  } else {
    el.textContent = 'Loading scores…';
  }
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

const dlg = $('#dlg');
let dlgCleanup = null;

function openDialog(title, build) {
  dlgCleanup?.();
  $('#dlgTitle').textContent = title;
  const body = $('#dlgBody');
  body.replaceChildren();
  dlgCleanup = build(body) || null;
  if (!dlg.open) dlg.showModal();
}
function closeDialog() {
  if (dlg.open) dlg.close();
}
dlg.addEventListener('close', () => {
  dlgCleanup?.();
  dlgCleanup = null;
  $('#dlgBody').replaceChildren();
});
dlg.addEventListener('click', (e) => {
  if (e.target === dlg || e.target.closest('[data-close]')) closeDialog();
});

function srcItem(s, { why = '', tag = 'button', acts = '' } = {}) {
  const initials = esc((s.network || s.name).replace(/[^A-Za-z0-9 ]/g, '').slice(0, 4).toUpperCase());
  const logo = s.logo && /^https?:\/\//.test(s.logo) ? `<img src="${esc(s.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : initials;
  const meta = [s.group, KIND_LABEL[s.kind] || s.kind].filter(Boolean).join(' · ');
  return `<${tag} class="src" ${tag === 'button' ? 'type="button"' : ''} data-src="${esc(s.id)}">
    <span class="logo">${logo}</span>
    <span style="min-width:0"><div class="nm">${esc(s.name)}</div><div class="meta">${esc(meta)}</div></span>
    ${why ? `<span class="why">${esc(why)}</span>` : acts ? `<span class="acts">${acts}</span>` : ''}
  </${tag}>`;
}

function gameCard(g) {
  const side = (t) =>
    `<div class="side">${teamMark(t, 'card-logo')}${
      g.state === 'pre' ? '' : `<span class="sc">${esc(t.score ?? 0)}</span>`
    }</div>`;
  const sit = situationText(g);
  return `<div class="gamecard">${side(g.away)}<div class="mid"><div>${esc(statusText(g, formatKickoff))}</div>${
    sit ? `<div class="sit">${esc(sit)}</div>` : ''
  }<div>${esc(g.networks.join(' · '))}</div></div>${side(g.home)}</div>`;
}

/**
 * Choose what plays where.
 * - from a game: suggest matching channels and pick a tile
 * - from a tile: choose a channel or paste a link, and which game it is
 */
function openPicker({ tileId = null, gameKey = null } = {}) {
  const g = board.get(gameKey);
  let target = tileId || defaultTileFor(gameKey);
  let linkGame = gameKey || tileById(target)?.gameKey || null;
  let linkTouched = false;
  const tileNo = () => S.order.indexOf(target) + 1;
  const title = g ? `${g.away?.abbr} @ ${g.home?.abbr}` : `Tile ${tileNo()}`;

  openDialog(title, (body) => {
    const choose = (sourceId) => {
      const s = src(sourceId);
      const t = tileById(target);
      let key;
      if (gameKey) key = gameKey;
      else if (linkTouched) key = linkGame;
      else key = (s && guessGameFor(s)) || (t.sourceId === sourceId ? t.gameKey : null);
      assign(target, sourceId, key, { noGame: linkTouched && !linkGame });
      closeDialog();
    };

    if (g) {
      const links = watchLinks(g.networks);
      body.append(
        h(`<div class="sec">${gameCard(g)}
          ${
            links.length || g.link
              ? `<div class="links">${links
                  .map((l) => `<a class="btn small ghost" href="${esc(l.href)}" target="_blank" rel="noopener">${icon('external')}${esc(l.label)}</a>`)
                  .join('')}${g.link ? `<a class="btn small ghost" href="${esc(g.link)}" target="_blank" rel="noopener">${icon('external')}Game details</a>` : ''}</div>`
              : ''
          }</div>`)
      );
    }

    // Which tile
    if (!tileId) {
      const vis = visibleIds();
      if (vis.length > 1) {
        const seg = h(`<div class="sec"><h3>Put it in</h3><div class="seg" role="group" aria-label="Tile"></div></div>`);
        const box = $('.seg', seg);
        const draw = () => {
          box.innerHTML = vis
            .map((id, i) => {
              const s = src(tileById(id).sourceId);
              return `<button type="button" data-tile="${id}" aria-pressed="${id === target}">${i + 1}${
                s ? `<small>${esc(s.name.slice(0, 14))}</small>` : '<small>empty</small>'
              }</button>`;
            })
            .join('');
        };
        draw();
        box.addEventListener('click', (e) => {
          const b = e.target.closest('[data-tile]');
          if (!b) return;
          target = b.dataset.tile;
          draw();
        });
        body.append(seg);
      }
    }

    // Suggestions for a game
    if (g) {
      const matches = matchSources(g, library, S).slice(0, 6);
      const sec = h(`<div class="sec"><h3>Best matches</h3><div class="list"></div></div>`);
      const list = $('.list', sec);
      if (matches.length) list.innerHTML = matches.map((m) => srcItem(m.source, { why: m.why })).join('');
      else
        list.outerHTML = `<p class="hint">No channel in your library matches ${
          g.networks.length ? `<b>${esc(g.networks.join(', '))}</b>` : 'this game'
        }. Paste a link below, or add channels with the Channels button.</p>`;
      sec.addEventListener('click', (e) => {
        const b = e.target.closest('[data-src]');
        if (b) choose(b.dataset.src);
      });
      body.append(sec);
    }

    // Library search
    if (library.length) {
      const sec = h(`<div class="sec"><h3>Your channels <span style="font-weight:600">(${library.length.toLocaleString()})</span></h3>
        <label class="search">${icon('search')}<input class="input" id="pickSearch" type="search" aria-label="Search your channels" placeholder="Search by name, network or group" autocomplete="off"></label>
        <div class="list" id="pickList"></div></div>`);
      const input = $('input', sec);
      const list = $('.list', sec);
      const draw = () => {
        const found = searchLibrary(library, input.value, 120);
        list.innerHTML = found.length ? found.map((s) => srcItem(s)).join('') : `<p class="hint">Nothing matches “${esc(input.value)}”.</p>`;
      };
      input.addEventListener('input', debounce(draw, 120));
      list.addEventListener('click', (e) => {
        const b = e.target.closest('[data-src]');
        if (b) choose(b.dataset.src);
      });
      draw();
      body.append(sec);
    }

    if (!library.length) {
      const empty = h(`<div class="sec"><h3>Your channels</h3>
        <p class="hint">No channels saved yet. Import the playlist from your TV service, or paste a single link below.</p>
        <div class="row"><button class="btn" type="button">Import a playlist</button></div></div>`);
      empty.querySelector('button').addEventListener('click', () => openChannels('import'));
      body.append(empty);
    }

    // Paste a link
    const paste = h(`<form class="sec" autocomplete="off">
      <h3>Paste a link</h3>
      <p class="hint">HLS (.m3u8), MPEG-TS, MP4, Twitch, a YouTube video, or a YouTube channel link (like youtube.com/@channel/live) to play whatever it's streaming live.</p>
      <div class="row">
        <input class="input grow" id="pickUrl" type="url" inputmode="url" placeholder="https://…/stream.m3u8" required>
        <input class="input" id="pickName" type="text" placeholder="Name (optional)" style="flex:0 1 180px">
        <button class="btn primary" type="submit">Play</button>
      </div>
      <p class="hint err-line" hidden></p>
    </form>`);
    paste.addEventListener('submit', (e) => {
      e.preventDefault();
      const url = $('#pickUrl', paste).value.trim();
      const err = $('.err-line', paste);
      if (!isLikelyUrl(url)) {
        err.hidden = false;
        err.textContent = 'Enter a full link starting with https://';
        return;
      }
      const existing = library.find((s) => s.url === url);
      if (existing && existing.kind !== 'demo') existing.kind = detectKind(url);
      const s = existing || makeSource({ name: $('#pickName', paste).value, url, group: 'Added links' });
      if (!existing) {
        setLibrary([...library, s]);
        persistLib();
      }
      choose(s.id);
    });
    body.append(paste);

    // Which game is on this tile
    if (tileId && !gameKey) {
      const games = board
        .list()
        .filter((x) => x.state !== 'post' || x.key === linkGame)
        .sort((a, b) => (a.state === b.state ? (b.heat?.score ?? 0) - (a.heat?.score ?? 0) : a.state === 'in' ? -1 : 1));
      const sec = h(`<div class="sec"><h3>Game on this tile</h3>
        <p class="hint">Links the score bug and lets Auto Whip rate this tile.</p>
        <select class="input" id="pickGame"><option value="">No game</option>${games
          .map(
            (x) =>
              `<option value="${esc(x.key)}" ${x.key === linkGame ? 'selected' : ''}>${esc(leagueShort(x.league))} · ${esc(gameLine(x))} · ${esc(
                statusText(x, formatKickoff)
              )}</option>`
          )
          .join('')}</select></div>`);
      const sel = $('select', sec);
      sel.addEventListener('change', () => {
        linkGame = sel.value || null;
        linkTouched = true;
        const t = tileById(target);
        if (t.sourceId) {
          t.gameKey = linkGame;
          t.noGame = !linkGame;
          if (linkGame) rememberPick(linkGame, t.sourceId);
          refresh();
        }
      });
      body.append(sec);
      if (tileById(tileId).sourceId) {
        const rm = h(`<div class="row"><button class="btn danger" type="button">${icon('close')}Empty this tile</button></div>`);
        rm.querySelector('button').addEventListener('click', () => {
          clearTile(tileId);
          closeDialog();
        });
        body.append(rm);
      }
    }
    if (!g && matchMedia('(pointer: fine)').matches) setTimeout(() => ($('#pickSearch', body) || $('#pickUrl', body))?.focus(), 30);
  });
}

function openChannels(tab = 'library') {
  openDialog('Channels', (body) => {
    const tabs = h(`<div class="tabs" role="tablist">
      <button type="button" role="tab" data-tab="library">Library</button>
      <button type="button" role="tab" data-tab="add">Add a link</button>
      <button type="button" role="tab" data-tab="import">Import playlist</button>
    </div>`);
    let pane = h(`<div class="sec"></div>`);
    body.append(tabs, pane);
    const show = (name) => {
      tab = name;
      $$('[data-tab]', tabs).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
      const fresh = h(`<div class="sec"></div>`);
      pane.replaceWith(fresh);
      pane = fresh;
      ({ library: libraryPane, add: addPane, import: importPane })[name](pane, show);
    };
    tabs.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (b) show(b.dataset.tab);
    });
    show(tab);
  });
}

function libraryPane(pane, show) {
  if (!library.length) {
    pane.append(
      h(`<div class="sec">
        <p class="hint">Your library is empty. Add a stream link or import an M3U playlist from your TV service (Channels DVR, Plex, Jellyfin, HDHomeRun, or an IPTV provider you subscribe to).</p>
        <div class="row"><button class="btn primary" type="button" data-go="add">${icon('plus')}Add a link</button>
        <button class="btn" type="button" data-go="import">Import playlist</button>
        <button class="btn ghost" type="button" data-test>Add test streams</button></div></div>`)
    );
  } else {
    const playlists = new Map();
    for (const s of library) {
      const k = s.playlist || '';
      playlists.set(k, (playlists.get(k) || 0) + 1);
    }
    const sec = h(`<div class="sec">
      <label class="search">${icon('search')}<input class="input" id="libSearch" type="search" aria-label="Search channels" placeholder="Search ${library.length.toLocaleString()} channels" autocomplete="off"></label>
      <div class="list" id="libList"></div>
      <div class="row" style="justify-content:space-between">
        <span class="hint">${library.length.toLocaleString()} channels</span>
        <span class="row">${
          library.some((s) => s.group === 'Test streams') ? '' : '<button class="btn small ghost" type="button" data-test>Add test streams</button>'
        }</span>
      </div>
    </div>`);
    const lists = [...playlists.entries()].filter(([k]) => k);
    const groups = lists.length
      ? h(`<div class="sec"><h3>Imported playlists</h3>${lists
          .map(
            ([k, n]) =>
              `<div class="row" style="justify-content:space-between"><span>${esc(k)} <span class="hint">· ${n.toLocaleString()} channels</span></span>
              <button class="btn small danger" type="button" data-rm-playlist="${esc(k)}">${icon('trash')}Remove</button></div>`
          )
          .join('')}</div>`)
      : null;
    pane.append(sec);
    if (groups) pane.append(groups);
    const input = $('input', sec);
    const list = $('.list', sec);
    const draw = () => {
      const found = searchLibrary(library, input.value, 200);
      list.innerHTML = found.length
        ? found
            .map((s) =>
              srcItem(s, {
                tag: 'div',
                acts: `<button class="btn small" type="button" data-play="${esc(s.id)}">Watch</button><button class="btn small ghost" type="button" title="Delete" data-del="${esc(
                  s.id
                )}">${icon('trash')}</button>`,
              })
            )
            .join('')
        : `<p class="hint">Nothing matches.</p>`;
    };
    input.addEventListener('input', debounce(draw, 120));
    draw();
    pane.addEventListener('click', (e) => {
      const play = e.target.closest('[data-play]');
      const del = e.target.closest('[data-del]');
      const rmp = e.target.closest('[data-rm-playlist]');
      if (play) {
        const s = src(play.dataset.play);
        const tile = defaultTileFor(null);
        assign(tile, s.id, guessGameFor(s));
        closeDialog();
      } else if (del) {
        removeSources((s) => s.id === del.dataset.del);
        draw();
      } else if (rmp) {
        const name = rmp.dataset.rmPlaylist;
        removeSources((s) => s.playlist === name);
        show('library');
      }
    });
  }
  pane.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) show(go.dataset.go);
    if (e.target.closest('[data-test]')) {
      const n = addToLibrary(TEST_STREAMS.map((t) => makeSource({ ...t, playlist: '' })));
      toast({ title: 'Test streams added', text: `${n} test streams are in your library. They're sample videos, not sports.` });
      show('library');
    }
  });
}

function addPane(pane, show) {
  const form = h(`<form class="sec" autocomplete="off">
    <div class="field"><label for="addUrl">Stream link</label>
      <input class="input" id="addUrl" type="url" inputmode="url" placeholder="https://…/index.m3u8, a YouTube or Twitch link" required></div>
    <div class="row">
      <div class="field grow"><label for="addName">Name</label><input class="input" id="addName" type="text" placeholder="e.g. CBS (local)"></div>
      <div class="field grow"><label for="addNet">Network it carries (optional)</label><input class="input" id="addNet" type="text" placeholder="e.g. CBS, ESPN, FOX"></div>
    </div>
    <p class="hint">Tag the network and Whiparound suggests this channel whenever a game airs on it.</p>
    <p class="hint err-line" hidden></p>
    <div class="row"><button class="btn primary" type="submit">Save channel</button></div>
  </form>`);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $('#addUrl', form).value.trim();
    const err = $('.err-line', form);
    if (!isLikelyUrl(url)) {
      err.hidden = false;
      err.textContent = 'Enter a full link starting with https://';
      return;
    }
    const n = addToLibrary([makeSource({ name: $('#addName', form).value, url, network: $('#addNet', form).value, group: 'Added links' })]);
    toast({ title: n ? 'Channel saved' : 'Already saved', text: n ? 'It is in your library.' : 'That link is already in your library.' });
    show('library');
  });
  pane.append(form);
  if (matchMedia('(pointer: fine)').matches) setTimeout(() => $('#addUrl', form)?.focus(), 30);
}

function importPane(pane, show) {
  const sec = h(`<div class="sec">
    <p class="hint">Import an M3U playlist from a service you use: Channels DVR, Plex or Jellyfin Live TV, HDHomeRun, or an IPTV subscription.</p>
    <form class="sec" id="impUrlForm" autocomplete="off">
      <div class="field"><label for="impUrl">Playlist link</label>
        <div class="row"><input class="input grow" id="impUrl" type="url" inputmode="url" placeholder="http://192.168.1.10:8089/devices/ANY/channels.m3u" required>
        <button class="btn primary" type="submit">Import</button></div></div>
    </form>
    <div class="field"><label for="impFile">Or a playlist file</label><input class="input" id="impFile" type="file" accept=".m3u,.m3u8,audio/x-mpegurl,application/vnd.apple.mpegurl,text/plain"></div>
    <div class="field"><label for="impFilter">Only keep channels whose name or group contains (optional)</label>
      <input class="input" id="impFilter" type="text" placeholder="e.g. sports, espn, nfl"></div>
    <p class="hint" id="impStatus" role="status"></p>
  </div>`);
  pane.append(sec);
  const status = $('#impStatus', sec);
  const ingest = (text, name) => {
    const entries = parseM3U(text);
    if (!entries.length) throw new Error("That file doesn't look like an M3U playlist.");
    const words = normName($('#impFilter', sec).value).split(' ').filter(Boolean);
    const kept = words.length
      ? entries.filter((x) => {
          const hay = normName(`${x.name} ${x.group}`);
          return words.some((w) => hay.includes(w));
        })
      : entries;
    const n = addToLibrary(kept.map((x) => makeSource({ name: x.name, url: x.url, group: x.group, logo: x.logo, playlist: name })));
    toast({ title: 'Playlist imported', text: `Added ${n.toLocaleString()} of ${entries.length.toLocaleString()} channels from ${name}.` });
    show('library');
  };
  $('#impUrlForm', sec).addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = $('#impUrl', sec).value.trim();
    status.textContent = 'Downloading…';
    try {
      const text = await fetchText(url);
      let name = url;
      try {
        name = new URL(url).hostname;
      } catch {}
      ingest(text, name);
    } catch (err) {
      status.textContent = err.message;
    }
  });
  $('#impFile', sec).addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    status.textContent = 'Reading…';
    try {
      ingest(await f.text(), f.name);
    } catch (err) {
      status.textContent = err.message;
    }
  });
}

function addToLibrary(items) {
  const urls = new Set(library.map((s) => s.url));
  const added = [];
  for (const s of items) {
    if (urls.has(s.url)) continue;
    urls.add(s.url);
    added.push(s);
  }
  if (added.length) {
    setLibrary([...library, ...added]);
    persistLib().then((ok) => {
      if (!ok) toast({ title: "Couldn't save", text: 'Your browser refused to store the channel library. Private browsing can cause this.' });
    });
    renderWelcome();
  }
  return added.length;
}

function removeSources(pred) {
  const gone = new Set(library.filter(pred).map((s) => s.id));
  if (!gone.size) return;
  setLibrary(library.filter((s) => !gone.has(s.id)));
  for (const t of S.tiles) {
    if (gone.has(t.sourceId)) {
      t.sourceId = null;
      t.gameKey = null;
    }
  }
  persistLib();
  refresh();
}

function openSettings() {
  openDialog('Settings', (body) => {
    const leagues = h(`<div class="sec"><h3>Leagues on the scoreboard</h3>
      <div class="checks">${LEAGUES.map(
        (l) =>
          `<label class="check"><input type="checkbox" value="${l.id}" ${S.leagues.includes(l.id) ? 'checked' : ''} ${DEMO ? 'disabled' : ''}>${esc(l.label)}</label>`
      ).join('')}</div>${DEMO ? '<p class="hint">The demo uses its own simulated leagues.</p>' : ''}</div>`);
    leagues.addEventListener('change', () => {
      S.leagues = $$('input:checked', leagues).map((i) => i.value);
      board.setLeagues(S.leagues);
      persist();
    });

    const whip = h(`<div class="sec"><h3>Auto Whip</h3>
      <div class="field"><label for="holdSec">Stay on a game for at least</label>
        <select class="input" id="holdSec">${[10, 15, 25, 45, 90]
          .map((n) => `<option value="${n}" ${S.holdSec === n ? 'selected' : ''}>${n} seconds</option>`)
          .join('')}</select></div>
      <label class="switch-row"><div><b>Fill tiles with hot games${ent.autoFill ? '' : ' <span class="pro-tag">Pro</span>'}</b><span>When a game you have a saved stream for heats up, swap it into the coldest tile.</span></div><input type="checkbox" id="autoFill" ${S.autoFill && ent.autoFill ? 'checked' : ''} ${ent.autoFill ? '' : 'disabled'}></label>
      <label class="switch-row"><div><b>Hot game alerts${ent.alerts ? '' : ' <span class="pro-tag">Pro</span>'}</b><span>Tell me when a game that isn't on screen hits the red zone, crunch time, and so on.</span></div><input type="checkbox" id="alerts" ${S.alerts && ent.alerts ? 'checked' : ''} ${ent.alerts ? '' : 'disabled'}></label>
      ${ent.autoWhip ? '' : '<button class="btn small primary" type="button" id="settingsUpgrade">See Pro</button>'}
    </div>`);
    $('#settingsUpgrade', whip)?.addEventListener('click', () => openUpgrade('generic'));
    $('#holdSec', whip).addEventListener('change', (e) => {
      S.holdSec = Number(e.target.value);
      persist();
    });
    $('#autoFill', whip).addEventListener('change', (e) => {
      S.autoFill = e.target.checked;
      persist();
    });
    $('#alerts', whip).addEventListener('change', (e) => {
      S.alerts = e.target.checked;
      persist();
    });

    const freeSec = h(`<div class="sec"><h3>Free games</h3>
      <label class="switch-row"><div><b>Start with free games</b><span>When you open Whiparound, put official free live streams in your empty tiles.</span></div><input type="checkbox" id="freeAuto" ${S.freeAuto ? 'checked' : ''}></label>
    </div>`);
    $('#freeAuto', freeSec).addEventListener('change', (e) => {
      S.freeAuto = e.target.checked;
      persist();
      if (S.freeAuto) syncFreeTiles(false);
    });
    body.append(freeSec);

    const disp = h(`<div class="sec"><h3>Display</h3>
      <label class="switch-row"><div><b>Score ticker</b><span>Scores cycle along the bottom of the screen, a league at a time.</span></div><input type="checkbox" id="tickerOn" ${S.ticker ? 'checked' : ''}></label>
    </div>`);
    $('#tickerOn', disp).addEventListener('change', (e) => {
      S.ticker = e.target.checked;
      renderBar();
      persist();
    });

    const data = h(`<div class="sec"><h3>Your setup</h3>
      <p class="hint">Channels and settings live in this browser only. Export them to move to another device.</p>
      <div class="row" ${EMBED ? 'hidden' : ''}>
        <button class="btn" type="button" id="exportBtn">Export setup</button>
        <label class="btn" for="importSetup">Import setup</label><input id="importSetup" type="file" accept="application/json,.json" hidden>
        ${DEMO ? `<a class="btn primary" href="${esc(location.pathname)}">Leave demo</a>` : `<a class="btn ghost" href="?demo">Open the demo</a>`}
      </div>
      ${EMBED ? '<p class="hint">This is a preview with simulated games. Real streams and live scores need the full app running on your computer (npm start).</p>' : ''}
      <div class="row" id="resetRow"><button class="btn danger" type="button" id="resetBtn">${icon('trash')}Reset everything</button></div>
    </div>`);
    $('#exportBtn', data).addEventListener('click', () => {
      const blob = new Blob([JSON.stringify({ app: 'whiparound', v: 1, settings: S, library }, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'whiparound-setup.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
    $('#importSetup', data).addEventListener('change', async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      try {
        const json = JSON.parse(await f.text());
        if (json.app !== 'whiparound') throw new Error('Not a Whiparound setup file.');
        storage.saveSettings(json.settings);
        await storage.saveLibrary(json.library || []);
        location.reload();
      } catch (err) {
        toast({ title: "Couldn't import", text: err.message });
      }
    });
    $('#resetBtn', data).addEventListener('click', () => {
      const row = $('#resetRow', data);
      row.innerHTML = `<span class="hint">This removes every channel and setting.</span>
        <button class="btn danger" type="button" id="resetYes">Yes, reset</button><button class="btn ghost" type="button" id="resetNo">Cancel</button>`;
      $('#resetNo', row).addEventListener('click', () => openSettings());
      $('#resetYes', row).addEventListener('click', async () => {
        await storage.clearAll();
        location.href = location.pathname;
      });
    });

    body.append(leagues, whip, disp, data);
  });
}

function openHelp() {
  openDialog('How it works', (body) => {
    body.append(
      h(`<div class="sec prose">
        <p><b>Whiparound plays streams you already have access to</b> and wraps them in a multiview with live scores. Add channels from your TV service, link each tile to a game, and turn on Auto Whip.</p>
        <ul>
          <li><b>Auto Whip</b> rates every live game on your tiles: red zone, fourth down, two-minute drill, crunch time, bases loaded, a one-goal game late. The hottest one moves to the main tile and gets the sound.</li>
          <li><b>Sound</b> follows the tile with the yellow frame. Tap any tile to move it there.</li>
          <li><b>Double-click or double-tap</b> a tile to watch it alone; do it again to go back.</li>
          <li><b>Drag a game</b> from the list onto a tile, or drag one tile onto another to swap them.</li>
        </ul>
      </div>`),
      h(`<div class="sec"><h3>Keyboard</h3><div class="kbd-list">
        <span><kbd>1</kbd>–<kbd>9</kbd></span><span>Sound on that tile</span>
        <span><kbd>⇧</kbd> + <kbd>1</kbd>–<kbd>9</kbd></span><span>Make that tile the main one</span>
        <span><kbd>W</kbd></span><span>Auto Whip on or off</span>
        <span><kbd>L</kbd></span><span>Next layout</span>
        <span><kbd>M</kbd></span><span>Mute all</span>
        <span><kbd>F</kbd></span><span>Full screen</span>
        <span><kbd>G</kbd></span><span>Show or hide games</span>
        <span><kbd>C</kbd></span><span>Channels</span>
      </div></div>`),
      h(`<div class="sec prose"><h3 style="margin:0;font:700 13px/1 var(--f-num);letter-spacing:.12em;text-transform:uppercase;color:var(--dim)">Where streams come from</h3>
        <ul>
          <li><b>Your own TV tuner or DVR</b>: Channels DVR, Plex, Jellyfin, Emby and HDHomeRun (via one of those) all export an M3U playlist. An antenna gets you CBS, FOX, NBC and ABC, which carry most NFL games.</li>
          <li><b>IPTV or league services</b> that give you an M3U or .m3u8 link.</li>
          <li><b>Free official streams</b> on YouTube or Twitch: paste the link. A YouTube channel link such as <code>youtube.com/@channel/live</code> plays whatever the channel is streaming, and switches by itself when it moves on to its next stream.</li>
          <li><b>ESPN+, Peacock, Prime Video, Paramount+, YouTube TV, Sunday Ticket</b> are DRM-protected and only play in their own apps. Use the links on each game to open them.</li>
        </ul>
        <p>If a stream won't play in the browser because of CORS, run Whiparound on your computer with <code>npm start</code>. It relays streams for you.</p>
      </div>`)
    );
  });
}

// ---------------------------------------------------------------------------
// Welcome
// ---------------------------------------------------------------------------

const bootAt = Date.now();
function renderWelcome() {
  const el = $('#welcome');
  // Give the free-games check a moment first, so the welcome card doesn't flash over games about to load.
  if (!DEMO && !EMBED && !freeNow.loaded && Date.now() - bootAt < 2500) {
    setTimeout(renderWelcome, 2600 - (Date.now() - bootAt));
    return;
  }
  const show = !DEMO && !S.seenIntro && !library.length && !S.tiles.some((t) => t.sourceId);
  if (!show) {
    el.hidden = true;
    return;
  }
  if (!el.hidden) return;
  el.hidden = false;
  el.innerHTML = `<div class="welcome-card" role="dialog" aria-labelledby="welcomeTitle">
    <h1 id="welcomeTitle">Every game.<br><em>One screen.</em></h1>
    <p>Whiparound plays the streams you already have, up to nine at once, with live scores on each tile. Auto Whip jumps to whichever game has the most going on.</p>
    <ol class="steps">
      <li><span class="n">1</span><div><b>Add your channels</b><span>Paste stream links, or import the M3U playlist from Channels DVR, Plex, Jellyfin or your IPTV service.</span></div></li>
      <li><span class="n">2</span><div><b>Pick games</b><span>Tap a game on the scoreboard and choose a channel. Each tile gets a live score bug.</span></div></li>
      <li><span class="n">3</span><div><b>Turn on Auto Whip</b><span>Red zone, crunch time, bases loaded: the hottest game gets the big screen and the sound.</span></div></li>
    </ol>
    <div class="welcome-actions">
      <button class="btn primary" type="button" data-w="channels">${icon('tv')}Add your channels</button>
      <a class="btn" href="?demo">${icon('bolt')}Try the demo</a>
      <button class="btn ghost" type="button" data-w="skip">Look around first</button>
    </div>
  </div>`;
  el.onclick = (e) => {
    const b = e.target.closest('[data-w]');
    if (!b) return;
    S.seenIntro = true;
    persist();
    el.hidden = true;
    if (b.dataset.w === 'channels') openChannels('add');
  };
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

function toast({ title = '', text = '', kind = 'info', actions = [], ttl = 6000 }) {
  const box = $('#toasts');
  const el = h(`<div class="toast ${kind}"><div class="tx">${title ? `<b>${esc(title)}</b>` : ''}${esc(text)}</div></div>`);
  for (const a of actions) {
    const b = h(`<button class="btn small ${a.primary ? 'primary' : ''}" type="button">${esc(a.label)}</button>`);
    b.addEventListener('click', () => {
      el.remove();
      a.fn();
    });
    el.append(b);
  }
  const x = h(`<button class="icon-btn" type="button" title="Dismiss">${icon('close')}</button>`);
  x.addEventListener('click', () => el.remove());
  el.append(x);
  box.append(el);
  while (box.children.length > 3) box.firstElementChild.remove();
  setTimeout(() => el.remove(), ttl);
}

// ---------------------------------------------------------------------------
// Keyboard, wake lock, boot
// ---------------------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || dlg.open) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  const digit = /^Digit([1-9])$/.exec(e.code);
  if (digit) {
    const id = visibleIds()[Number(digit[1]) - 1];
    if (!id || !tileById(id).sourceId) return;
    e.preventDefault();
    return e.shiftKey ? makeMain(id, { manual: true }) : setAudio(id, { manual: true });
  }
  switch (e.key.toLowerCase()) {
    case 'w':
      return toggleWhip();
    case 'm':
      return toggleMute();
    case 'f':
      return toggleFullscreen();
    case 'g':
      return togglePanel();
    case 'c':
      return openChannels();
    case 'l': {
      const open = LAYOUTS.filter((l) => allowedLayout(l.id));
      const i = open.findIndex((l) => l.id === S.layout);
      return setLayout(open[(i + 1) % open.length].id);
    }
    case '?':
      return openHelp();
    case 'escape':
      if ($('#app').classList.contains('cinema')) return toggleFullscreen();
      if (S.layout === '1' && S.soloFrom) return toggleSolo(S.order[0]);
  }
});

// Keep the screen awake while watching.
let wakeLock = null;
async function keepAwake() {
  if (!('wakeLock' in navigator) || document.hidden || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => (wakeLock = null));
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    keepAwake();
    board.refresh();
  }
});
document.addEventListener('pointerdown', keepAwake, { once: true });

async function boot() {
  buildBar();
  const exit = h(`<button class="btn small cinema-exit" id="cinemaExit" type="button" hidden>${icon('close')}Exit full screen</button>`);
  exit.addEventListener('click', toggleFullscreen);
  $('#stage').append(exit);
  for (const t of S.tiles) {
    const v = createTileView(t);
    views.set(t.id, v);
    grid.append(v.el);
  }
  applyLayoutAttr();
  // Saved links get their type re-checked, so links saved before a new link type existed still play.
  setLibrary(DEMO ? demo.setup().library : (await storage.loadLibrary()).map((s) => (s.kind === 'demo' ? s : { ...s, kind: detectKind(s.url) })));
  const [cfg] = await Promise.all([DEMO ? null : loadConfig(), detectProxy()]);
  if (cfg) startPaidMode(cfg);
  openDeepLink();
  refresh();
  board.start();
  renderTicker();
  setInterval(renderFeedStatus, 5000);
  if (!DEMO && !EMBED) {
    refreshFree({ initial: true });
    setInterval(refreshFree, 5 * 60e3);
    document.addEventListener('visibilitychange', () => !document.hidden && refreshFree());
  }
  if (DEMO) {
    toast({
      title: EMBED ? 'Preview with simulated games' : 'Demo mode',
      text: 'Four simulated NFL games with Auto Whip on. Watch the main tile jump to red-zone drives.',
      ttl: 8000,
    });
  }
}

boot();

/**
 * A shared link like ?watch=<stream or channel link>&name=High Point vs Liberty opens the app
 * with that stream in the main tile, ready to watch.
 */
function openDeepLink() {
  if (DEMO) return;
  const watch = params.get('watch');
  if (!watch || !isLikelyUrl(watch)) return;
  let s = library.find((x) => x.url === watch.trim());
  if (!s) {
    s = makeSource({ name: params.get('name') || '', url: watch, group: 'Added links' });
    setLibrary([...library, s]);
    persistLib();
  }
  S.seenIntro = true;
  if (!layoutById(S.layout).main) S.layout = '1+3';
  applyLayoutAttr();
  const main = S.order[0];
  const t = tileById(main);
  t.sourceId = s.id;
  t.gameKey = null;
  t.noGame = false;
  t.filledAt = Date.now();
  t.liveVideoId = null;
  S.audio = main;
  try {
    history.replaceState(null, '', location.pathname);
  } catch {}
}


// ---------------------------------------------------------------------------
// Free, legal games: official free streams that are live right now
// ---------------------------------------------------------------------------

let freeNow = { live: [], updatedAt: null, stale: false, loaded: false };
let freeCatalog = [];

async function refreshFree({ initial = false } = {}) {
  const [now, catalog] = await Promise.all([loadFreeNow(), freeCatalog.length ? freeCatalog : loadCatalog()]);
  freeCatalog = catalog;
  freeNow = { ...now, loaded: true };
  syncFreeTiles(initial);
  renderGames();
}

/** A library entry for a free live video (created on first use, tagged so it can be tidied later). */
function freeSourceFor(item) {
  const url = watchUrl(item.videoId);
  let s = library.find((x) => x.url === url);
  if (!s) {
    s = makeSource({ name: `${item.source}: ${item.title}`.slice(0, 140), url, group: 'Free right now', network: item.source });
    s.freeChannel = item.sourceId || item.source;
    setLibrary([...library, s]);
  }
  return s;
}

const freeItemFor = (videoId) => freeNow.live.find((x) => x.videoId === videoId);

/**
 * Free channels also stream shows, press conferences and podcasts. Only streams that look like a
 * game ("A vs. B", "A at B", or a matchup on the scoreboard) go into tiles on their own;
 * everything else is listed with a Watch button.
 */
const MATCHUP = /\s(?:vs?\.?|versus|@)\s|\b[A-Z][\w.'&-]*(?:\s+[A-Z][\w.'&-]*)*\s+at\s+[A-Z]/;
const looksLikeGame = (item) => MATCHUP.test(item.title || '') || !!gameFromTitle(item.title || '');

function placeFree(tileId, item) {
  const t = tileById(tileId);
  const s = freeSourceFor(item);
  t.sourceId = s.id;
  t.gameKey = gameFromTitle(item.title) || null;
  t.noGame = false;
  t.filledAt = Date.now();
  t.liveVideoId = item.videoId;
  t.auto = 'free';
}

/**
 * Keep free tiles current: swap an ended stream for the same channel's next one (or another free
 * game), and, when "Start with free games" is on, fill empty tiles. Tiles you filled are never touched.
 */
function syncFreeTiles(initial) {
  if (DEMO) return;
  const rank = { live: 0, onair: 1, upcoming: 2 };
  const items = [...freeNow.live].sort((a, b) => {
    const ga = board.get(gameFromTitle(a.title));
    const gb = board.get(gameFromTitle(b.title));
    return (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || (gb?.heat?.score ?? 0) - (ga?.heat?.score ?? 0);
  });
  // Only games that are on (or just about to be) go into tiles by themselves; later ones are listed.
  const onNow = (x) => x.status === 'live' || x.status === 'onair';
  const onScreen = () => new Set(S.tiles.map((t) => src(t.sourceId)?.url).filter(Boolean));
  let changed = false;

  for (const t of S.tiles) {
    if (t.auto !== 'free' || !t.sourceId) continue;
    const s = src(t.sourceId);
    const vid = /[?&]v=([\w-]{11})/.exec(s?.url || '')?.[1];
    if (vid && freeItemFor(vid)) continue; // still live
    if (freeNow.stale || !freeNow.loaded) continue; // no fresh data: leave it alone
    const next = items.find((x) => (x.sourceId || x.source) === s?.freeChannel && onNow(x) && x.embeddable !== false && looksLikeGame(x) && !onScreen().has(watchUrl(x.videoId)));
    if (next) placeFree(t.id, next);
    else {
      t.sourceId = null;
      t.gameKey = null;
      t.auto = null;
    }
    changed = true;
  }

  if (S.freeAuto) {
    for (const id of visibleIds()) {
      if (tileById(id).sourceId) continue;
      const item = items.find((x) => onNow(x) && x.embeddable !== false && looksLikeGame(x) && !onScreen().has(watchUrl(x.videoId)));
      if (!item) break;
      placeFree(id, item);
      changed = true;
    }
  }

  // Tidy the library: drop free entries that ended and aren't on a tile.
  const inUse = new Set(S.tiles.map((t) => t.sourceId));
  const keep = library.filter((s) => s.group !== 'Free right now' || inUse.has(s.id) || freeItemFor(/[?&]v=([\w-]{11})/.exec(s.url)?.[1]));
  if (keep.length !== library.length) {
    setLibrary(keep);
    changed = true;
  }

  if (changed) {
    if (initial && S.tiles.some((t) => t.auto === 'free' && t.sourceId)) S.seenIntro = true;
    persistLib();
    refresh();
  }
}

function watchFree(videoId) {
  const item = freeItemFor(videoId);
  if (!item) return;
  const showing = S.tiles.find((t) => src(t.sourceId)?.url === watchUrl(videoId));
  if (showing) return setAudio(showing.id, { manual: true });
  const tile = defaultTileFor(null);
  placeFree(tile, item);
  S.audio = tile;
  persistLib();
  refresh();
  if (overlayPanel.matches) {
    S.panel = false;
    renderBar();
  }
}

/** Play whatever a free channel is streaming, via YouTube's channel player (no check needed). */
function tryFreeChannel(sourceId) {
  const s = freeCatalog.find((x) => x.id === sourceId);
  if (!s) return;
  const url = `https://www.youtube.com/channel/${s.youtubeChannelId}/live`;
  let lib = library.find((x) => x.url === url);
  if (!lib) {
    lib = makeSource({ name: `${s.name} (live)`, url, group: 'Added links' });
    setLibrary([...library, lib]);
    persistLib();
  }
  const tile = defaultTileFor(null);
  assign(tile, lib.id, null);
  S.audio = tile;
  refresh();
}

function freeSectionHtml() {
  if (DEMO || EMBED) return '';
  if (!freeNow.loaded) return `<section class="free-sec" aria-label="Free right now"><h3>${icon('tv')}Free right now</h3><p class="free-empty">Checking for free games…</p></section>`;
  const tileOf = new Map();
  visibleIds().forEach((id, i) => {
    const url = src(tileById(id).sourceId)?.url;
    if (url) tileOf.set(url, i + 1);
  });
  const rows = freeNow.live
    .map((x) => {
      const slot = tileOf.get(watchUrl(x.videoId));
      return `<div class="free-item">
        <span class="fr-badge ${x.status === 'live' ? 'live' : x.status === 'onair' ? 'onair' : 'soon'}">${x.status === 'live' ? 'Live' : x.status === 'onair' ? 'On air' : 'Later'}</span>
        <div class="fr-text"><b>${esc(x.title)}</b><span>${esc(x.source)} · free on YouTube</span></div>
        ${
          x.embeddable === false
            ? `<a class="btn small" href="${esc(watchUrl(x.videoId))}" target="_blank" rel="noopener" title="This channel only allows watching on YouTube">${icon('external')}YouTube</a>`
            : `<button class="btn small ${slot ? 'ghost' : 'primary'}" type="button" data-free-watch="${esc(x.videoId)}">${slot ? `Tile ${slot}` : 'Watch'}</button>`
        }
      </div>`;
    })
    .join('');
  const checked = freeNow.updatedAt ? ` Checked ${secondsAgo(new Date(freeNow.updatedAt).getTime())}.` : '';
  // Channels YouTube wouldn't let the check see: offer them, but don't auto-load (if nothing is
  // live, YouTube's channel player only says "Video unavailable").
  const unseen = (freeNow.unseen || [])
    .map((id) => freeCatalog.find((s) => s.id === id))
    .filter((s) => s && /^UC[\w-]{22}$/.test(s.youtubeChannelId || '') && !freeNow.live.some((x) => x.sourceId === s.id));
  const unseenRows = unseen
    .map(
      (s) => `<div class="free-item">
        <span class="fr-badge soon">Maybe</span>
        <div class="fr-text"><b>${esc(s.name)}</b><span>${esc(s.whatStreamsFree || '')} · YouTube didn’t let the check see if it’s live</span></div>
        <span class="row" style="gap:6px;flex-wrap:nowrap"><button class="btn small" type="button" data-free-try="${esc(s.id)}">Try it</button><a class="btn small ghost" href="https://www.youtube.com/channel/${esc(s.youtubeChannelId)}/live" target="_blank" rel="noopener" title="Open on YouTube">${icon('external')}</a></span>
      </div>`
    )
    .join('');
  const empty = freeNow.missing
    ? '<p class="free-empty">Live free games show up here once the free-games check has run. It runs every 15 minutes. The places below are always free.</p>'
    : freeNow.stale
    ? '<p class="free-empty">The free-games check hasn’t run recently, so live streams can’t be listed. The places below are always free.</p>'
    : freeNow.allFailed
    ? '<p class="free-empty">The free-games check couldn’t reach YouTube this time. It tries again every 15 minutes. The places below are always free.</p>'
    : `<p class="free-empty">No official free streams are live right now.${esc(checked)} The places below are always free.</p>`;
  const web = freeCatalog.filter((s) => s.kind === 'web');
  const more = web.length
    ? `<details class="free-more"><summary>More free places to watch (${web.length})</summary>${web
        .map(
          (s) => `<a class="fr-web" href="${esc(s.url)}" target="_blank" rel="noopener">
            <b>${esc(s.name)}${icon('external')}</b><span>${esc(s.whatStreamsFree || '')}${s.needsAccount ? ' · free account' : ''}</span></a>`
        )
        .join('')}</details>`
    : '';
  return `<section class="free-sec" aria-label="Free right now"><h3>${icon('tv')}Free right now</h3>${rows || (unseenRows ? '' : empty)}${unseenRows}${more}</section>`;
}

// ---------------------------------------------------------------------------
// Paid mode: plans, sign-in, upgrade, account
// ---------------------------------------------------------------------------

function startPaidMode(cfg) {
  PAID = true;
  config = cfg;
  setLogosEnabled(cfg.logos === true);
  if (cfg.scores === 'server') {
    board.setSource(async (l) => {
      // Default caching on purpose: 'no-store' would force the CDN to refetch from the provider.
      const r = await fetch(new URL(`api/scores?league=${encodeURIComponent(l.id)}`, location.href));
      if (!r.ok) throw new Error(`Scores are unavailable right now (${r.status}).`);
      return r.json();
    });
  }
  account = createAccount(cfg, applyEntitlements);
  applyEntitlements();
  account.init().then(handleCheckoutReturn);
}

function applyEntitlements() {
  ent = entitlements(PAID ? 'paid' : 'personal', account?.state.plan);
  // Only fall back to a Free layout once the server has confirmed the plan, so a Pro
  // subscriber's layout isn't lost while the page is still checking.
  if (account?.state.ready && !allowedLayout(S.layout)) {
    S.layout = '2';
    S.soloFrom = null;
    applyLayoutAttr();
  }
  refresh({ games: false });
}

const fmtDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
};

function planLine() {
  const s = account?.state;
  if (!s || s.plan !== 'pro') return 'Free plan';
  if (s.status === 'trialing' && s.trialEnd) return `Pro, free trial until ${fmtDate(s.trialEnd)}`;
  if (s.status === 'past_due') return 'Pro, but your last payment failed. Update your card in Manage billing.';
  if (s.cancelAtPeriodEnd && s.periodEnd) return `Pro until ${fmtDate(s.periodEnd)}, then Free`;
  if (s.periodEnd) return `Pro, renews ${fmtDate(s.periodEnd)}`;
  return 'Pro';
}

async function handleCheckoutReturn() {
  const result = params.get('checkout');
  if (!result) return;
  try {
    const u = new URL(location.href);
    u.searchParams.delete('checkout');
    u.searchParams.delete('session_id');
    history.replaceState(null, '', u.pathname + u.search);
  } catch {}
  if (result === 'cancel') return toast({ title: 'Checkout canceled', text: "You're still on Free. You can upgrade any time." });
  if (result !== 'success') return;
  toast({ title: 'Setting up Pro', text: 'Confirming your subscription…', ttl: 4000 });
  // Stripe tells our server through a webhook, which can take a few seconds.
  for (let i = 0; i < 12 && account.state.plan !== 'pro'; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    await account.refreshPlan();
  }
  if (account.state.plan === 'pro') toast({ title: 'Welcome to Pro', text: `${planLine()}. Everything is unlocked.`, ttl: 8000 });
  else toast({ title: 'Payment received', text: "Pro will switch on in a moment. If it hasn't after a minute, reload the page.", ttl: 10000 });
}

const planCell = (v) =>
  v === true ? `<span class="yes" aria-label="Included">${icon('check')}</span>` : v === false ? '<span class="no" aria-label="Not included">–</span>' : esc(v);

function openUpgrade(reason = 'generic') {
  if (!PAID || !account) return;
  const s = account.state;
  const prices = config.prices || {};
  const trialDays = Number(config.trialDays) || 0;
  let interval = prices.year ? 'year' : 'month';
  openDialog('Whiparound Pro', (body) => {
    body.append(
      h(`<div class="sec"><p class="lead">${esc(UPGRADE_REASONS[reason] || UPGRADE_REASONS.generic)}</p></div>`),
      h(`<div class="sec"><table class="plans"><thead><tr><th scope="col"><span class="visually-hidden">Feature</span></th><th scope="col">Free</th><th scope="col" class="pro">Pro</th></tr></thead>
        <tbody>${PLAN_ROWS.map(([label, free, pro]) => `<tr><th scope="row">${esc(label)}</th><td>${planCell(free)}</td><td class="pro">${planCell(pro)}</td></tr>`).join('')}</tbody></table></div>`)
    );
    if (s.plan === 'pro') {
      const box = h(`<div class="sec"><p class="hint">You're on ${esc(planLine())}.</p><div class="row"><button class="btn" type="button">Manage billing</button></div><p class="hint err-line" hidden></p></div>`);
      box.querySelector('button').addEventListener('click', () => manageBilling(box));
      body.append(box);
      return;
    }
    const buy = h(`<div class="sec buy">
      <div class="seg interval" role="group" aria-label="Billing period">
        ${prices.year ? `<button type="button" data-int="year">Yearly<small>${esc(prices.year.label || '')}</small></button>` : ''}
        ${prices.month ? `<button type="button" data-int="month">Monthly<small>${esc(prices.month.label || '')}</small></button>` : ''}
      </div>
      <button class="btn primary big" type="button" id="upGo">${trialDays ? `Start ${trialDays}-day free trial` : 'Upgrade to Pro'}</button>
      <p class="hint">${trialDays ? "You won't be charged until the trial ends. " : ''}Cancel any time in Manage billing. Whiparound plays streams you already have access to; it doesn't include a TV or streaming subscription.</p>
      <p class="hint err-line" hidden></p>
    </div>`);
    const seg = $('.interval', buy);
    const drawSeg = () => $$('[data-int]', seg).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.int === interval)));
    drawSeg();
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('[data-int]');
      if (b) {
        interval = b.dataset.int;
        drawSeg();
      }
    });
    const go = $('#upGo', buy);
    const err = $('.err-line', buy);
    go.addEventListener('click', async () => {
      if (!account.state.user) return openSignIn({ then: () => account.checkout(interval), note: 'Sign in first, then you’ll go straight to checkout.' });
      go.disabled = true;
      go.textContent = 'Opening checkout…';
      err.hidden = true;
      try {
        await account.checkout(interval);
      } catch (e) {
        go.disabled = false;
        go.textContent = trialDays ? `Start ${trialDays}-day free trial` : 'Upgrade to Pro';
        err.hidden = false;
        err.textContent = e.message;
      }
    });
    body.append(buy);
  });
}

async function manageBilling(box) {
  const btn = box.querySelector('button');
  const err = box.querySelector('.err-line');
  btn.disabled = true;
  try {
    await account.manageBilling();
  } catch (e) {
    btn.disabled = false;
    err.hidden = false;
    err.textContent = e.message;
  }
}

function openSignIn({ then = null, note = '' } = {}) {
  if (!account) return;
  let email = '';
  openDialog('Sign in', (body) => {
    const ask = h(`<form class="sec" novalidate>
      <p class="hint">${esc(note || 'We’ll email you a 6-digit code. No password needed.')}</p>
      <div class="field"><label for="siEmail">Email</label><input class="input" id="siEmail" name="email" type="email" autocomplete="email" inputmode="email" required></div>
      <p class="hint err-line" role="alert" hidden></p>
      <div class="row"><button class="btn primary" type="submit">Email me a code</button></div>
    </form>`);
    const verify = h(`<form class="sec" novalidate hidden>
      <p class="hint" id="siSent"></p>
      <div class="field"><label for="siCode">6-digit code</label><input class="input code-input" id="siCode" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" required></div>
      <p class="hint err-line" role="alert" hidden></p>
      <div class="row"><button class="btn primary" type="submit">Sign in</button><button class="btn ghost" type="button" id="siBack">Use a different email</button></div>
    </form>`);
    const fail = (form, msg) => {
      const e = $('.err-line', form);
      e.hidden = false;
      e.textContent = msg;
    };
    ask.addEventListener('submit', async (e) => {
      e.preventDefault();
      email = $('#siEmail', ask).value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(ask, 'Enter a valid email address.');
      const btn = $('button[type="submit"]', ask);
      btn.disabled = true;
      btn.textContent = 'Sending…';
      try {
        await account.sendCode(email);
        ask.hidden = true;
        verify.hidden = false;
        $('#siSent', verify).textContent = `We sent a code to ${email}. Enter it here, or tap the link in that email on this device.`;
        $('#siCode', verify).focus();
      } catch (err) {
        fail(ask, err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Email me a code';
      }
    });
    verify.addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = $('#siCode', verify).value.replace(/\D/g, '');
      if (code.length < 6) return fail(verify, 'Enter the 6-digit code from the email.');
      const btn = $('button[type="submit"]', verify);
      btn.disabled = true;
      btn.textContent = 'Checking…';
      try {
        await account.verifyCode(email, code);
        closeDialog();
        toast({ title: 'Signed in', text: email, ttl: 3000 });
        if (then) {
          try {
            await then();
          } catch (err) {
            toast({ title: "Couldn't open checkout", text: err.message });
          }
        }
      } catch (err) {
        fail(verify, err.message);
        btn.disabled = false;
        btn.textContent = 'Sign in';
      }
    });
    $('#siBack', verify).addEventListener('click', () => {
      verify.hidden = true;
      ask.hidden = false;
      $('#siEmail', ask).focus();
    });
    body.append(ask, verify);
    if (matchMedia('(pointer: fine)').matches) setTimeout(() => $('#siEmail', ask)?.focus(), 30);
  });
}

function openAccount() {
  if (!account) return;
  const s = account.state;
  if (!s.user) return openSignIn();
  openDialog('Your account', (body) => {
    const box = h(`<div class="sec">
      <div class="acct"><b>${esc(s.user.email)}</b><span>${esc(planLine())}</span></div>
      ${s.error ? `<p class="hint err-line">${esc(s.error)}</p>` : ''}
      <div class="row">
        ${s.plan === 'pro' ? '<button class="btn" type="button" data-a="billing">Manage billing</button>' : '<button class="btn primary" type="button" data-a="pro">See Pro</button>'}
        <button class="btn ghost" type="button" data-a="out">Sign out</button>
      </div>
      <p class="hint err-line" hidden></p>
    </div>`);
    box.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'billing') manageBilling(box);
      if (a === 'pro') openUpgrade('generic');
      if (a === 'out') {
        await account.signOut();
        closeDialog();
        toast({ title: 'Signed out', text: 'You’re on the Free plan on this device.', ttl: 3000 });
      }
    });
    body.append(box);
  });
}

// Exposed for debugging in the console.
window.whiparound = { S, board, get library() { return library; }, views, get account() { return account; }, get ent() { return ent; }, refreshFree, get freeNow() { return freeNow; } };
