// Real services for the handlers, built from environment variables (see .env.example).
// Nothing here runs in the browser; secret keys stay on the server.

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { createScoresProvider } from './scores.js';

const REQUIRED = [
  'SUPABASE_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SECRET_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
];

export function readEnv(env = process.env) {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (!env.STRIPE_PRICE_MONTHLY && !env.STRIPE_PRICE_YEARLY) missing.push('STRIPE_PRICE_MONTHLY or STRIPE_PRICE_YEARLY');
  return {
    missing,
    appUrl: env.APP_URL || '',
    supabaseUrl: env.SUPABASE_URL || '',
    supabasePublishableKey: env.SUPABASE_PUBLISHABLE_KEY || '',
    priceMonthly: env.STRIPE_PRICE_MONTHLY || '',
    priceYearly: env.STRIPE_PRICE_YEARLY || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    trialDays: Math.max(0, Number(env.TRIAL_DAYS ?? 7) || 0),
    // Team logos are trademarks; keep them off unless you've licensed them.
    logos: env.SHOW_TEAM_LOGOS === 'true',
    scoresProvider: env.SCORES_PROVIDER || '',
  };
}

let cached = null;

export function getDeps(env = process.env) {
  if (cached) return cached;
  const e = readEnv(env);
  const configured = e.missing.length === 0;
  const deps = { env: e, configured, missing: e.missing, scores: createScoresProvider(e.scoresProvider, env) };
  if (configured) {
    deps.stripe = new Stripe(env.STRIPE_SECRET_KEY);
    const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    deps.auth = {
      // Asks Supabase Auth who this access token belongs to (also catches signed-out sessions).
      async userFromToken(token) {
        const { data, error } = await admin.auth.getUser(token);
        if (error || !data?.user) return null;
        return { id: data.user.id, email: data.user.email || '' };
      },
    };
    const table = () => admin.from('subscriptions');
    const one = async (q) => {
      const { data, error } = await q.maybeSingle();
      if (error) throw new Error(`subscriptions: ${error.message}`);
      return data;
    };
    deps.db = {
      byUser: (userId) => one(table().select('*').eq('user_id', userId)),
      byCustomer: (customerId) => one(table().select('*').eq('stripe_customer_id', customerId)),
      async upsert(row) {
        const { data, error } = await table().upsert(row, { onConflict: 'user_id' }).select('*').maybeSingle();
        if (error) throw new Error(`subscriptions: ${error.message}`);
        return data;
      },
    };
  }
  cached = deps;
  return deps;
}
