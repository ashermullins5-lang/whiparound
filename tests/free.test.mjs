// The free-games checker, run against a local stand-in for YouTube's channel /live pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const pages = {
  '/channel/UClivelivelivelivelive01/live':
    '<link rel="canonical" href="https://www.youtube.com/watch?v=LIVEVIDEO01"><script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"OK"},"videoDetails":{"videoId":"LIVEVIDEO01","title":"Grambling State vs. Northern Illinois","isLive":true}};var x=1;</script>',
  '/channel/UCsoonsoonsoonsoonsoon01/live':
    '<link rel="canonical" href="https://www.youtube.com/watch?v=SOONVIDEO01"><script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"LIVE_STREAM_OFFLINE"},"videoDetails":{"videoId":"SOONVIDEO01","title":"App State vs. Merrimack","isUpcoming":true}};var x=1;</script>',
  '/channel/UCoffoffoffoffoffoffoff1/live': '<link rel="canonical" href="https://www.youtube.com/channel/UCoffoffoffoffoffoffoff1">',
};
const server = http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (pages[path]) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(pages[path]);
  }
  res.writeHead(500);
  res.end('boom');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.WHIP_YOUTUBE_ORIGIN = `http://127.0.0.1:${server.address().port}`;
const { checkFreeNow } = createRequire(import.meta.url)('../dev-server.cjs');

test('lists live and upcoming streams from official channels, skips the rest', async () => {
  const sources = [
    { id: 'live', name: 'Live Co', kind: 'youtube', youtubeChannelId: 'UClivelivelivelivelive01', sports: ['basketball'] },
    { id: 'soon', name: 'Soon Co', kind: 'youtube', youtubeChannelId: 'UCsoonsoonsoonsoonsoon01' },
    { id: 'off', name: 'Off Co', kind: 'youtube', youtubeChannelId: 'UCoffoffoffoffoffoffoff1' },
    { id: 'broken', name: 'Broken Co', kind: 'youtube', youtubeChannelId: 'UCbrokenbrokenbrokenbro1' },
    { id: 'web', name: 'A website', kind: 'web', url: 'https://example.com' },
    { id: 'bad', name: 'No id', kind: 'youtube', youtubeChannelId: '' },
  ];
  const r = await checkFreeNow(sources, { gapMs: 0 });
  assert.equal(r.checked, 4, 'only YouTube entries with a channel id are checked');
  assert.deepEqual(
    r.live.map((x) => [x.sourceId, x.videoId, x.status, x.title]),
    [
      ['live', 'LIVEVIDEO01', 'live', 'Grambling State vs. Northern Illinois'],
      ['soon', 'SOONVIDEO01', 'upcoming', 'App State vs. Merrimack'],
    ]
  );
  assert.deepEqual(r.live[0].sports, ['basketball']);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].sourceId, 'broken');
  assert.ok(!Number.isNaN(Date.parse(r.updatedAt)));
  server.close();
});
