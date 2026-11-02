// Live scoreboard: fetches ESPN's public scoreboard per league, normalizes each event,
// rates how exciting it is, and announces scoring plays.

import { LEAGUES, league as leagueById, scoreboardUrl } from './leagues.js';
import { rateGame, scoringLabel } from './excitement.js';
import { ordinal } from './util.js';

const hex = (c) => (c && /^[0-9a-f]{6}$/i.test(c) ? `#${c}` : null);
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

function normalizeTeam(c) {
  if (!c) return null;
  const t = c.team || {};
  const rank = c.curatedRank?.current;
  return {
    id: String(t.id ?? c.id ?? ''),
    abbr: t.abbreviation || t.shortDisplayName || '?',
    name: t.displayName || t.name || '',
    short: t.shortDisplayName || t.name || t.abbreviation || '',
    location: t.location || '',
    color: hex(t.color) || '#3a4255',
    logo: t.logo || t.logos?.[0]?.href || '',
    alt: hex(t.alternateColor),
    score: num(c.score),
    record: c.records?.[0]?.summary || '',
    rank: rank && rank <= 25 ? rank : null,
  };
}

function normalizeSituation(sit, kind, home, away) {
  if (!sit) return null;
  const base = { lastPlay: sit.lastPlay?.text || '' };
  if (kind === 'football') {
    const pos = sit.possession != null ? String(sit.possession) : null;
    return {
      ...base,
      down: num(sit.down),
      distance: num(sit.distance),
      yardLine: num(sit.yardLine),
      text: sit.downDistanceText || '',
      short: sit.shortDownDistanceText || '',
      spot: sit.possessionText || '',
      isRedZone: !!sit.isRedZone,
      possession: pos && home && pos === home.id ? 'home' : pos && away && pos === away.id ? 'away' : null,
    };
  }
  if (kind === 'baseball') {
    return {
      ...base,
      balls: num(sit.balls) ?? 0,
      strikes: num(sit.strikes) ?? 0,
      outs: num(sit.outs) ?? 0,
      onFirst: !!sit.onFirst,
      onSecond: !!sit.onSecond,
      onThird: !!sit.onThird,
      batter: sit.batter?.athlete?.shortName || '',
      pitcher: sit.pitcher?.athlete?.shortName || '',
    };
  }
  return base;
}

export function normalizeEvent(ev, l) {
  const comp = ev.competitions?.[0] || {};
  const st = ev.status || comp.status || {};
  const type = st.type || {};
  const cs = comp.competitors || [];
  const homeRaw = cs.find((c) => c.homeAway === 'home') || cs[0];
  const awayRaw = cs.find((c) => c.homeAway === 'away') || cs[1];
  const home = normalizeTeam(homeRaw);
  const away = normalizeTeam(awayRaw);
  const networks = [
    ...(comp.broadcasts || []).flatMap((b) => b.names || []),
    ...(comp.geoBroadcasts || []).map((g) => g.media?.shortName).filter(Boolean),
  ];
  const link =
    (ev.links || []).find((x) => (x.rel || []).includes('summary'))?.href ||
    (ev.links || [])[0]?.href ||
    '';
  return {
    key: `${l.id}:${ev.id}`,
    id: String(ev.id),
    league: l.id,
    kind: l.kind,
    regPeriods: l.regPeriods,
    name: ev.name || '',
    shortName: ev.shortName || `${away?.abbr} @ ${home?.abbr}`,
    date: ev.date,
    state: type.state || 'pre',
    statusName: type.name || '',
    detail: type.shortDetail || type.detail || '',
    period: num(st.period) ?? 0,
    clock: num(st.clock),
    displayClock: st.displayClock || '',
    home,
    away,
    situation: normalizeSituation(comp.situation, l.kind, home, away),
    networks: [...new Set(networks.map((n) => n.trim()).filter(Boolean))],
    link,
    venue: comp.venue?.fullName || '',
  };
}

export function periodLabel(g) {
  const p = g.period;
  if (g.kind === 'football' || (g.kind === 'basketball' && g.regPeriods === 4)) {
    return p > g.regPeriods ? (p - g.regPeriods > 1 ? `${p - g.regPeriods}OT` : 'OT') : `Q${p}`;
  }
  if (g.kind === 'basketball') return p > 2 ? (p - 2 > 1 ? `${p - 2}OT` : 'OT') : `${ordinal(p)} Half`;
  if (g.kind === 'hockey') return p > 3 ? (p === 5 ? 'SO' : 'OT') : `P${p}`;
  return '';
}

/** Short status line, e.g. "Q4 2:13", "Top 7th", "78'", "Final", "7:15 PM". */
export function statusText(g, fmtKickoff) {
  if (g.state === 'pre') return fmtKickoff ? fmtKickoff(g.date) : g.detail;
  if (g.state === 'post') return g.detail || 'Final';
  const special = /HALFTIME|END_PERIOD|DELAYED|RAIN|SUSPENDED|INTERMISSION/.test(g.statusName);
  if (special || g.kind === 'baseball' || g.kind === 'soccer') return g.detail;
  const pl = periodLabel(g);
  return pl ? `${pl} ${g.displayClock}`.trim() : g.detail;
}

