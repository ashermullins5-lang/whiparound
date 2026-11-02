// Team logos, loaded from the URLs the scoreboard feed provides.
// ESPN publishes a version of most logos drawn for dark backgrounds ("500-dark"); we try that
// first, then the regular logo, and fall back to the team's letters when neither loads.
// Each logo is probed once; results are remembered so re-renders never re-request a 404.

const cache = new Map(); // feed logo URL -> { status: 'pending' | 'ok' | 'none', url, dark }
let listener = null;
let timer = 0;

/** Called (debounced) whenever newly loaded logos are ready to render. */
export function onLogosReady(fn) {
  listener = fn;
}

export function darkVariant(url) {
  // https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/kc.png -> https://a.espncdn.com/i/teamlogos/nfl/500-dark/kc.png
  const m = /^(https:\/\/a\.espncdn\.com\/i\/teamlogos\/[a-z0-9-]+)\/500\/(?:scoreboard\/)?([\w.-]+\.png)$/i.exec(url || '');
  return m ? `${m[1]}/500-dark/${m[2]}` : null;
}

function probe(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.decoding = 'async';
    const done = (ok) => {
      img.onload = img.onerror = null;
      resolve(ok);
    };
    img.onload = () => done(img.naturalWidth > 0);
    img.onerror = () => done(false);
    setTimeout(() => done(false), 8000);
    img.src = src;
  });
}

function announce() {
  clearTimeout(timer);
  timer = setTimeout(() => listener?.(), 60);
}

/** The logo to show for a team right now, or null (show letters). Starts loading on first ask. */
export function logoFor(team) {
  const base = team?.logo;
  if (!base || !/^https:\/\//i.test(base)) return null;
  const hit = cache.get(base);
  if (hit) return hit.status === 'ok' ? hit : null;
  cache.set(base, { status: 'pending' });
  (async () => {
    for (const url of [darkVariant(base), base].filter(Boolean)) {
      if (await probe(url)) {
        cache.set(base, { status: 'ok', url, dark: url !== base });
        return announce();
      }
    }
    cache.set(base, { status: 'none' });
  })();
  return null;
}
