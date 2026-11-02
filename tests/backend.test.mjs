// Tests for the paid version's API handlers, with stand-ins for Stripe and the database.
// Webhooks are signed with Stripe's real signing code, so signature checks are exercised for real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { handleConfig, handleMe, handleCheckout, handlePortal, handleWebhook, handleScores, subscriptionRow } from '../api/_lib/handlers.js';
import { readEnv } from '../api/_lib/deps.js';

const real = new Stripe('sk_test_dummy');
const SECRET = 'whsec_test_secret';
const now = Math.floor(Date.now() / 1000);

function setup({ rows = [], users = { tok_alice: { id: 'user_alice', email: 'alice@example.com' } } } = {}) {
  const table = new Map(rows.map((r) => [r.user_id, { ...r }]));
  const calls = [];
  const subs = new Map();
  const deps = {
    configured: true,
    missing: [],
    env: {
      appUrl: 'https://app.example',
      supabaseUrl: 'https://proj.supabase.co',
      supabasePublishableKey: 'sb_publishable_abc',
      priceMonthly: 'price_month',
      priceYearly: 'price_year',
      webhookSecret: SECRET,
      trialDays: 7,
      logos: false,
      scoresProvider: 'espn',
    },
    auth: { userFromToken: async (t) => users[t] || null },
    db: {
      byUser: async (id) => table.get(id) || null,
      byCustomer: async (c) => [...table.values()].find((r) => r.stripe_customer_id === c) || null,
      upsert: async (row) => {
        const next = { ...(table.get(row.user_id) || {}), ...row };
        table.set(row.user_id, next);
        return next;
      },
    },
    stripe: {
      webhooks: real.webhooks,
      prices: {
        retrieve: async (id) => ({ id, unit_amount: id === 'price_year' ? 2499 : 399, currency: 'usd', recurring: { interval: id === 'price_year' ? 'year' : 'month' } }),
      },
      customers: {
        create: async (params, opts) => {
          calls.push(['customers.create', params, opts]);
          return { id: 'cus_new' };
        },
      },
      checkout: {
        sessions: {
          create: async (params) => {
            calls.push(['checkout', params]);
            return { url: 'https://checkout.stripe.com/c/pay/cs_test_1' };
          },
        },
      },
      billingPortal: {
        sessions: {
          create: async (params) => {
            calls.push(['portal', params]);
            return { url: 'https://billing.stripe.com/p/session/test' };
          },
        },
      },
      subscriptions: {
        retrieve: async (id) => {
          if (!subs.has(id)) {
            const e = new Error('No such subscription');
            e.statusCode = 404;
            throw e;
          }
          return subs.get(id);
        },
      },
    },
    scores: { fetchLeague: async (id) => [{ key: `${id}:1`, id: '1' }] },
  };
  return { deps, table, calls, subs };
}

const req = (path, { method = 'GET', token, body, headers = {} } = {}) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

function signed(event) {
  const payload = JSON.stringify(event);
  const sig = real.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  return new Request('http://localhost/api/stripe-webhook', { method: 'POST', headers: { 'stripe-signature': sig }, body: payload });
}

const sub = (o = {}) => ({
  id: 'sub_1',
  object: 'subscription',
  customer: 'cus_new',
  status: 'trialing',
  metadata: { userId: 'user_alice' },
  trial_start: now,
  trial_end: now + 7 * 86400,
  cancel_at_period_end: false,
  cancel_at: null,
  items: { data: [{ current_period_end: now + 7 * 86400, price: { id: 'price_year', recurring: { interval: 'year' } } }] },
  ...o,
});

test('config is public-safe and reflects setup', async () => {
  const off = await handleConfig(req('/api/config'), { configured: false, missing: ['X'] });
  assert.deepEqual(await off.json(), { paywall: false });
  const { deps } = setup();
  const r = await handleConfig(req('/api/config'), deps);
  const body = await r.json();
  assert.equal(body.paywall, true);
  assert.equal(body.supabaseKey, 'sb_publishable_abc');
  assert.deepEqual(body.prices, { month: { label: '$3.99 a month' }, year: { label: '$24.99 a year' } });
  assert.equal(body.trialDays, 7);
  assert.equal(body.logos, false);
  assert.equal(body.scores, 'server');
  const text = JSON.stringify(body);
  assert.ok(!/sk_|whsec|sb_secret/.test(text), 'no secrets in public config');
});

test('env reading flags what is missing', () => {
  const e = readEnv({ SUPABASE_URL: 'x' });
  assert.ok(e.missing.includes('STRIPE_SECRET_KEY'));
  assert.ok(e.missing.includes('STRIPE_PRICE_MONTHLY or STRIPE_PRICE_YEARLY'));
  assert.equal(e.trialDays, 7);
  assert.equal(e.logos, false);
  assert.equal(readEnv({ TRIAL_DAYS: '0' }).trialDays, 0);
});

