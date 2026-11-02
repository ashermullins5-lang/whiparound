// Demo mode: simulated live games in ESPN's scoreboard format, plus drawn "feeds",
// so the multiview and Auto Whip can be tried any time without streams or live games.

import { ordinal } from './util.js';

const T = (id, abbr, location, short, color) => ({ id, abbr, location, short, name: `${location} ${short}`, color });

// Logo URLs in the same form ESPN's scoreboard feed returns them.
const LOGO_LEAGUE = { football: 'nfl', basketball: 'nba', hockey: 'nhl' };
const logoUrl = (kind, t) =>
  kind === 'soccer'
    ? `https://a.espncdn.com/i/teamlogos/soccer/500/${t.id}.png`
    : `https://a.espncdn.com/i/teamlogos/${LOGO_LEAGUE[kind]}/500/scoreboard/${t.abbr.toLowerCase()}.png`;

const TEAMS = {
  KC: T('12', 'KC', 'Kansas City', 'Chiefs', 'e31837'),
  DEN: T('7', 'DEN', 'Denver', 'Broncos', 'fb4f14'),
  BUF: T('2', 'BUF', 'Buffalo', 'Bills', '00338d'),
  MIA: T('15', 'MIA', 'Miami', 'Dolphins', '008e97'),
  PHI: T('21', 'PHI', 'Philadelphia', 'Eagles', '06424d'),
  DAL: T('6', 'DAL', 'Dallas', 'Cowboys', '003594'),
  SF: T('25', 'SF', 'San Francisco', '49ers', 'aa0000'),
  SEA: T('26', 'SEA', 'Seattle', 'Seahawks', '002a5c'),
  LAC: T('24', 'LAC', 'Los Angeles', 'Chargers', '0080c6'),
  LV: T('13', 'LV', 'Las Vegas', 'Raiders', '2b2b2b'),
  GB: T('9', 'GB', 'Green Bay', 'Packers', '204e32'),
  CHI: T('3', 'CHI', 'Chicago', 'Bears', '0b162a'),
  BOS: T('2', 'BOS', 'Boston', 'Celtics', '008348'),
  NYK: T('18', 'NY', 'New York', 'Knicks', '1d428a'),
  LAL: T('13', 'LAL', 'Los Angeles', 'Lakers', '552583'),
  GSW: T('9', 'GS', 'Golden State', 'Warriors', 'fdb927'),
  EDM: T('22', 'EDM', 'Edmonton', 'Oilers', 'ff4c00'),
  TOR: T('21', 'TOR', 'Toronto', 'Maple Leafs', '00205b'),
  ARS: T('359', 'ARS', 'Arsenal', 'Arsenal', 'ef0107'),
  CHE: T('363', 'CHE', 'Chelsea', 'Chelsea', '034694'),
};

const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const chance = (p) => Math.random() < p;
const mmss = (sec) => `${Math.floor(Math.max(0, sec) / 60)}:${String(Math.max(0, sec) % 60).padStart(2, '0')}`;

function footballGame(id, away, home, net, o) {
  return { id, league: 'nfl', kind: 'football', away, home, net, state: 'in', period: 1, clock: 900, as: 0, hs: 0, pos: 'home', yard: 25, down: 1, dist: 10, ...o };
}

function makeGames() {
  const now = Date.now();
  return [
    footballGame('d1', 'KC', 'DEN', 'CBS', { period: 4, clock: 372, as: 17, hs: 20, pos: 'away', yard: 63, down: 1, dist: 10 }),
    footballGame('d2', 'BUF', 'MIA', 'CBS', { period: 3, clock: 505, as: 24, hs: 10, pos: 'home', yard: 41, down: 2, dist: 4 }),
    footballGame('d3', 'PHI', 'DAL', 'FOX', { period: 2, clock: 128, as: 7, hs: 3, pos: 'home', yard: 55, down: 1, dist: 10 }),
    footballGame('d4', 'SF', 'SEA', 'FOX', { period: 4, clock: 640, as: 21, hs: 21, pos: 'away', yard: 30, down: 3, dist: 2 }),
    footballGame('d5', 'LAC', 'LV', 'NBC', { state: 'pre', start: now + 3 * 3600e3 }),
    footballGame('d6', 'GB', 'CHI', 'FOX', { state: 'post', period: 4, clock: 0, as: 24, hs: 20 }),
    { id: 'd7', league: 'nba', kind: 'basketball', away: 'BOS', home: 'NYK', net: 'ESPN', state: 'in', period: 4, clock: 290, as: 98, hs: 101 },
    { id: 'd8', league: 'nba', kind: 'basketball', away: 'LAL', home: 'GSW', net: 'TNT', state: 'in', period: 2, clock: 410, as: 51, hs: 44 },
    { id: 'd9', league: 'nhl', kind: 'hockey', away: 'EDM', home: 'TOR', net: 'TNT', state: 'in', period: 3, clock: 470, as: 2, hs: 2 },
    { id: 'd10', league: 'epl', kind: 'soccer', away: 'CHE', home: 'ARS', net: 'USA Net', state: 'in', period: 2, minute: 71, as: 1, hs: 1 },
  ];
}

