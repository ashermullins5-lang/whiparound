// Accounts and billing for the hosted (paid) version.
// Sign-in uses Supabase Auth with a 6-digit email code (it also works with the email's link),
// which keeps working inside a Home Screen app where a magic link would open in Safari instead.
// Billing goes through our /api endpoints, which talk to Stripe; the browser never sees a secret.

import { PRO_STATUSES } from './plan.js';

const apiUrl = (path) => new URL(`api/${path}`, location.href).href;
const PLAN_CACHE = 'whiparound:plan';

/** The hosted backend's public settings, or null when there is no paid backend (your own copy). */
export async function loadConfig() {
  if (!location.protocol.startsWith('http')) return null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(apiUrl('config'), { cache: 'no-store', signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok || !/json/.test(r.headers.get('content-type') || '')) return null;
    const cfg = await r.json();
    return cfg && cfg.paywall === true && cfg.supabaseUrl && cfg.supabaseKey ? cfg : null;
  } catch {
    return null;
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.supabase?.createClient) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Couldn't load sign-in. Check your connection and reload."));
    document.head.append(s);
  });
}

function readCachedPlan() {
  try {
    const c = JSON.parse(localStorage.getItem(PLAN_CACHE) || 'null');
    // Only used to avoid a flash of locked buttons while we check; the server decides.
    if (c && Date.now() - c.at < 24 * 3600e3) return c;
  } catch {}
  return null;
}

export function createAccount(config, onChange) {
  const cached = readCachedPlan();
  const state = {
    ready: false,
    user: null,
    plan: cached?.plan === 'pro' ? 'pro' : 'free',
    status: cached?.status || null,
    trialEnd: null,
    periodEnd: null,
    cancelAtPeriodEnd: false,
    error: '',
  };
  let client = null;
  let session = null;
  const emit = () => onChange?.(state);

  async function call(path, { method = 'GET', body } = {}) {
    if (client) session = (await client.auth.getSession()).data.session;
    const headers = { Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
    const r = await fetch(apiUrl(path), { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(json.error || `Something went wrong (${r.status}). Try again.`);
      err.status = r.status;
      throw err;
    }
    return json;
  }

  async function refresh(next) {
    session = next ?? null;
    state.user = session?.user ? { id: session.user.id, email: session.user.email || '' } : null;
    if (!state.user) {
      Object.assign(state, { plan: 'free', status: null, trialEnd: null, periodEnd: null, cancelAtPeriodEnd: false });
    } else {
      try {
        const me = await call('me');
        const pro = PRO_STATUSES.includes(me.status);
        Object.assign(state, {
          plan: pro ? 'pro' : 'free',
          status: me.status || null,
          trialEnd: me.trialEnd || null,
          periodEnd: me.periodEnd || null,
          cancelAtPeriodEnd: !!me.cancelAtPeriodEnd,
          error: '',
        });
      } catch (e) {
        state.error = e.message;
      }
    }
    try {
      localStorage.setItem(PLAN_CACHE, JSON.stringify({ plan: state.plan, status: state.status, at: Date.now() }));
    } catch {}
    state.ready = true;
    emit();
  }

  return {
    state,

    async init() {
      try {
        await loadScript('vendor/supabase.min.js');
        client = window.supabase.createClient(config.supabaseUrl, config.supabaseKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
        });
        let last = null;
        client.auth.onAuthStateChange((event, s) => {
          // Token refreshes don't change who you are; only re-check the plan when that does.
          const id = s?.user?.id || null;
          if (event === 'TOKEN_REFRESHED' && id === last) return;
          last = id;
          setTimeout(() => refresh(s), 0);
        });
        const { data } = await client.auth.getSession();
        last = data.session?.user?.id || null;
        await refresh(data.session);
      } catch (e) {
        state.error = e.message;
        state.ready = true;
        emit();
      }
    },

    /** Email a sign-in code (the email also contains a link). */
    async sendCode(email) {
      const { error } = await client.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname },
      });
      if (error) throw new Error(friendlyAuthError(error));
    },

    async verifyCode(email, code) {
      const { data, error } = await client.auth.verifyOtp({ email, token: code, type: 'email' });
      if (error) throw new Error(friendlyAuthError(error));
      await refresh(data.session);
    },

    async signOut() {
      await client?.auth.signOut();
      await refresh(null);
    },

    /** Re-check the plan, e.g. right after Stripe checkout while the webhook lands. */
    async refreshPlan() {
      const s = client ? (await client.auth.getSession()).data.session : null;
      await refresh(s);
      return state.plan;
    },

    async checkout(interval) {
      const { url } = await call('checkout', { method: 'POST', body: { interval } });
      location.assign(url);
    },

    async manageBilling() {
      const { url } = await call('portal', { method: 'POST' });
      location.assign(url);
    },
  };
}

function friendlyAuthError(error) {
  const msg = String(error?.message || error || '');
  if (/rate|too many|security purposes/i.test(msg)) return 'Too many tries. Wait a minute, then ask for a new code.';
  if (/expired|invalid|otp/i.test(msg)) return "That code didn't work. It may have expired; ask for a new one.";
  if (/email/i.test(msg) && /valid/i.test(msg)) return 'Enter a valid email address.';
  return msg || 'Sign-in failed. Try again.';
}