test('/api/me needs a valid sign-in and reports the plan', async () => {
  const { deps, table } = setup();
  assert.equal((await handleMe(req('/api/me'), deps)).status, 401);
  assert.equal((await handleMe(req('/api/me', { token: 'tok_forged' }), deps)).status, 401);
  let me = await (await handleMe(req('/api/me', { token: 'tok_alice' }), deps)).json();
  assert.equal(me.plan, 'free');
  assert.equal(me.email, 'alice@example.com');
  table.set('user_alice', { user_id: 'user_alice', status: 'trialing', trial_end: '2026-11-09T00:00:00.000Z', current_period_end: '2026-11-09T00:00:00.000Z' });
  me = await (await handleMe(req('/api/me', { token: 'tok_alice' }), deps)).json();
  assert.equal(me.plan, 'pro');
  assert.equal(me.trialEnd, '2026-11-09T00:00:00.000Z');
  table.get('user_alice').status = 'canceled';
  me = await (await handleMe(req('/api/me', { token: 'tok_alice' }), deps)).json();
  assert.equal(me.plan, 'free');
});

test('sign-in service outage is a 503, not a sign-out', async () => {
  const { deps } = setup();
  deps.auth.userFromToken = async () => {
    throw new Error('network');
  };
  assert.equal((await handleMe(req('/api/me', { token: 'tok_alice' }), deps)).status, 503);
});

test('checkout creates one customer, sets the trial once, and uses APP_URL', async () => {
  const { deps, table, calls } = setup();
  assert.equal((await handleCheckout(req('/api/checkout', { method: 'POST', body: { interval: 'year' } }), deps)).status, 401);
  const r = await handleCheckout(req('/api/checkout', { method: 'POST', token: 'tok_alice', body: { interval: 'year' } }), deps);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).url, 'https://checkout.stripe.com/c/pay/cs_test_1');
  const [, cParams, cOpts] = calls.find((c) => c[0] === 'customers.create');
  assert.equal(cParams.email, 'alice@example.com');
  assert.equal(cParams.metadata.userId, 'user_alice');
  assert.equal(cOpts.idempotencyKey, 'customer-user_alice');
  assert.equal(table.get('user_alice').stripe_customer_id, 'cus_new');
  const s = calls.find((c) => c[0] === 'checkout')[1];
  assert.equal(s.mode, 'subscription');
  assert.equal(s.customer, 'cus_new');
  assert.equal(s.client_reference_id, 'user_alice');
  assert.deepEqual(s.line_items, [{ price: 'price_year', quantity: 1 }]);
  assert.equal(s.subscription_data.trial_period_days, 7);
  assert.equal(s.subscription_data.metadata.userId, 'user_alice');
  assert.equal(s.subscription_data.trial_settings.end_behavior.missing_payment_method, 'cancel');
  assert.ok(s.success_url.startsWith('https://app.example/?checkout=success&session_id={CHECKOUT_SESSION_ID}'));
  assert.equal(s.cancel_url, 'https://app.example/?checkout=cancel');
  assert.equal(s.payment_method_types, undefined, 'never send payment_method_types (rejected by this API version)');

  // Second attempt: same customer, no new one. After a trial was used, no second trial.
  table.get('user_alice').had_trial = true;
  calls.length = 0;
  await handleCheckout(req('/api/checkout', { method: 'POST', token: 'tok_alice', body: { interval: 'month' } }), deps);
  assert.equal(calls.filter((c) => c[0] === 'customers.create').length, 0);
  const s2 = calls.find((c) => c[0] === 'checkout')[1];
  assert.equal(s2.customer, 'cus_new');
  assert.deepEqual(s2.line_items, [{ price: 'price_month', quantity: 1 }]);
  assert.equal(s2.subscription_data.trial_period_days, undefined);

  // Already Pro: no second subscription.
  table.get('user_alice').status = 'active';
  assert.equal((await handleCheckout(req('/api/checkout', { method: 'POST', token: 'tok_alice', body: {} }), deps)).status, 409);
});

test('billing portal needs a customer', async () => {
  const { deps, table, calls } = setup();
  assert.equal((await handlePortal(req('/api/portal', { method: 'POST', token: 'tok_alice' }), deps)).status, 404);
  table.set('user_alice', { user_id: 'user_alice', stripe_customer_id: 'cus_new' });
  const r = await handlePortal(req('/api/portal', { method: 'POST', token: 'tok_alice' }), deps);
  assert.equal((await r.json()).url, 'https://billing.stripe.com/p/session/test');
  assert.deepEqual(calls.at(-1)[1], { customer: 'cus_new', return_url: 'https://app.example/' });
});

test('webhooks reject unsigned or forged events', async () => {
  const { deps } = setup();
  assert.equal((await handleWebhook(new Request('http://x/api/stripe-webhook', { method: 'POST', body: '{}' }), deps)).status, 400);
  const forged = new Request('http://x/api/stripe-webhook', { method: 'POST', headers: { 'stripe-signature': `t=${now},v1=deadbeef` }, body: '{"type":"customer.subscription.updated"}' });
  assert.equal((await handleWebhook(forged, deps)).status, 400);
});