function kickoff(g) {
  // Switch possession after a score or turnover.
  g.pos = g.pos === 'home' ? 'away' : 'home';
  g.yard = 25;
  g.down = 1;
  g.dist = 10;
}

function stepFootball(g) {
  const offense = g.pos === 'home' ? 'hs' : 'as';
  // 4th down decisions
  if (g.down === 4) {
    if (g.yard >= 62) {
      if (chance(0.82)) g[offense] += 3;
      kickoff(g);
    } else if (g.yard >= 55 && g.dist <= 2 && chance(0.5)) {
      g.down = 1; // went for it and converted
      g.dist = 10;
      g.yard += 3;
    } else {
      const land = Math.min(95, g.yard + rnd(38, 48));
      g.pos = g.pos === 'home' ? 'away' : 'home';
      g.yard = Math.max(5, 100 - land);
      g.down = 1;
      g.dist = 10;
    }
  } else {
    const r = Math.random();
    let gain = r < 0.12 ? rnd(-4, 0) : r < 0.55 ? rnd(1, 7) : r < 0.9 ? rnd(6, 16) : rnd(16, 34);
    if (chance(0.03)) {
      // turnover
      g.pos = g.pos === 'home' ? 'away' : 'home';
      g.yard = Math.max(5, 100 - g.yard);
      g.down = 1;
      g.dist = 10;
    } else {
      g.yard += gain;
      if (g.yard >= 100) {
        g[offense] += 7;
        kickoff(g);
      } else if (gain >= g.dist) {
        g.down = 1;
        g.dist = Math.min(10, 100 - g.yard);
      } else {
        g.down += 1;
        g.dist -= gain;
      }
    }
  }
  g.clock -= rnd(22, 40);
  if (g.clock <= 0) endPeriod(g, 900, 4);
}

function endPeriod(g, len, reg) {
  if (g.period >= reg && g.as !== g.hs) {
    g.state = 'post';
    g.clock = 0;
    return;
  }
  if (g.period >= reg + 2) {
    g.state = 'post';
    g.clock = 0;
    return;
  }
  g.period += 1;
  g.clock = g.period > reg ? Math.round(len * 0.66) : len;
}

function stepBasketball(g) {
  g.as += [0, 0, 2, 2, 3][rnd(0, 4)];
  g.hs += [0, 0, 2, 2, 3][rnd(0, 4)];
  g.clock -= rnd(14, 26);
  if (g.clock <= 0) endPeriod(g, 720, 4);
}

function stepHockey(g) {
  if (chance(0.035)) g.as += 1;
  if (chance(0.035)) g.hs += 1;
  g.clock -= rnd(20, 35);
  if (g.clock <= 0) endPeriod(g, 1200, 3);
}

function stepSoccer(g) {
  if (chance(0.03)) g.as += 1;
  if (chance(0.03)) g.hs += 1;
  g.minute += 1;
  if (g.minute >= 95) g.state = 'post';
}

function spotText(g, offAbbr, defAbbr) {
  if (g.yard === 50) return '50';
  return g.yard > 50 ? `${defAbbr} ${100 - g.yard}` : `${offAbbr} ${g.yard}`;
}

