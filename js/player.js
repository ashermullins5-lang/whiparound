// One player per tile. Picks the right engine for a link and falls back when one fails:
//   HLS  -> native (Safari/iOS) or hls.js, then hls.js through the local proxy (CORS)
//   TS   -> mpegts.js, then through the proxy
//   YouTube / Twitch / web page -> iframe embeds
//   demo -> a drawn canvas feed for the built-in demo

import { youtubeId, youtubeChannel, twitchTarget } from './sources.js';

export const isAppleWebKit = (() => {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true;
  return /Safari/.test(ua) && !/Chrome|Chromium|CriOS|Android|Edg|Firefox/.test(ua);
})();

const STARTUP_TIMEOUT = 20000;

function buildPlan(kind, url, proxy) {
  const P = (engine, u, viaProxy = false) => ({ engine, url: u, viaProxy });
  const prox = proxy ? proxy(url) : null;
  const plan = [];
  const hlsJs = () => window.Hls && window.Hls.isSupported();
  const tsJs = () => window.mpegts && window.mpegts.getFeatureList?.().mseLivePlayback;
  if (kind === 'hls') {
    if (isAppleWebKit) plan.push(P('native', url));
    if (hlsJs()) {
      plan.push(P('hls', url));
      if (prox) plan.push(P('hls', prox, true));
    }
    if (!isAppleWebKit) plan.push(P('native', url));
  } else if (kind === 'mpegts') {
    if (tsJs()) {
      plan.push(P('mpegts', url));
      if (prox) plan.push(P('mpegts', prox, true));
    }
  } else if (kind === 'file') {
    plan.push(P('native', url));
  } else {
    // Unknown link: most live links are HLS, IPTV links are often raw MPEG-TS.
    if (isAppleWebKit) plan.push(P('native', url));
    if (hlsJs()) {
      plan.push(P('hls', url));
      if (prox) plan.push(P('hls', prox, true));
    }
    if (tsJs()) {
      plan.push(P('mpegts', url));
      if (prox) plan.push(P('mpegts', prox, true));
    }
    if (!isAppleWebKit) plan.push(P('native', url));
  }
  // Browsers refuse http:// media on an https:// page. Only the local relay can fetch it.
  if (location.protocol === 'https:' && /^http:\/\//i.test(url)) return plan.filter((p) => p.viaProxy);
  return plan;
}

let twitchScript = null;
function loadTwitchScript() {
  if (window.Twitch?.Player) return Promise.resolve();
  if (!twitchScript) {
    twitchScript = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://player.twitch.tv/js/embed/v1.js';
      s.onload = resolve;
      s.onerror = () => {
        twitchScript = null;
        reject(new Error('Could not load the Twitch player'));
      };
      document.head.append(s);
    });
  }
  return twitchScript;
}

export class Player {
  /**
   * @param {HTMLElement} host element the media goes into
   * @param {{
   *   onState?: (state:string, message?:string)=>void,
   *   onInfo?: (info:{title?:string, videoId?:string, live?:boolean, upcoming?:boolean})=>void,
   *   proxy?: (url:string)=>string|null,
   *   liveResolver?: () => ((liveUrl:string)=>Promise<any>) | null,
   * }} opts
   */
  constructor(host, { onState, onInfo, proxy, liveResolver } = {}) {
    this.host = host;
    this.onState = onState || (() => {});
    this.onInfo = onInfo || (() => {});
    this.proxy = proxy || null;
    this.liveResolver = liveResolver || (() => null);
    this.muted = true;
    this.status = 'idle';
    this.video = null;
    this.frame = null;
    this.engine = null;
    this.timers = new Set();
    this.token = 0;
  }

  setState(s, msg = '') {
    this.status = s;
    this.onState(s, msg);
  }

