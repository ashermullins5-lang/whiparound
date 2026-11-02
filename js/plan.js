// What each plan unlocks. "personal" is your own copy (the local helper or a static host
// without the paid backend): everything is on. "paid" is the hosted product with Free and Pro.

export const FREE_LAYOUTS = ['1', '2'];

const ALL = { layouts: 'all', maxTiles: 9, autoWhip: true, alerts: true, autoFill: true };
const FREE = { layouts: FREE_LAYOUTS, maxTiles: 2, autoWhip: false, alerts: false, autoFill: false };

/** Subscription statuses that count as Pro. past_due keeps access while Stripe retries the card. */
export const PRO_STATUSES = ['trialing', 'active', 'past_due'];

export function entitlements(mode, plan) {
  if (mode !== 'paid' || plan === 'pro') return { ...ALL };
  return { ...FREE };
}

export const layoutAllowed = (ent, id) => ent.layouts === 'all' || ent.layouts.includes(id);

/** Why a feature is locked, in words for the upgrade sheet. */
export const UPGRADE_REASONS = {
  layout: 'Watching more than 2 games at once is part of Pro.',
  autoWhip: 'Auto Whip, which jumps to the game with the most going on, is part of Pro.',
  alerts: 'Hot-game alerts are part of Pro.',
  autoFill: 'Filling tiles with hot games is part of Pro.',
  generic: 'Get the full multiview.',
};

export const PLAN_ROWS = [
  ['Live scores and score overlays', true, true],
  ['Games on screen at once', '2', 'Up to 9'],
  ['Auto Whip to the hottest game', false, true],
  ['Alerts for hot games off screen', false, true],
  ['Swap hot games into your tiles', false, true],
];
