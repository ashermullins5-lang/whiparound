// "Heat" rating: how much is happening in a live game right now, 0–100.
// Auto Whip uses it to decide which game gets the big screen and the sound.

const add = (acc, points, reason) => {
  acc.score += points;
  if (reason && points > acc.best) {
    acc.best = points;
    acc.reason = reason;
  }
};

function football(g, acc) {
  const s = g.situation || {};
  const margin = Math.abs((g.home?.score ?? 0) - (g.away?.score ?? 0));
  const late = g.period >= g.regPeriods;
  const ot = g.period > g.regPeriods;
  const clock = g.clock ?? 900;
  if (s.isRedZone) add(acc, 45, /&\s*goal/i.test(s.short || s.text || '') ? 'GOAL TO GO' : 'RED ZONE');
  if (s.down === 4) add(acc, 15, '4TH DOWN');
  if (ot) add(acc, 30, 'OVERTIME');
  else if (late && margin <= 8) add(acc, 20, 'ONE-SCORE GAME');
  if ((g.period === 2 || g.period === g.regPeriods) && clock <= 120) add(acc, 12, 'TWO-MINUTE DRILL');
  if (late && margin >= 22) add(acc, -25);
}

function basketball(g, acc) {
  const margin = Math.abs((g.home?.score ?? 0) - (g.away?.score ?? 0));
  const finalPeriod = g.period >= g.regPeriods;
  const ot = g.period > g.regPeriods;
  const clock = g.clock ?? 720;
  if (ot) add(acc, 40, 'OVERTIME');
  if (finalPeriod && clock <= 300 && margin <= 5) add(acc, 55, 'CRUNCH TIME');
  else if (finalPeriod && margin <= 10) add(acc, 20, 'CLOSE LATE');
  else if (margin <= 3) add(acc, 5);
  if (finalPeriod && margin >= 20) add(acc, -20);
}

function baseball(g, acc) {
  const s = g.situation || {};
  const margin = Math.abs((g.home?.score ?? 0) - (g.away?.score ?? 0));
  const inning = g.period || 1;
  const risp = s.onSecond || s.onThird;
  if (s.onFirst && s.onSecond && s.onThird) add(acc, 35, 'BASES LOADED');
  else if (risp) add(acc, 22, 'RUNNER IN SCORING POSITION');
  if (inning >= 10) add(acc, 25, 'EXTRA INNINGS');
  else if (inning >= 7 && margin <= 2) add(acc, 25, 'LATE & CLOSE');
  if (inning >= 9 && margin <= 1) add(acc, 15, 'LAST CHANCE');
  if (risp && s.outs === 2) add(acc, 5);
  if (s.balls === 3 && s.strikes === 2) add(acc, 5, 'FULL COUNT');
  if (inning >= 7 && margin >= 7) add(acc, -15);
}

function hockey(g, acc) {
  const margin = Math.abs((g.home?.score ?? 0) - (g.away?.score ?? 0));
  const clock = g.clock ?? 1200;
  if (g.period >= 5) add(acc, 60, 'SHOOTOUT');
  else if (g.period === 4) add(acc, 50, 'OVERTIME');
  else if (g.period === 3) {
    if (margin === 1 && clock <= 150) add(acc, 50, 'EMPTY-NET TIME');
    else if (margin <= 1) add(acc, 35, margin === 0 ? 'TIED LATE' : 'ONE-GOAL GAME');
  } else if (margin === 0) add(acc, 5);
}

function soccer(g, acc) {
  const margin = Math.abs((g.home?.score ?? 0) - (g.away?.score ?? 0));
  const minute = parseInt(g.displayClock, 10) || Math.floor((g.clock ?? 0) / 60);
  if (g.period >= 5) add(acc, 60, 'PENALTIES');
  else if (g.period >= 3) add(acc, 45, 'EXTRA TIME');
  else if (minute >= 75 && margin <= 1) {
    add(acc, 35, margin === 0 ? 'LEVEL LATE' : 'ONE-GOAL GAME');
    if (/\+/.test(g.displayClock)) add(acc, 15, 'STOPPAGE TIME');
  }
}

const BY_KIND = { football, basketball, baseball, hockey, soccer };

export function rateGame(g, now = Date.now()) {
  if (!g || g.state !== 'in') return { score: 0, reason: null };
  const acc = { score: 10, best: 0, reason: null };
  BY_KIND[g.kind]?.(g, acc);
  if (g.lastScoreAt && now - g.lastScoreAt < 90_000) add(acc, 15, 'JUST SCORED');
  return { score: Math.max(0, Math.min(100, Math.round(acc.score))), reason: acc.reason };
}

/** Banner text for a scoring change, or null when it's not worth a flash (e.g. every basket). */
export function scoringLabel(kind, delta) {
  if (kind === 'football') {
    if (delta >= 6) return 'TOUCHDOWN';
    if (delta === 3) return 'FIELD GOAL';
    if (delta === 2) return 'SAFETY / 2-PT';
    return null;
  }
  if (kind === 'hockey' || kind === 'soccer') return 'GOAL';
  if (kind === 'baseball') return delta === 1 ? 'RUN SCORES' : `${delta} RUNS SCORE`;
  return null;
}

export function heatLevel(score) {
  if (score >= 55) return 'blazing';
  if (score >= 35) return 'hot';
  if (score >= 20) return 'warm';
  return 'cool';
}