  later(fn, ms) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  load(source) {
    this.teardown();
    this.source = source;
    this.lastError = '';
    const token = ++this.token;
    this.setState('loading');
    switch (source.kind) {
      case 'youtube':
        return this.loadYouTube(source.url);
      case 'ytlive':
        return this.loadYouTubeLive(source.url, token);
      case 'twitch':
        return this.loadTwitch(source.url, token);
      case 'embed':
        return this.loadEmbed(source.url);
      case 'demo':
        return this.loadDemo(source.url);
      case 'dash':
        return this.setState('error', "DASH (.mpd) links aren't supported. Use the stream's HLS (.m3u8) link instead.");
    }
    this.plan = buildPlan(source.kind, source.url, this.proxy);
    if (!this.plan.length) {
      if (location.protocol === 'https:' && /^http:\/\//i.test(source.url)) {
        return this.setState('error', 'This stream uses http://, which browsers block on https:// pages. Run Whiparound on your computer with server.js instead.');
      }
      return this.setState(
        'error',
        source.kind === 'mpegts'
          ? "This browser can't play raw MPEG-TS streams. Use the HLS (.m3u8) version, or a desktop browser."
          : "This browser can't play this stream."
      );
    }
    this.step = -1;
    this.next(token);
  }

  /** Move to the next engine in the plan (startup failure). */
  next(token) {
    if (token !== this.token) return;
    this.stopEngine();
    this.step++;
    const entry = this.plan[this.step];
    if (!entry) {
      return this.setState('error', this.lastError || "Couldn't play this stream. Check the link, or that it's live.");
    }
    this.started = false;
    this.restarts = 0;
    this.startEntry(entry, token);
  }

