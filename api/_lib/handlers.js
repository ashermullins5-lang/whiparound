// Request handlers for the hosted (paid) version. Each takes a Web-standard Request plus `deps`
// (Stripe, the subscriptions table, sign-in verification, scores) and returns a Response, so they
// run the same on Vercel, in a local dev server, and in tests with stand-in services.

import { LEAGUES, league as leagueById } from '../../js/leagues.js';
import { PRO_STATUSES } from '../../js/plan.js';

export const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });

const bearer = (request) => /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') || '')?.[1] || null;
const iso = (unix) => (unix ? new Date(unix * 1000).toISOString() : null);
const isPro = (row) => !!row && PRO_STATUSES.includes(row.status);

/** Where Stripe sends people back to. APP_URL wins over the request's own host header. */
const appOrigin = (request, deps) => (deps.env.appUrl || new URL(request.url).origin).replace(/\/+$/, '');

async function requireUser(request, deps) {
  const token = bearer(request);
  if (!token) return { error: json(401, { error: 'Sign in first.' }) };
  let user = null;
  try {
    user = await deps.auth.userFromToken(token);
  } catch {
    return { error: json(503, { error: "Couldn't check your sign-in right now. Try again in a moment." }) };
  }
  if (!user) return { error: json(401, { error: 'Your sign-in expired. Sign in again.' }) };
  return { user };
}

function notConfigured(deps) {
  return json(503, { error: 'Payments aren’t set up on this server yet.', missing: deps.missing });
}

// ---------- GET /api/config ----------

const priceCache = new Map();
async function priceLabel(deps, id) {
  if (!id) return null;
  const hit = priceCache.get(id);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.label;
  const p = await deps.stripe.prices.retrieve(id);
  const amount = (p.unit_amount ?? 0) / 100;
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: (p.currency || 'usd').toUpperCase() }).format(amount);
  const label = `${money} a ${p.recurring?.interval === 'year' ? 'year' : 'month'}`;
  priceCache.set(id, { label, at: Date.now() });
  return label;
}

export async function handleConfig(request, deps) {
  if (!deps.configured) return json(200, { paywall: false }, { 'Cache-Control': 'public, max-age=60' });
  const prices = {};
  for (const [key, id] of [
    ['month', deps.env.priceMonthly],
    ['year', deps.env.priceYearly],
  ]) {
    if (!id) continue;
    try {
      prices[key] = { label: await priceLabel(deps, id) };
    } catch {
      prices[key] = { label: '' };
    }
  }
  return json(
    200,
    {
      paywall: true,
      supabaseUrl: deps.env.supabaseUrl,
      supabaseKey: deps.env.supabasePublishableKey,
      trialDays: deps.env.trialDays,
      prices,
      logos: deps.env.logos,
      scores: deps.env.scoresProvider ? 'server' : 'espn',
    },
    { 'Cache-Control': 'public, max-age=60, s-maxage=300' }
  );
}

// ---------- GET /api/me ----------

export async function handleMe(request, deps) {
  if (!deps.configured) return notConfigured(deps);
  const { user, error } = await requireUser(request, deps);
  if (error) return error;
  const row = await deps.db.byUser(user.id);
  return json(200, {
    signedIn: true,
    email: user.email || '',
    plan: isPro(row) ? 'pro' : 'free',
    status: row?.status || null,
    trialEnd: row?.trial_end || null,
    periodEnd: row?.current_period_end || null,
    cancelAtPeriodEnd: !!row?.cancel_at_period_end,
  });
}

// ---------- POST /api/checkout ----------

export async function handleCheckout(request, deps) {
  if (!deps.configured) return notConfigured(deps);
  const { user, error } = await requireUser(request, deps);
  if (error) return error;
  let body = {};
  try {
    body = await request.json();
  } catch {}
  const interval = body.interval === 'year' ? 'year' : 'month';
  const price = interval === 'year' ? deps.env.priceYearly : deps.env.priceMonthly;
  if (!price) return json(400, { error: `There's no ${interval}ly plan right now.` });

  let row = await deps.db.byUser(user.id);
  if (isPro(row)) return json(409, { error: 'You’re already on Pro. Use Manage billing to change your plan.' });

  // One Stripe customer per account, created up front so a retry or a second tab reuses it.
  let customer = row?.stripe_customer_id;
  if (!customer) {
    const c = await deps.stripe.customers.create(
      { email: user.email || undefined, metadata: { userId: user.id } },
      { idempotencyKey: `customer-${user.id}` }
    );
    customer = c.id;
    row = await deps.db.upsert({ user_id: user.id, stripe_customer_id: customer });
  }

  const origin = appOrigin(request, deps);
  const trial = deps.env.trialDays > 0 && !row?.had_trial;
  const session = await deps.stripe.checkout.sessions.create({
    mode: 'subscription',
    customer,
    client_reference_id: user.id,
    line_items: [{ price, quantity: 1 }],
    metadata: { userId: user.id },
    subscription_data: {
      metadata: { userId: user.id },
      ...(trial ? { trial_period_days: deps.env.trialDays, trial_settings: { end_behavior: { missing_payment_method: 'cancel' } } } : {}),
    },
    allow_promotion_codes: true,
    success_url: `${origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/?checkout=cancel`,
  });
  return json(200, { url: session.url });
}

