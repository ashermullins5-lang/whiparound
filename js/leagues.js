// Leagues the scoreboard follows. Paths are ESPN's public scoreboard endpoints.
// `regPeriods` is the number of regulation periods, used to spot crunch time and overtime.

export const LEAGUES = [
  { id: 'nfl', label: 'NFL', path: 'football/nfl', kind: 'football', regPeriods: 4 },
  { id: 'ncaaf', label: 'College Football', short: 'NCAAF', path: 'football/college-football', query: 'groups=80&limit=300', kind: 'football', regPeriods: 4 },
  { id: 'nba', label: 'NBA', path: 'basketball/nba', kind: 'basketball', regPeriods: 4 },
  { id: 'wnba', label: 'WNBA', path: 'basketball/wnba', kind: 'basketball', regPeriods: 4 },
  { id: 'ncaam', label: "Men's College Hoops", short: 'NCAAM', path: 'basketball/mens-college-basketball', query: 'groups=50&limit=300', kind: 'basketball', regPeriods: 2 },
  { id: 'ncaaw', label: "Women's College Hoops", short: 'NCAAW', path: 'basketball/womens-college-basketball', query: 'groups=50&limit=300', kind: 'basketball', regPeriods: 4 },
  { id: 'mlb', label: 'MLB', path: 'baseball/mlb', kind: 'baseball', regPeriods: 9 },
  { id: 'nhl', label: 'NHL', path: 'hockey/nhl', kind: 'hockey', regPeriods: 3 },
  { id: 'mls', label: 'MLS', path: 'soccer/usa.1', kind: 'soccer', regPeriods: 2 },
  { id: 'epl', label: 'Premier League', short: 'EPL', path: 'soccer/eng.1', kind: 'soccer', regPeriods: 2 },
  { id: 'laliga', label: 'LaLiga', short: 'LIGA', path: 'soccer/esp.1', kind: 'soccer', regPeriods: 2 },
  { id: 'bundesliga', label: 'Bundesliga', short: 'BUND', path: 'soccer/ger.1', kind: 'soccer', regPeriods: 2 },
  { id: 'seriea', label: 'Serie A', short: 'SERA', path: 'soccer/ita.1', kind: 'soccer', regPeriods: 2 },
  { id: 'ucl', label: 'Champions League', short: 'UCL', path: 'soccer/uefa.champions', kind: 'soccer', regPeriods: 2 },
];

export const DEFAULT_LEAGUES = ['nfl', 'ncaaf', 'nba', 'ncaam', 'mlb', 'nhl', 'mls', 'epl', 'ucl'];

const BY_ID = new Map(LEAGUES.map((l) => [l.id, l]));
export const league = (id) => BY_ID.get(id);
export const leagueShort = (id) => {
  const l = BY_ID.get(id);
  return l ? l.short || l.label : id.toUpperCase();
};

export function scoreboardUrl(l) {
  const base = `https://site.api.espn.com/apis/site/v2/sports/${l.path}/scoreboard`;
  return l.query ? `${base}?${l.query}` : base;
}

// Official places to watch, keyed by the network names ESPN reports.
// These open the rights-holder's own site or app; they can't play inside the grid (DRM).
const WATCH_LINKS = [
  [/^(espn|espn2|espnu|espnews|espn\+|espn deportes|secn|sec network|accn|acc network|longhorn)/i, 'ESPN', 'https://www.espn.com/watch/'],
  [/^abc/i, 'ABC', 'https://abc.com/watch-live'],
  [/^cbs|^paramount/i, 'Paramount+', 'https://www.paramountplus.com/live-tv/'],
  [/^(fox|fs1|fs2|btn|big ten)/i, 'FOX Sports', 'https://www.foxsports.com/live'],
  [/^(nbc|peacock|usa net|usa network)/i, 'Peacock', 'https://www.peacocktv.com/'],
  [/prime video|amazon/i, 'Prime Video', 'https://www.amazon.com/gp/video/storefront'],
  [/^(tnt|tbs|trutv|max)/i, 'HBO Max', 'https://www.hbomax.com/'],
  [/^nfl ?(net|network|\+)/i, 'NFL+', 'https://www.nfl.com/plus/'],
  [/^nba ?(tv|league)/i, 'NBA', 'https://www.nba.com/watch'],
  [/^mlb/i, 'MLB.TV', 'https://www.mlb.com/tv'],
  [/^nhl/i, 'NHL', 'https://www.nhl.com/'],
  [/apple|mls season pass/i, 'Apple TV', 'https://tv.apple.com/'],
  [/netflix/i, 'Netflix', 'https://www.netflix.com/'],
  [/youtube/i, 'YouTube', 'https://www.youtube.com/'],
];

export function watchLinks(networks = []) {
  const out = new Map();
  for (const n of networks) {
    for (const [re, label, href] of WATCH_LINKS) {
      if (re.test(n.trim())) {
        if (!out.has(label)) out.set(label, { label, href, network: n });
        break;
      }
    }
  }
  return [...out.values()];
}