  startEntry(entry, token) {
    const v = this.makeVideo(token);
    this.later(() => {
      if (token === this.token && !this.started && this.plan[this.step] === entry) {
        this.lastError = 'The stream took too long to start.';
        this.next(token);
      }
    }, STARTUP_TIMEOUT);

    if (entry.engine === 'native') {
      v.src = entry.url;
      this.tryPlay(v);
    } else if (entry.engine === 'hls') {
      const Hls = window.Hls;
      const hls = new Hls({
        capLevelToPlayerSize: true, // small tiles pull lower bitrates; the main tile gets full quality
        lowLatencyMode: true,
        maxBufferLength: 20,
        backBufferLength: 20,
        manifestLoadingMaxRetry: 1,
        levelLoadingMaxRetry: 3,
        fragLoadingMaxRetry: 4,
      });
      this.engine = { type: 'hls', inst: hls };
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal || token !== this.token) return;
        if (!this.started) {
          this.lastError = hlsMessage(data, entry.viaProxy);
          return this.next(token);
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else this.restart(token, 'Reconnecting…');
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => this.tryPlay(v));
      hls.loadSource(entry.url);
      hls.attachMedia(v);
    } else if (entry.engine === 'mpegts') {
      const mt = window.mpegts;
      const isFlv = /\.flv(\?|$)/i.test(this.source.url);
      const p = mt.createPlayer(
        { type: isFlv ? 'flv' : 'mpegts', isLive: true, url: entry.url },
        { enableWorker: true, lazyLoad: false, liveBufferLatencyChasing: true, autoCleanupSourceBuffer: true }
      );
      this.engine = { type: 'mpegts', inst: p };
      p.on(mt.Events.ERROR, (type, detail) => {
        if (token !== this.token) return;
        if (!this.started) {
          this.lastError = `Stream error (${type}${detail ? ': ' + detail : ''}).`;
          return this.next(token);
        }
        this.restart(token, 'Reconnecting…');
      });
      p.attachMediaElement(v);
      p.load();
      this.tryPlay(v);
    }
  }

  /** Mid-stream failure: rebuild the same engine a few times before giving up. */
  restart(token, msg) {
    if (token !== this.token) return;
    if (this.restarts >= 6) return this.setState('error', 'Lost the stream. Pick it again to retry.');
    this.restarts++;
    this.setState('buffering', msg);
    const entry = this.plan[this.step];
    this.stopEngine();
    this.later(() => {
      if (token !== this.token) return;
      const restarts = this.restarts;
      this.startEntry(entry, token);
      this.started = true; // it worked before; don't fall through the plan on a hiccup
      this.restarts = restarts;
    }, Math.min(15000, 1500 * 2 ** this.restarts));
  }

  makeVideo(token) {
    const v = document.createElement('video');
    v.muted = this.muted;
    v.autoplay = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.preload = 'auto';
    const mine = () => token === this.token && v === this.video;
    v.addEventListener('playing', () => {
      if (!mine()) return;
      this.started = true;
      this.restarts = 0;
      this.setState('playing');
    });
    v.addEventListener('waiting', () => mine() && this.started && this.setState('buffering'));
    v.addEventListener('error', () => {
      if (!mine() || this.engine) return; // hls.js / mpegts report their own errors
      const code = v.error?.code;
      // Keep a more specific reason from an earlier engine (HTTP status, CORS) if there is one.
      if (!this.lastError) this.lastError =
        code === 4
          ? "This browser can't decode this stream's format."
          : code === 2
          ? "Couldn't reach the stream (network error)."
          : "Couldn't play this stream.";
      if (!this.started) this.next(token);
      else this.restart(token, 'Reconnecting…');
    });
    this.host.append(v);
    this.video = v;
    this.watchStalls(token);
    return v;
  }

  tryPlay(v) {
    const p = v.play();
    if (p?.catch) {
      p.catch((err) => {
        if (err?.name === 'NotAllowedError') {
          v.muted = true;
          v.play().catch(() => this.setState('tap', 'Tap to play'));
        }
      });
    }
  }

  // Live streams sometimes freeze without an error. Restart when the picture stops moving.
  watchStalls(token) {
    let last = -1;
    let stuck = 0;
    const tick = () => {
      if (token !== this.token || !this.video) return;
      const v = this.video;
      if (this.started && !v.paused && v.readyState > 0) {
        if (v.currentTime === last) stuck++;
        else stuck = 0;
        last = v.currentTime;
        if (stuck >= 4) {
          stuck = 0;
          return this.restart(token, 'Stream froze, reconnecting…');
        }
      }
      this.later(tick, 4000);
    };
    this.later(tick, 4000);
  }

  // ---------- Embeds ----------

  makeFrame(src, allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen') {
    const f = document.createElement('iframe');
    f.src = src;
    f.allow = allow;
    f.allowFullscreen = true;
    f.referrerPolicy = 'strict-origin-when-cross-origin';
    f.addEventListener('load', () => this.setState('playing'));
    this.host.append(f);
    this.frame = f;
    return f;
  }

  loadYouTube(url) {
    this.engine = { type: 'youtube' };
    this.showYouTube(`/embed/${encodeURIComponent(youtubeId(url))}`);
  }

  showYouTube(embedPath, extra = {}) {
    const params = new URLSearchParams({ autoplay: '1', mute: '1', playsinline: '1', enablejsapi: '1', rel: '0', ...extra });
    if (location.protocol.startsWith('http')) params.set('origin', location.origin);
    this.frame?.remove();
    this.makeFrame(`https://www.youtube.com${embedPath}?${params}`);
    this.frame.addEventListener('load', () => this.applyMute());
  }

  /**
   * A channel link: play whatever the channel is streaming now, and keep following it.
   * With the local server we look up the live video id (and switch when the channel moves to its
   * next stream). Without it, a /channel/UC… link can still use YouTube's own live_stream embed.
   */
  async loadYouTubeLive(url, token) {
    const ch = youtubeChannel(url);
    const label = ch?.handle || ch?.name || 'This channel';
    this.engine = { type: 'youtube' };
    this.liveVideoId = null;
    this.channelEmbed = false;
    let knownChannel = ch?.channelId || null;
    const resolve = this.liveResolver();
    if (!resolve) {
      if (ch?.channelId) {
        this.showYouTube('/embed/live_stream', { channel: ch.channelId });
        return;
      }
      return this.setState(
        'error',
        "This version can't look up which video a channel is streaming. In YouTube, open the live stream, tap Share → Copy link, and paste that link here."
      );
    }
    const check = async () => {
      if (token !== this.token) return;
      let info = null;
      let err = '';
      try {
        info = await resolve(ch.liveUrl);
      } catch (e) {
        err = e.message || "Couldn't check the channel.";
      }
      if (token !== this.token) return;
      if (info?.channelId) knownChannel = info.channelId;
      const playable = info?.videoId && (info.live || info.upcoming);
      if (playable && info.videoId !== this.liveVideoId) {
        this.liveVideoId = info.videoId;
        this.showYouTube(`/embed/${encodeURIComponent(info.videoId)}`);
        this.onInfo({ title: info.title || '', videoId: info.videoId, live: !!info.live, upcoming: !!info.upcoming });
      } else if (err && knownChannel && !this.liveVideoId) {
        // The lookup failed (consent page, rate limit, markup change) but we know the channel id:
        // YouTube's own live_stream embed can still find the stream in the viewer's browser.
        if (!this.channelEmbed) {
          this.channelEmbed = true;
          this.showYouTube('/embed/live_stream', { channel: knownChannel });
        }
      } else if (!playable && !this.liveVideoId && !this.channelEmbed) {
        // Nothing to show yet. Keep checking; the tile says why.
        this.setState(err ? 'error' : 'waiting', err || `${label} isn't live right now. Checking again every minute.`);
      }
      // When a stream ends we keep it on screen until the channel goes live with the next one.
      this.later(check, 60000);
    };
    await check();
  }

  async loadTwitch(url, token) {
    const target = twitchTarget(url);
    const div = document.createElement('div');
    div.className = 'twitch-host';
    this.host.append(div);
    try {
      await loadTwitchScript();
    } catch (e) {
      return token === this.token && this.setState('error', e.message);
    }
    if (token !== this.token) return;
    const player = new window.Twitch.Player(div, {
      ...target,
      parent: [location.hostname || 'localhost'],
      width: '100%',
      height: '100%',
      muted: this.muted,
      autoplay: true,
    });
    this.engine = { type: 'twitch', inst: player };
    player.addEventListener(window.Twitch.Player.PLAYING, () => token === this.token && this.setState('playing'));
    player.addEventListener(window.Twitch.Player.READY, () => token === this.token && this.applyMute());
  }

  loadEmbed(url) {
    this.engine = { type: 'embed' };
    this.makeFrame(url);
  }

  loadDemo(url) {
    this.engine = { type: 'demo', inst: startDemoFeed(this.host, url) };
    this.setState('playing');
  }

  // ---------- Controls ----------

  get canMute() {
    return !this.engine || !['embed', 'demo'].includes(this.engine.type);
  }

  setMuted(m) {
    this.muted = m;
    this.applyMute();
  }

  applyMute() {
    const m = this.muted;
    if (this.video) {
      this.video.muted = m;
      if (!m && this.video.paused) {
        this.video.play().catch(() => {
          // iOS/Safari refuse sound without a tap; keep the picture going.
          this.video.muted = true;
          this.video.play().catch(() => {});
          this.setState('tap', 'Tap the tile for sound');
        });
      }
    }
    if (this.engine?.type === 'youtube' && this.frame?.contentWindow) {
      for (const func of [m ? 'mute' : 'unMute', 'playVideo']) {
        this.frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args: [] }), 'https://www.youtube.com');
      }
    }
    if (this.engine?.type === 'twitch') {
      try {
        this.engine.inst.setMuted(m);
        if (!m) this.engine.inst.setVolume(1);
      } catch {}
    }
  }

  /** User tapped a tile that was blocked from autoplay. */
  resume() {
    if (this.video) {
      this.video.muted = this.muted;
      this.video.play().then(() => this.setState('playing')).catch(() => {});
    }
  }

  get canPip() {
    const v = this.video;
    return !!v && (document.pictureInPictureEnabled || typeof v.webkitSetPresentationMode === 'function');
  }

  pip() {
    const v = this.video;
    if (!v) return;
    if (document.pictureInPictureElement === v) return document.exitPictureInPicture();
    if (v.requestPictureInPicture) return v.requestPictureInPicture().catch(() => {});
    if (v.webkitSetPresentationMode) v.webkitSetPresentationMode('picture-in-picture');
  }

  get canAirPlay() {
    return !!this.video && typeof this.video.webkitShowPlaybackTargetPicker === 'function';
  }

  airplay() {
    this.video?.webkitShowPlaybackTargetPicker?.();
  }

  stopEngine() {
    const e = this.engine;
    this.engine = null;
    try {
      if (e?.type === 'hls') e.inst.destroy();
      if (e?.type === 'mpegts') {
        e.inst.pause();
        e.inst.unload();
        e.inst.detachMediaElement();
        e.inst.destroy();
      }
      if (e?.type === 'demo') e.inst.stop();
    } catch {}
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute('src');
      try {
        this.video.load();
      } catch {}
      this.video.remove();
      this.video = null;
    }
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  teardown() {
    this.token++;
    this.stopEngine();
    this.frame?.remove();
    this.frame = null;
    this.host.replaceChildren();
    this.setState('idle');
  }

  destroy() {
    this.teardown();
    this.source = null;
  }
}

