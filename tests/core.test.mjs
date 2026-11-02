// Unit tests for the pure logic. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeEvent, statusText, situationText } from '../js/scores.js';
import { rateGame, scoringLabel } from '../js/excitement.js';
import { detectKind, parseM3U, matchSources, makeSource, youtubeId, twitchTarget, normName } from '../js/sources.js';
import { league, watchLinks } from '../js/leagues.js';

const nfl = JSON.parse(readFileSync(new URL('./fixtures/nfl-scoreboard.json', import.meta.url)));
const games = nfl.events.map((e) => normalizeEvent(e, league('nfl')));
const [kcDen, bufMia, dalPhi, gbChi] = games;

test('normalizes ESPN events', () => {
  assert.equal(kcDen.key, 'nfl:401772001');
  assert.equal(kcDen.state, 'in');
  assert.equal(kcDen.away.abbr, 'KC');
  assert.equal(kcDen.home.score, 20);
  assert.equal(kcDen.home.color, '#fb4f14');
  assert.deepEqual(kcDen.networks, ['CBS']);
  assert.equal(kcDen.situation.isRedZone, true);
  assert.equal(kcDen.situation.possession, 'away');
  assert.equal(statusText(kcDen), 'Q4 6:12');
  assert.equal(situationText(kcDen), '1st & 10 · DEN 12');
  assert.equal(gbChi.state, 'post');
  assert.equal(statusText(gbChi), 'Final');
  assert.deepEqual(dalPhi.networks, ['NBC', 'Peacock']);
});

test('red zone in a one-score 4th quarter rates blazing', () => {
  const r = rateGame(kcDen);
  assert.equal(r.reason, 'RED ZONE');
  assert.ok(r.score >= 70, `score ${r.score}`);
  assert.ok(rateGame(bufMia).score < 30);
  assert.equal(rateGame(dalPhi).score, 0);
  assert.equal(rateGame(gbChi).score, 0);
});

test('heat rules for other sports', () => {
  const nba = { state: 'in', kind: 'basketball', regPeriods: 4, period: 4, clock: 95, home: { score: 101 }, away: { score: 99 } };
  assert.equal(rateGame(nba).reason, 'CRUNCH TIME');
  const mlb = { state: 'in', kind: 'baseball', regPeriods: 9, period: 8, home: { score: 3 }, away: { score: 2 }, situation: { onFirst: true, onSecond: true, onThird: true, outs: 2, balls: 1, strikes: 1 } };
  assert.equal(rateGame(mlb).reason, 'BASES LOADED');
  assert.ok(rateGame(mlb).score >= 60);
  const nhl = { state: 'in', kind: 'hockey', regPeriods: 3, period: 3, clock: 90, home: { score: 2 }, away: { score: 1 } };
  assert.equal(rateGame(nhl).reason, 'EMPTY-NET TIME');
  const soc = { state: 'in', kind: 'soccer', regPeriods: 2, period: 2, displayClock: "90'+3'", home: { score: 1 }, away: { score: 1 } };
  assert.equal(rateGame(soc).reason, 'LEVEL LATE');
  const blowout = { state: 'in', kind: 'basketball', regPeriods: 4, period: 4, clock: 100, home: { score: 120 }, away: { score: 90 } };
  assert.ok(rateGame(blowout).score <= 10);
  assert.equal(scoringLabel('football', 7), 'TOUCHDOWN');
  assert.equal(scoringLabel('football', 3), 'FIELD GOAL');
  assert.equal(scoringLabel('basketball', 3), null);
});