function toEspn(g) {
  const away = TEAMS[g.away];
  const home = TEAMS[g.home];
  const comp = (t, side, score) => ({
    homeAway: side,
    score: g.state === 'pre' ? '0' : String(score),
    team: { id: t.id, abbreviation: t.abbr, displayName: t.name, shortDisplayName: t.short, location: t.location, color: t.color, logo: logoUrl(g.kind, t) },
    records: [{ summary: '' }],
  });
  let status;
  if (g.state === 'pre') {
    status = { period: 0, clock: 0, displayClock: '0:00', type: { name: 'STATUS_SCHEDULED', state: 'pre', completed: false, shortDetail: '' } };
  } else if (g.state === 'post') {
    status = { period: g.period, clock: 0, displayClock: '0:00', type: { name: 'STATUS_FINAL', state: 'post', completed: true, shortDetail: g.period > (g.kind === 'hockey' ? 3 : 4) ? 'Final/OT' : 'Final' } };
  } else if (g.kind === 'soccer') {
    const disp = g.minute > 90 ? `90'+${g.minute - 90}'` : `${g.minute}'`;
    status = { period: g.period, clock: g.minute * 60, displayClock: disp, type: { name: 'STATUS_SECOND_HALF', state: 'in', completed: false, shortDetail: disp } };
  } else {
    status = { period: g.period, clock: g.clock, displayClock: mmss(g.clock), type: { name: 'STATUS_IN_PROGRESS', state: 'in', completed: false, shortDetail: `${mmss(g.clock)} - ${ordinal(g.period)}` } };
  }
  let situation;
  if (g.kind === 'football' && g.state === 'in') {
    const off = g.pos === 'home' ? home : away;
    const def = g.pos === 'home' ? away : home;
    const spot = spotText(g, off.abbr, def.abbr);
    const goal = g.dist >= 100 - g.yard;
    const dd = `${ordinal(g.down)} & ${goal ? 'Goal' : g.dist}`;
    situation = {
      down: g.down,
      distance: g.dist,
      yardLine: g.yard > 50 ? 100 - g.yard : g.yard,
      downDistanceText: `${dd} at ${spot}`,
      shortDownDistanceText: dd,
      possessionText: spot,
      isRedZone: g.yard >= 80,
      possession: off.id,
    };
  }
  return {
    id: g.id,
    date: new Date(g.start || Date.now() - 2 * 3600e3).toISOString(),
    name: `${away.name} at ${home.name}`,
    shortName: `${away.abbr} @ ${home.abbr}`,
    status,
    competitions: [
      {
        competitors: [comp(home, 'home', g.hs), comp(away, 'away', g.as)],
        situation,
        broadcasts: [{ market: 'national', names: [g.net] }],
        venue: { fullName: 'Demo Stadium' },
      },
    ],
    links: [{ rel: ['summary'], href: 'https://www.espn.com/' }],
  };
}

export function createDemo() {
  const games = makeGames();
  let lastTick = Date.now();
  const advance = () => {
    const now = Date.now();
    if (now - lastTick < 2000) return;
    lastTick = now;
    for (const g of games) {
      if (g.state !== 'in') continue;
      if (g.kind === 'football') stepFootball(g);
      else if (g.kind === 'basketball') stepBasketball(g);
      else if (g.kind === 'hockey') stepHockey(g);
      else if (g.kind === 'soccer') stepSoccer(g);
    }
  };
  return {
    leagues: ['nfl', 'nba', 'nhl', 'epl'],
    scoreboard(leagueId) {
      advance();
      return { events: games.filter((g) => g.league === leagueId).map(toEspn) };
    },
    /** Channel library + tile setup for the demo. */
    setup() {
      const library = games
        .filter((g) => g.state !== 'post')
        .map((g) => {
          const a = TEAMS[g.away];
          const h = TEAMS[g.home];
          return {
            id: `demo-${g.id}`,
            name: `${g.net} · ${a.short} @ ${h.short}`,
            url: `demo:${g.kind}:${a.abbr}@${h.abbr}:#${a.color}:#${h.color}`,
            kind: 'demo',
            network: g.net,
            group: 'Demo feeds',
            logo: '',
            playlist: 'Demo',
            addedAt: Date.now(),
            gameKey: `${g.league}:${g.id}`,
          };
        });
      const gameStreams = Object.fromEntries(library.map((s) => [s.gameKey, s.id]));
      return { library, gameStreams };
    },
  };
}