test('checkout completion turns on Pro with the right dates', async () => {
  const { deps, table, subs } = setup({ rows: [{ user_id: 'user_alice', stripe_customer_id: 'cus_new' }] });
  subs.set('sub_1', sub());
  const r = await handleWebhook(
    signed({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_1', client_reference_id: 'user_alice', customer: 'cus_new' } } }),
    deps
  );
  assert.equal(r.status, 200);
  const row = table.get('user_alice');
  assert.equal(row.status, 'trialing');
  assert.equal(row.stripe_subscription_id, 'sub_1');
  assert.equal(row.had_trial, true);
  assert.equal(row.interval, 'year');
  assert.equal(row.price_id, 'price_year');
  assert.equal(row.current_period_end, new Date((now + 7 * 86400) * 1000).toISOString());
  const me = await (await handleMe(req('/api/me', { token: 'tok_alice' }), deps)).json();
  assert.equal(me.plan, 'pro');
});

test('events re-read the subscription, so out-of-order delivery ends in the right state', async () => {
  const { deps, table, subs } = setup({ rows: [{ user_id: 'user_alice', stripe_customer_id: 'cus_new' }] });
  // Stripe's current truth is "active", even though this (late) event carries "trialing".
  subs.set('sub_1', sub({ status: 'active', trial_end: null }));
  await handleWebhook(signed({ id: 'evt_2', type: 'customer.subscription.updated', data: { object: sub({ status: 'trialing' }) } }), deps);
  assert.equal(table.get('user_alice').status, 'active');
  assert.equal(table.get('user_alice').had_trial, true, 'trial history is kept');
});

test('cancellation, payment failure and unknown customers', async () => {
  const { deps, table, subs } = setup({ rows: [{ user_id: 'user_alice', stripe_customer_id: 'cus_new', stripe_subscription_id: 'sub_1', status: 'active' }] });
  // Deleted subscriptions may 404 on retrieve; the event's own copy is used.
  await handleWebhook(signed({ id: 'evt_3', type: 'customer.subscription.deleted', data: { object: sub({ status: 'canceled' }) } }), deps);
  assert.equal(table.get('user_alice').status, 'canceled');
  assert.equal((await (await handleMe(req('/api/me', { token: 'tok_alice' }), deps)).json()).plan, 'free');

  // invoice.payment_failed with the newer invoice shape (subscription under parent)
  subs.set('sub_2', sub({ id: 'sub_2', status: 'past_due', trial_end: null, trial_start: null }));
  await handleWebhook(
    signed({ id: 'evt_4', type: 'invoice.payment_failed', data: { object: { parent: { subscription_details: { subscription: 'sub_2' } } } } }),
    deps
  );
  assert.equal(table.get('user_alice').status, 'past_due');
  assert.equal((await (await handleMe(req('/api/me', { token: 'tok_alice' }), deps)).json()).plan, 'pro', 'past_due keeps access while Stripe retries');

  // A subscription for someone we don't know is acknowledged, not retried forever.
  subs.set('sub_9', sub({ id: 'sub_9', customer: 'cus_unknown', metadata: {} }));
  const r = await handleWebhook(signed({ id: 'evt_5', type: 'customer.subscription.updated', data: { object: sub({ id: 'sub_9', customer: 'cus_unknown', metadata: {} }) } }), deps);
  assert.equal(r.status, 200);
  assert.match((await r.json()).skipped, /no account/);

  const ignored = await handleWebhook(signed({ id: 'evt_6', type: 'charge.refunded', data: { object: {} } }), deps);
  assert.equal((await ignored.json()).ignored, 'charge.refunded');
});

test('a late event about an old, ended subscription does not remove an active plan', async () => {
  const { deps, table, subs } = setup({ rows: [{ user_id: 'user_alice', stripe_customer_id: 'cus_new', stripe_subscription_id: 'sub_new', status: 'active' }] });
  subs.set('sub_old', sub({ id: 'sub_old', status: 'canceled' }));
  await handleWebhook(signed({ id: 'evt_7', type: 'customer.subscription.deleted', data: { object: sub({ id: 'sub_old', status: 'canceled' }) } }), deps);
  assert.equal(table.get('user_alice').status, 'active');
  assert.equal(table.get('user_alice').stripe_subscription_id, 'sub_new');
});

test('cancel at period end is reported', () => {
  const row = subscriptionRow(sub({ status: 'active', cancel_at: now + 86400 }), 'user_alice', null);
  assert.equal(row.cancel_at_period_end, true);
});

test('scores endpoint: only ?league=, cached at the CDN', async () => {
  const { deps } = setup();
  assert.equal((await handleScores(req('/api/scores?league=nfl&bust=1'), deps)).status, 400);
  assert.equal((await handleScores(req('/api/scores?league=nfl&league=nba'), deps)).status, 400);
  assert.equal((await handleScores(req('/api/scores?league=cricket'), deps)).status, 400);
  const r = await handleScores(req('/api/scores?league=nfl'), deps);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).games[0].key, 'nfl:1');
  assert.match(r.headers.get('vercel-cdn-cache-control'), /max-age=10/);
  deps.scores.fetchLeague = async () => {
    throw new Error('down');
  };
  const bad = await handleScores(req('/api/scores?league=nfl'), deps);
  assert.equal(bad.status, 502);
  assert.equal(bad.headers.get('cache-control'), 'no-store');
});
