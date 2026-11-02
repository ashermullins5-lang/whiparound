// The free-games checker, run against a local stand-in for YouTube's channel /live pages.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const pages = {
  '/channel/UClivelivelivelivelive01/live':
    '<link rel="canonical" href="https://www.youtube.com/watch?v=LIVEVIDEO01"><script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"OK"},"videoDetails":{"videoId":"LIVEVIDEO01","title":"Grambling State vs. Northern Illinois","isLive":true}};var x=1;</script>',
  '/channel/UCsoonsoonsoonsoonsoon01/live':
    '<link rel="canonical" href="https://www.youtube.com/watch?v=SOONVIDEO01"><script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"LIVE_STREAM_OFFLINE"},"videoDetails":{"videoId":"SOONVIDEO01","title":"App State vs. Merrimack","isUpcoming":true}};var x=1;</script>',
  '/channel/UCoffoffoffoffoffoffoff1/live': '<link rel="canonical" href="https://www.youtube.com/channel/UCoffoffoffoffoffoffoff1">',
  '/channel/UCnoembednoembednoembed1/live':
    '<link rel="canonical" href="https://www.youtube.com/watch?v=NOEMBED0001"><script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"OK","playableInEmbed":false},"videoDetails":{"videoId":"NOEMBED0001","title":"A vs B","isLive":true}};var x=1;</script>',
  '/channel/UCblindblindblindblind01/live':
    '<title>YouTube</title><script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"LOGIN_REQUIRED","reason":"Sign in to confirm you’re not a bot"}};var x=1;</script>',
  '/channel/UCbotbotbotbotbotbotbo01/live':
    '<title>YouTube</title><link rel="canonical" href="https://www.youtube.com/watch?v=BOTVIDEO001"><script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"LOGIN_REQUIRED","reason":"Sign in to confirm you’re not a bot"},"videoDetails":{"videoId":"BOTVIDEO001"}};var x=1;</script>',
};
const api = {
  '/youtube/v3/playlistItems': { items: [{ contentDetails: { videoId: 'OLDVIDEO001' } }, { contentDetails: { videoId: 'APILIVE0001' } }] },
  '/youtube/v3/videos': {
    items: [
      { id: 'OLDVIDEO001', snippet: { title: 'Last week', liveBroadcastContent: 'none' }, status: { embeddable: true } },
      { id: 'APILIVE0001', snippet: { title: 'Grambling State vs. Northern Illinois', liveBroadcastContent: 'live' }, status: { embeddable: true } },
    ],
  },
};
const apiCalls = [];
const server = http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (api[path]) {
    apiCalls.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(api[path]));
  }
  if (pages[path]) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(pages[path]);
  }
  res.writeHead(500);
  res.end('boom');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.WHIP_YOUTUBE_ORIGIN = `http://127.0.0.1:${server.address().port}`;
process.env.WHIP_YOUTUBE_API_ORIGIN = `http://127.0.0.1:${server.address().port}`;
const { checkFreeNow } = createRequire(import.meta.url)('../dev-server.cjs');
after(() => server.close());

test('lists live and upcoming streams from official channels, skips the rest', async () => {
  const sources = [
    { id: 'live', name: 'Live Co', kind: 'youtube', youtubeChannelId: 'UClivelivelivelivelive01', sports: ['basketball'] },
    { id: 'soon', name: 'Soon Co', kind: 'youtube', youtubeChannelId: 'UCsoonsoonsoonsoonsoon01' },
    { id: 'off', name: 'Off Co', kind: 'youtube', youtubeChannelId: 'UCoffoffoffoffoffoffoff1' },
    { id: 'bot', name: 'Bot Co', kind: 'youtube', youtubeChannelId: 'UCbotbotbotbotbotbotbo01' },
    { id: 'broken', name: 'Broken Co', kind: 'youtube', youtubeChannelId: 'UCbrokenbrokenbrokenbro1' },
    { id: 'web', name: 'A website', kind: 'web', url: 'https://example.com' },
    { id: 'bad', name: 'No id', kind: 'youtube', youtubeChannelId: '' },
  ];
  const r = await checkFreeNow(sources, { gapMs: 0 });
  assert.equal(r.checked, 5, 'only YouTube entries with a channel id are checked');
  assert.deepEqual(
    r.live.map((x) => [x.sourceId, x.videoId, x.status, x.title]),
    [
      ['live', 'LIVEVIDEO01', 'live', 'Grambling State vs. Northern Illinois'],
      ['soon', 'SOONVIDEO01', 'upcoming', 'App State vs. Merrimack'],
      ['bot', 'BOTVIDEO001', 'onair', 'Bot Co live stream'],
    ]
  );
  assert.deepEqual(r.live[0].sports, ['basketball']);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].sourceId, 'broken');
  assert.ok(!Number.isNaN(Date.parse(r.updatedAt)));
});

test('streams that can only play on YouTube are marked; bot-checked channels keep a recent result', async () => {
  const sources = [
    { id: 'noembed', name: 'No Embed Co', kind: 'youtube', youtubeChannelId: 'UCnoembednoembednoembed1' },
    { id: 'blind', name: 'Blind Co', kind: 'youtube', youtubeChannelId: 'UCblindblindblindblind01' },
  ];
  const prev = {
    updatedAt: new Date(Date.now() - 10 * 60e3).toISOString(),
    live: [{ sourceId: 'blind', source: 'Blind Co', videoId: 'PREVVIDEO01', title: 'C vs D', status: 'live' }],
  };
  const r = await checkFreeNow(sources, { gapMs: 0, retryMs: 0, prev });
  const noembed = r.live.find((x) => x.sourceId === 'noembed');
  assert.equal(noembed.embeddable, false);
  assert.deepEqual(r.blocked, ['blind']);
  const carried = r.live.find((x) => x.sourceId === 'blind');
  assert.equal(carried.videoId, 'PREVVIDEO01');
  assert.equal(carried.carried, true);

  // An old previous result (over 45 minutes) is not carried forward.
  const old = await checkFreeNow(sources, { gapMs: 0, retryMs: 0, prev: { ...prev, updatedAt: new Date(Date.now() - 2 * 3600e3).toISOString() } });
  assert.equal(old.live.find((x) => x.sourceId === 'blind'), undefined);
});

test('with an API key, a bot-checked channel is checked through the YouTube Data API', async () => {
  apiCalls.length = 0;
  const r = await checkFreeNow([{ id: 'blind', name: 'Blind Co', kind: 'youtube', youtubeChannelId: 'UCblindblindblindblind01' }], { gapMs: 0, retryMs: 0, apiKey: 'test-key' });
  assert.deepEqual(r.blocked, []);
  assert.equal(r.live.length, 1);
  assert.equal(r.live[0].videoId, 'APILIVE0001');
  assert.equal(r.live[0].status, 'live');
  assert.equal(r.live[0].title, 'Grambling State vs. Northern Illinois');
  assert.ok(apiCalls[0].includes('playlistId=UUblindblindblindblind01'), 'reads the uploads playlist (cheap), not search');
  assert.ok(apiCalls.every((u) => u.includes('key=test-key')));
  assert.ok(!apiCalls.some((u) => u.includes('/search')));
});