/** One-line situation, e.g. "2nd & 6 · DEN 12" or "2 out · 3-1". */
export function situationText(g) {
  const s = g.situation;
  if (!s || g.state !== 'in') return '';
  if (g.kind === 'football') {
    if (s.short && s.spot) return `${s.short} · ${s.spot}`;
    return s.text || s.short || '';
  }
  if (g.kind === 'baseball') {
    const outs = `${s.outs} out`;
    return `${outs} · ${s.balls}-${s.strikes}`;
  }
  return '';
}

/**
 * Polls the scoreboard for enabled leagues.
 * Emits 'update' after each refresh and 'score' for each scoring change.
 */
export class Scoreboard extends EventTarget {
  constructor({ leagues, demo = null, fetchJSON }) {
    super();
    this.leagues = leagues;
    this.demo = demo;
    this.fetchJSON = fetchJSON;
    this.games = new Map();
    this.errors = new Map();
    this.updatedAt = 0;
    this.timer = null;
    this.running = false;
    this.inflight = null;
    this.source = null;
  }

  /** Load scores from somewhere else (e.g. the paid backend's /api/scores) instead of ESPN directly. */
  setSource(fn) {
    this.source = fn;
    this.updatedAt = 0;
    this.errors.clear();
    this.refresh();
  }

  setLeagues(ids) {
    this.leagues = ids;
    for (const key of [...this.games.keys()]) {
      if (!ids.includes(key.split(':')[0])) this.games.delete(key);
    }
    this.refresh();
  }

  start() {
    this.running = true;
    this.refresh();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
  }

  get(key) {
    return key ? this.games.get(key) || null : null;
  }

  list() {
    return [...this.games.values()];
  }

  get ok() {
    return this.updatedAt > 0 && this.errors.size < this.leagues.length;
  }

  nextDelay() {
    if (this.demo) return 2500;
    const live = this.list().some((g) => g.state === 'in');
    const hidden = typeof document !== 'undefined' && document.hidden;
    if (hidden) return 60000;
    return live ? 15000 : 60000;
  }

  async refresh() {
    if (this.inflight) return this.inflight;
    clearTimeout(this.timer);
    this.inflight = this._refresh().finally(() => {
      this.inflight = null;
      if (this.running) this.timer = setTimeout(() => this.refresh(), this.nextDelay());
    });
    return this.inflight;
  }

  async _refresh() {
    const ids = this.leagues.filter((id) => leagueById(id));
    const results = await Promise.allSettled(
      ids.map(async (id) => {
        const l = leagueById(id);
        const data = this.demo ? this.demo.scoreboard(id) : this.source ? await this.source(l) : await this.fetchJSON(scoreboardUrl(l));
        return { l, data: data || {} };
      })
    );
    const now = Date.now();
    const seen = new Set();
    results.forEach((r, i) => {
      const id = ids[i];
      if (r.status !== 'fulfilled') {
        this.errors.set(id, r.reason?.message || 'Failed to load');
        // Keep the last good data for this league so the screen doesn't empty out.
        for (const k of this.games.keys()) if (k.startsWith(id + ':')) seen.add(k);
        return;
      }
      this.errors.delete(id);
      // A server source sends games already in our shape; ESPN sends raw events.
      const { l, data } = r.value;
      const items = Array.isArray(data.games) ? data.games : Array.isArray(data.events) ? data.events : [];
      for (const item of items) {
        let g;
        try {
          g = Array.isArray(data.games) ? { ...item, league: l.id, kind: l.kind, regPeriods: l.regPeriods } : normalizeEvent(item, l);
          if (!g.key || !g.home || !g.away) continue;
        } catch {
          continue;
        }
        const prev = this.games.get(g.key);
        g.lastScoreAt = prev?.lastScoreAt || 0;
        g.lastScoreSide = prev?.lastScoreSide || null;
        if (prev && prev.state === 'in' && g.home && g.away) {
          for (const side of ['home', 'away']) {
            const before = prev[side]?.score ?? 0;
            const after = g[side]?.score ?? 0;
            if (after > before) {
              g.lastScoreAt = now;
              g.lastScoreSide = side;
              const label = scoringLabel(g.kind, after - before);
              if (label) {
                this.dispatchEvent(new CustomEvent('score', { detail: { game: g, side, delta: after - before, label } }));
              }
            }
          }
        }
        g.heat = rateGame(g, now);
        this.games.set(g.key, g);
        seen.add(g.key);
      }
    });
    for (const k of [...this.games.keys()]) if (!seen.has(k)) this.games.delete(k);
    if (results.some((r) => r.status === 'fulfilled')) this.updatedAt = now;
    this.dispatchEvent(new CustomEvent('update'));
  }
}

export const ALL_LEAGUE_IDS = LEAGUES.map((l) => l.id);