// ---------- POST /api/portal ----------

export async function handlePortal(request, deps) {
  if (!deps.configured) return notConfigured(deps);
  const { user, error } = await requireUser(request, deps);
  if (error) return error;
  const row = await deps.db.byUser(user.id);
  if (!row?.stripe_customer_id) return json(404, { error: 'There’s no billing account yet. Start a plan first.' });
  const portal = await deps.stripe.billingPortal.sessions.create({ customer: row.stripe_customer_id, return_url: `${appOrigin(request, deps)}/` });
  return json(200, { url: portal.url });
}

// ---------- POST /api/stripe-webhook ----------

/** The subscription's state, as a row for the subscriptions table. */
export function subscriptionRow(sub, userId, prev) {
  const item = sub.items?.data?.[0];
  // Since API version 2025-03-31 the billing period lives on each subscription item.
  const ends = (sub.items?.data || []).map((i) => i.current_period_end).filter(Boolean);
  const periodEnd = ends.length ? Math.min(...ends) : sub.current_period_end;
  return {
    user_id: userId,
    stripe_customer_id: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id,
    stripe_subscription_id: sub.id,
    status: sub.status,
    price_id: item?.price?.id || null,
    interval: item?.price?.recurring?.interval || null,
    trial_end: iso(sub.trial_end),
    current_period_end: iso(periodEnd),
    cancel_at_period_end: !!(sub.cancel_at_period_end || sub.cancel_at),
    had_trial: !!(prev?.had_trial || sub.trial_end || sub.trial_start),
    updated_at: new Date().toISOString(),
  };
}

async function syncSubscription(deps, subId, hintUserId = null, fallback = null) {
  let sub;
  try {
    // Always read the current state from Stripe: webhook events can arrive out of order.
    sub = await deps.stripe.subscriptions.retrieve(subId);
  } catch (e) {
    if (e?.statusCode === 404 && fallback) sub = fallback;
    else throw e;
  }
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  let userId = hintUserId || sub.metadata?.userId || null;
  const byCustomer = customerId ? await deps.db.byCustomer(customerId) : null;
  if (!userId) userId = byCustomer?.user_id || null;
  if (!userId) return { skipped: `no account for ${customerId}` };
  const prev = byCustomer?.user_id === userId ? byCustomer : await deps.db.byUser(userId);
  // A user with an active plan keeps it if an older, ended subscription reports in late.
  if (prev?.stripe_subscription_id && prev.stripe_subscription_id !== sub.id && isPro(prev) && !PRO_STATUSES.includes(sub.status)) {
    return { skipped: 'older subscription' };
  }
  await deps.db.upsert(subscriptionRow(sub, userId, prev));
  return { synced: sub.id, status: sub.status };
}

const invoiceSubscription = (inv) =>
  inv.subscription || inv.parent?.subscription_details?.subscription || inv.lines?.data?.[0]?.parent?.subscription_item_details?.subscription || null;

export async function handleWebhook(request, deps) {
  if (!deps.configured) return notConfigured(deps);
  const signature = request.headers.get('stripe-signature');
  if (!signature) return json(400, { error: 'Missing Stripe signature' });
  const raw = await request.text();
  let event;
  try {
    event = await deps.stripe.webhooks.constructEventAsync(raw, signature, deps.env.webhookSecret);
  } catch {
    return json(400, { error: 'Bad signature' });
  }
  const obj = event.data?.object || {};
  let result = { ignored: event.type };
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      if (obj.mode !== 'subscription' || !obj.subscription) break;
      const userId = obj.client_reference_id || obj.metadata?.userId;
      const subId = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription.id;
      result = await syncSubscription(deps, subId, userId);
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed':
    case 'customer.subscription.trial_will_end':
      result = await syncSubscription(deps, obj.id, null, obj);
      break;
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const subId = invoiceSubscription(obj);
      if (subId) result = await syncSubscription(deps, typeof subId === 'string' ? subId : subId.id);
      break;
    }
  }
  return json(200, { received: true, ...result });
}

// ---------- GET /api/scores?league= ----------

export async function handleScores(request, deps) {
  const params = new URL(request.url).searchParams;
  const id = params.get('league') || '';
  // The CDN caches by full URL, so extra parameters would skip the cache and hit the
  // (paid) provider on every request. Only ?league= is allowed.
  if ([...params.keys()].some((k) => k !== 'league') || params.getAll('league').length !== 1) {
    return json(400, { error: 'Only ?league= is allowed.' });
  }
  if (!leagueById(id)) return json(400, { error: `Unknown league. Use one of: ${LEAGUES.map((l) => l.id).join(', ')}` });
  if (!deps.scores) return json(503, { error: 'No scores provider is set up on this server.' });
  try {
    const games = await deps.scores.fetchLeague(id);
    return json(
      200,
      { league: id, games, updatedAt: new Date().toISOString() },
      // One upstream call per league every ~10s, shared by everyone, at Vercel's CDN.
      { 'Cache-Control': 'public, max-age=0, must-revalidate', 'Vercel-CDN-Cache-Control': 'max-age=10, stale-while-revalidate=30' }
    );
  } catch (e) {
    return json(502, { error: 'The scores provider didn’t answer. Retrying shortly.' }, { 'Cache-Control': 'no-store' });
  }
}