function hlsMessage(data, viaProxy) {
  const d = data.details || '';
  if (/manifestLoadError|manifestLoadTimeOut/.test(d)) {
    const code = data.response?.code;
    if (code === 0 || code === undefined) {
      return viaProxy
        ? "Couldn't reach the stream, even through the local server."
        : "Couldn't load the stream. It may be offline, or it blocks web pages (CORS). Starting Whiparound with server.js fixes CORS.";
    }
    if (viaProxy && code === 502) return "Couldn't reach the stream server. It may be offline or the link may be wrong.";
    if (code === 401 || code === 403) return `The stream server refused access (${code}). The link may need a login or may have expired.`;
    if (code === 404) return 'The stream server answered 404: that link no longer exists. Live links often expire.';
    return `The stream server answered ${code}. The link may be expired or need a login.`;
  }
  if (/manifestParsingError/.test(d)) return "That link isn't an HLS playlist.";
  if (/keyLoadError|keySystem/.test(d)) return 'This stream is DRM-protected and can only play in its own app.';
  return `Playback error (${d || data.type}).`;
}

// ---------- Demo feed ----------
// A lightweight animated "broadcast" drawn on canvas, used by the built-in demo so the
// multiview and Auto Whip can be tried without any streams.

const PALETTES = {
  football: { ground: ['#2f6b34', '#2a6230'], line: 'rgba(255,255,255,.75)' },
  soccer: { ground: ['#2f7a3b', '#2b7036'], line: 'rgba(255,255,255,.7)' },
  basketball: { ground: ['#c99a5c', '#c29355'], line: 'rgba(255,255,255,.85)' },
  hockey: { ground: ['#e9f0f5', '#e2eaf0'], line: '#c8102e' },
  baseball: { ground: ['#357a3a', '#2f7035'], line: 'rgba(255,255,255,.8)' },
};

