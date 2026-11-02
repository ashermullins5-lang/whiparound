// Scores providers for /api/scores. Each returns games already in the app's shape
// (see normalizeEvent in js/scores.js), so the browser doesn't care where scores come from.
//
//   SCORES_PROVIDER=espn   ESPN's public scoreboard. Fine for development and personal use;
//                          its terms don't allow it in a product you charge for.
//   (licensed providers)   Add an adapter below once you've picked and licensed one.

import { league as leagueById, scoreboardUrl } from '../../js/leagues.js';
import { normalizeEvent } from '../../js/scores.js';

async function getJson(url, init = {}) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.json();
}

const espn = {
  name: 'espn',
  async fetchLeague(id) {
    const l = leagueById(id);
    const data = await getJson(scoreboardUrl(l), { headers: { 'User-Agent': 'Whiparound/1.0' } });
    const games = [];
    for (const ev of data.events || []) {
      try {
        games.push(normalizeEvent(ev, l));
      } catch {}
    }
    return games;
  },
};

const PROVIDERS = { espn };

export function createScoresProvider(name) {
  if (!name) return null;
  const p = PROVIDERS[name.toLowerCase()];
  if (!p) throw new Error(`Unknown SCORES_PROVIDER "${name}". Available: ${Object.keys(PROVIDERS).join(', ')}`);
  return p;
}