test('detects link types', () => {
  assert.equal(detectKind('https://x.com/live/master.m3u8?token=1'), 'hls');
  assert.equal(detectKind('http://192.168.1.5:8089/devices/ANY/channels/5/stream.mpg'), 'auto');
  assert.equal(detectKind('http://iptv.example/live/user/pass/123.ts'), 'mpegts');
  assert.equal(detectKind('https://cdn.example/clip.mp4'), 'file');
  assert.equal(detectKind('https://example.com/manifest.mpd'), 'dash');
  assert.equal(detectKind('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'youtube');
  assert.equal(detectKind('https://youtu.be/dQw4w9WgXcQ'), 'youtube');
  assert.equal(detectKind('https://www.youtube.com/live/abcDEF12345'), 'youtube');
  assert.equal(youtubeId('https://www.youtube.com/live/abcDEF12345?si=x'), 'abcDEF12345');
  assert.equal(detectKind('https://www.twitch.tv/nfl'), 'twitch');
  assert.deepEqual(twitchTarget('https://www.twitch.tv/videos/12345'), { video: '12345' });
  assert.equal(detectKind('demo:football:KC@DEN:#e31837:#fb4f14'), 'demo');
});

test('parses extended M3U playlists', () => {
  const text = `#EXTM3U x-tvg-url="http://epg"
#EXTINF:-1 tvg-id="cbs.us" tvg-name="CBS" tvg-logo="http://logo/cbs.png" group-title="US, Locals",CBS (WCBS New York)
http://host/live/1.m3u8
#EXTINF:-1 tvg-logo="" group-title="Sports",ESPN HD
#EXTVLCOPT:http-user-agent=VLC
http://host/live/2.ts
#EXTINF:-1,NFL 05: Chiefs vs Broncos 8:15PM
#EXTGRP:NFL Events
http://host/live/3.m3u8
not-a-url
http://host/live/4.m3u8`;
  const list = parseM3U(text);
  assert.equal(list.length, 4);
  assert.equal(list[0].name, 'CBS (WCBS New York)');
  assert.equal(list[0].group, 'US, Locals');
  assert.equal(list[0].logo, 'http://logo/cbs.png');
  assert.equal(list[1].name, 'ESPN HD');
  assert.equal(list[1].url, 'http://host/live/2.ts');
  assert.equal(list[2].group, 'NFL Events');
  assert.equal(list[3].name, 'host · 4.m3u8');
});

test('matches channels to games', () => {
  const lib = [
    makeSource({ name: 'US: CBS HD', url: 'http://h/1.m3u8' }),
    makeSource({ name: 'ESPN2', url: 'http://h/2.m3u8' }),
    makeSource({ name: 'NFL 05: Chiefs vs Broncos', url: 'http://h/3.m3u8' }),
    makeSource({ name: 'Planets Channel', url: 'http://h/4.m3u8' }),
    makeSource({ name: 'My antenna', url: 'http://h/5.m3u8', network: 'CBS' }),
  ];
  const m = matchSources(kcDen, lib, {});
  assert.equal(m[0].source.name, 'NFL 05: Chiefs vs Broncos');
  assert.equal(m[0].why, 'Both teams in name');
  const names = m.map((x) => x.source.name);
  assert.ok(names.includes('US: CBS HD'));
  assert.ok(names.includes('My antenna'));
  assert.ok(!names.includes('ESPN2'));
  assert.ok(!names.includes('Planets Channel'));
  const remembered = matchSources(kcDen, lib, { gameStreams: { [kcDen.key]: lib[1].id } });
  assert.equal(remembered[0].source.name, 'ESPN2');
  assert.equal(normName('US: ESPN HD'), 'espn');
});

test('official watch links for networks', () => {
  const links = watchLinks(['ESPN', 'ABC', 'ESPN+']);
  assert.deepEqual(links.map((l) => l.label), ['ESPN', 'ABC']);
  assert.equal(watchLinks(['CBS'])[0].label, 'Paramount+');
});

// ---------- YouTube channel live links ----------
import { youtubeChannel } from '../js/sources.js';
import { darkVariant } from '../js/logos.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseYouTubeLive, channelLivePath } = require('../server.js');

test('recognizes YouTube channel live links', () => {
  const cases = {
    'https://www.youtube.com/thefieldof68/live': { name: 'thefieldof68', live: 'https://www.youtube.com/thefieldof68/live' },
    'https://www.youtube.com/@TheFieldOf68': { handle: '@TheFieldOf68', live: 'https://www.youtube.com/@TheFieldOf68/live' },
    'https://m.youtube.com/@nfl/streams': { handle: '@nfl', live: 'https://www.youtube.com/@nfl/live' },
    'https://www.youtube.com/channel/UCWJ2lWNubArHWmf3FIHbfcQ/live': { channelId: 'UCWJ2lWNubArHWmf3FIHbfcQ' },
    'https://www.youtube.com/c/ESPN/live': { name: 'ESPN' },
    'https://youtube.com/user/espn': { name: 'espn' },
    'https://www.youtube.com/@NBA/live?si=share': { handle: '@NBA' },
  };
  for (const [url, want] of Object.entries(cases)) {
    const got = youtubeChannel(url);
    assert.ok(got, url);
    for (const k of ['handle', 'name', 'channelId']) if (want[k]) assert.equal(got[k], want[k], url);
    if (want.live) assert.equal(got.liveUrl, want.live);
    assert.equal(detectKind(url), 'ytlive', url);
  }
  for (const url of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/live/abcDEF12345',
    'https://www.youtube.com/@NBA/videos',
    'https://www.youtube.com/results?search_query=nfl',
    'https://www.youtube.com/',
    'https://www.youtube.com.evil.example/@x/live',
    'https://notyoutube.com/@x/live',
  ]) {
    assert.equal(youtubeChannel(url), null, url);
  }
  assert.equal(detectKind('https://www.youtube.com/live/abcDEF12345'), 'youtube');
});

test('server only looks up youtube.com channel pages', () => {
  assert.equal(channelLivePath('https://www.youtube.com/@TheFieldOf68'), '/%40TheFieldOf68/live');
  assert.equal(channelLivePath('https://www.youtube.com/thefieldof68/live'), '/thefieldof68/live');
  assert.equal(channelLivePath('https://www.youtube.com/channel/UCWJ2lWNubArHWmf3FIHbfcQ'), '/channel/UCWJ2lWNubArHWmf3FIHbfcQ/live');
  assert.equal(channelLivePath('https://evil.example/@x/live'), null);
  assert.equal(channelLivePath('https://www.youtube.com.evil.example/@x'), null);
  assert.equal(channelLivePath('https://www.youtube.com/@x/videos'), null);
  assert.equal(channelLivePath('file:///etc/passwd'), null);
});

test('reads live, upcoming and offline channel pages', () => {
  const live = parseYouTubeLive(
    '<title>High Point vs. Liberty | Opening Day Marathon - YouTube</title><link rel="canonical" href="https://www.youtube.com/watch?v=AbCdEfGhIjK">' +
      '<meta itemprop="channelId" content="UCaaaaaaaaaaaaaaaaaaaaaa"><script>var x={"videoDetails":{"videoId":"AbCdEfGhIjK","isLive":true},"isLiveNow":true}</script>'
  );
  assert.deepEqual(live, { videoId: 'AbCdEfGhIjK', live: true, upcoming: false, channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa', title: 'High Point vs. Liberty | Opening Day Marathon' });

  const soon = parseYouTubeLive('<link rel="canonical" href="https://www.youtube.com/watch?v=ZZZZZZZZZZZ"><meta name="title" content="Game 2 &amp; more">"isLiveNow":false,"upcomingEventData":{"startTime":"1"}');
  assert.equal(soon.videoId, 'ZZZZZZZZZZZ');
  assert.equal(soon.live, false);
  assert.equal(soon.upcoming, true);
  assert.equal(soon.title, 'Game 2 & more');

  const ended = parseYouTubeLive('<link rel="canonical" href="https://www.youtube.com/watch?v=YYYYYYYYYYY">"isLiveNow":false');
  assert.equal(ended.live, false);
  assert.equal(ended.upcoming, false);

  const offline = parseYouTubeLive('<link rel="canonical" href="https://www.youtube.com/channel/UCbbbbbbbbbbbbbbbbbbbbbb"><meta property="og:title" content="The Field Of 68">');
  assert.equal(offline.videoId, null);
  assert.equal(offline.channelId, 'UCbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(offline.live, false);
});

test('a channel naming one team is not a match for both', () => {
  const lib = [makeSource({ name: 'Kansas City Chiefs Network', url: 'http://h/kc.m3u8' }), makeSource({ name: 'Chiefs vs Broncos', url: 'http://h/both.m3u8' })];
  const m = matchSources(kcDen, lib, {});
  assert.equal(m.find((x) => x.source.name.startsWith('Kansas')).why, 'Team in name');
  assert.equal(m.find((x) => x.source.name.startsWith('Chiefs vs')).why, 'Both teams in name');
});

test('logo URLs for dark backgrounds', () => {
  assert.equal(darkVariant('https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/kc.png'), 'https://a.espncdn.com/i/teamlogos/nfl/500-dark/kc.png');
  assert.equal(darkVariant('https://a.espncdn.com/i/teamlogos/soccer/500/359.png'), 'https://a.espncdn.com/i/teamlogos/soccer/500-dark/359.png');
  assert.equal(darkVariant('https://example.com/logo.png'), null);
  assert.equal(kcDen.away.logo, 'https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/kc.png');
});

test('reads realistic YouTube page data and avoids look-alike matches', () => {
  const pr = (o) => `<script>var ytInitialPlayerResponse = ${JSON.stringify(o)};var meta = {};</script>`;
  // Live watch page served at /live
  const live = parseYouTubeLive(
    '<link rel="canonical" href="https://www.youtube.com/watch?v=LIVEVIDEO01">' +
      pr({
        playabilityStatus: { status: 'OK' },
        videoDetails: { videoId: 'LIVEVIDEO01', title: 'Grambling State vs. Northern Illinois "Live"', channelId: 'UCchannelchannelchannel1', isLive: true },
        microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: true, startTimestamp: '2026-11-02T08:00:00Z' } } },
      })
  );
  assert.equal(live.videoId, 'LIVEVIDEO01');
  assert.equal(live.live, true);
  assert.equal(live.channelId, 'UCchannelchannelchannel1');
  assert.equal(live.title, 'Grambling State vs. Northern Illinois "Live"');
  // Waiting room for the next stream: the page may still say "isLive":true
  const waiting = parseYouTubeLive(
    '<link rel="canonical" href="https://www.youtube.com/watch?v=NEXTVIDEO01">' +
      pr({ playabilityStatus: { status: 'LIVE_STREAM_OFFLINE' }, videoDetails: { videoId: 'NEXTVIDEO01', isLive: true, isUpcoming: true } })
  );
  assert.equal(waiting.live, false);
  assert.equal(waiting.upcoming, true);
  // A stream that already ended
  const ended = parseYouTubeLive(
    '<link rel="canonical" href="https://www.youtube.com/watch?v=OLDVIDEO001">' +
      pr({ playabilityStatus: { status: 'OK' }, videoDetails: { videoId: 'OLDVIDEO001', isLiveContent: true }, microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: false, endTimestamp: '2026-11-02T03:00:00Z' } } } })
  );
  assert.equal(ended.live, false);
  assert.equal(ended.upcoming, false);
  // Offline channel page that features OTHER channels' live videos: must not count as live
  const offline = parseYouTubeLive(
    '<link rel="canonical" href="https://www.youtube.com/channel/UCownownownownownownown1"><meta property="og:url" content="https://www.youtube.com/channel/UCownownownownownownown1">' +
      '<script>var ytInitialData = {"metadata":{"channelMetadataRenderer":{"externalId":"UCownownownownownownown1","title":"Own"}},"contents":{"x":[{"videoId":"OTHERVIDEO1","channelId":"UCotherotherotherother01","isLive":true}]}};</script>'
  );
  assert.equal(offline.videoId, null);
  assert.equal(offline.live, false);
  assert.equal(offline.channelId, 'UCownownownownownownown1');
  // Consent interstitial
  assert.deepEqual(parseYouTubeLive('<title>Before you continue to YouTube</title><form action="https://consent.youtube.com/save">'), { consent: true });
  // Bot check: report it, keep the id so the browser embed can still try
  const blocked = parseYouTubeLive('<link rel="canonical" href="https://www.youtube.com/watch?v=BLOCKVIDEO1">' + pr({ playabilityStatus: { status: 'LOGIN_REQUIRED' }, videoDetails: { videoId: 'BLOCKVIDEO1', isLive: true } }));
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.live, true);
  // YouTube's own channel-live embed link is understood as a channel link
  assert.equal(youtubeChannel('https://www.youtube.com/embed/live_stream?channel=UCownownownownownownown1').channelId, 'UCownownownownownownown1');
  assert.equal(detectKind('https://www.youtube.com/embed/live_stream?channel=UCownownownownownownown1'), 'ytlive');
});