function startDemoFeed(host, url) {
  // demo:<kind>:<AWAY>@<HOME>:<awayColor>:<homeColor>
  const [, kind = 'football', matchup = 'AWY@HOM', ac = '#d33', hc = '#36c'] = url.split(':');
  const [away, home] = matchup.split('@');
  const canvas = document.createElement('canvas');
  canvas.className = 'demo-canvas';
  host.append(canvas);
  const ctx = canvas.getContext('2d');
  const pal = PALETTES[kind] || PALETTES.football;
  let raf = 0;
  let last = 0;
  let stopped = false;
  const seed = [...matchup].reduce((a, c) => a + c.charCodeAt(0), 0);

  const draw = (t) => {
    if (stopped) return;
    raf = requestAnimationFrame(draw);
    if (t - last < 66) return; // ~15 fps is plenty for a placeholder feed
    last = t;
    const w = Math.max(160, Math.min(960, host.clientWidth));
    const hgt = Math.max(90, Math.round((w * 9) / 16));
    if (canvas.width !== w) {
      canvas.width = w;
      canvas.height = hgt;
    }
    const W = canvas.width, H = canvas.height;
    const s = t / 1000 + seed;
    // Ground with mowing stripes / boards
    const stripes = 10;
    for (let i = 0; i < stripes; i++) {
      ctx.fillStyle = pal.ground[i % 2];
      ctx.fillRect((i * W) / stripes, 0, W / stripes + 1, H);
    }
    ctx.strokeStyle = pal.line;
    ctx.lineWidth = Math.max(1, W / 400);
    if (kind === 'football') {
      for (let i = 1; i < 10; i++) {
        const x = (i * W) / 10;
        ctx.beginPath();
        ctx.moveTo(x, H * 0.08);
        ctx.lineTo(x, H * 0.92);
        ctx.stroke();
      }
      ctx.fillStyle = ac;
      ctx.fillRect(0, 0, W * 0.07, H);
      ctx.fillStyle = hc;
      ctx.fillRect(W * 0.93, 0, W * 0.07, H);
      const los = W * (0.5 + 0.32 * Math.sin(s * 0.23));
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = Math.max(2, W / 220);
      ctx.beginPath();
      ctx.moveTo(los, 0);
      ctx.lineTo(los, H);
      ctx.stroke();
      ctx.strokeStyle = '#facc15';
      ctx.beginPath();
      ctx.moveTo(los + W * 0.08, 0);
      ctx.lineTo(los + W * 0.08, H);
      ctx.stroke();
    } else if (kind === 'basketball') {
      ctx.strokeRect(W * 0.04, H * 0.08, W * 0.92, H * 0.84);
      ctx.beginPath();
      ctx.moveTo(W / 2, H * 0.08);
      ctx.lineTo(W / 2, H * 0.92);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, H * 0.14, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeRect(W * 0.04, H * 0.34, W * 0.14, H * 0.32);
      ctx.strokeRect(W * 0.82, H * 0.34, W * 0.14, H * 0.32);
    } else if (kind === 'hockey') {
      ctx.strokeStyle = '#c8102e';
      ctx.lineWidth = Math.max(2, W / 200);
      ctx.beginPath();
      ctx.moveTo(W / 2, 0);
      ctx.lineTo(W / 2, H);
      ctx.stroke();
      ctx.strokeStyle = '#1d4ed8';
      for (const x of [W * 0.33, W * 0.67]) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
        ctx.stroke();
      }
    } else if (kind === 'soccer') {
      ctx.strokeRect(W * 0.04, H * 0.08, W * 0.92, H * 0.84);
      ctx.beginPath();
      ctx.moveTo(W / 2, H * 0.08);
      ctx.lineTo(W / 2, H * 0.92);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, H * 0.16, 0, Math.PI * 2);
      ctx.stroke();
    } else if (kind === 'baseball') {
      ctx.fillStyle = '#b07a4a';
      ctx.beginPath();
      ctx.moveTo(W / 2, H * 0.9);
      ctx.lineTo(W * 0.7, H * 0.55);
      ctx.lineTo(W / 2, H * 0.2);
      ctx.lineTo(W * 0.3, H * 0.55);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    // Moving "ball"
    const bx = W * (0.5 + 0.38 * Math.sin(s * 0.9) * Math.cos(s * 0.31));
    const by = H * (0.5 + 0.3 * Math.sin(s * 1.3));
    ctx.fillStyle = kind === 'hockey' ? '#111' : '#fff';
    ctx.beginPath();
    ctx.arc(bx, by, Math.max(3, W / 110), 0, Math.PI * 2);
    ctx.fill();
    // Watermark, top left: clear of the score bug (bottom) and the hot badge (top right)
    const label = `DEMO FEED · ${away} @ ${home}`;
    const fs = Math.round(Math.max(9, Math.min(18, H * 0.05)));
    ctx.font = `700 ${fs}px "Barlow Condensed", "Arial Narrow", sans-serif`;
    const tw = ctx.measureText(label).width;
    const pad = Math.max(4, fs * 0.5);
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    ctx.fillRect(pad, pad, tw + pad * 2, fs * 1.6);
    ctx.fillStyle = 'rgba(255,255,255,.88)';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, pad * 2, pad + fs * 0.8);
  };
  raf = requestAnimationFrame(draw);
  return {
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      canvas.remove();
    },
  };
}
