# Whiparound

A multiview for live sports. Watch up to nine streams at once, each with a live score bug, and let **Auto Whip** move the most exciting game to the big screen and give it the sound, the way a whip-around show does.

Whiparound plays streams you already have access to. It does not find or provide streams.

## Start it

You need [Node.js](https://nodejs.org) 18 or newer. No install step and no dependencies.

```bash
cd whiparound
node server.js
```

Open http://localhost:8080. To try it with simulated games first, open http://localhost:8080/?demo.

To watch on an iPad, iPhone, or a TV browser on the same Wi-Fi:

```bash
node server.js --lan
```

It prints an address like `http://192.168.1.20:8080`. Open that on the iPad, then tap Share → **Add to Home Screen** to get a full-screen app icon.

## Use it

1. **Add channels.** Click **Channels**. Paste a stream link, or import an M3U playlist (a link or a file).
2. **Pick games.** The right-hand panel shows today's games from ESPN's public scoreboard. Click a game: Whiparound suggests the channels that carry it, and you choose which tile it goes in. You can also drag a game onto a tile.
3. **Turn on Auto Whip.** It rates every live game on your tiles and moves the hottest one to the main tile with the sound.

| What | How |
| --- | --- |
| Sound on a tile | Click or tap it (yellow frame = has sound), or press `1`–`9` |
| Make a tile the main one | Its main button, or `Shift`+`1`–`9` |
| Watch one tile alone | Double-click it; double-click again (or `Esc`) to go back |
| Swap two tiles | Drag one onto the other |
| Layouts | Buttons in the top bar, or `L`: Single, Side by side, Main + 2, Quad, Main + 3, Nine |
| Auto Whip | `W` |
| Mute all | `M` |
| Full screen | `F` |

### What Auto Whip looks for

| Sport | Moments that rate high |
| --- | --- |
| Football | Red zone, goal to go, 4th down, two-minute drill, one-score game in the 4th, overtime |
| Basketball | Crunch time (last 5 minutes, within 5), close late, overtime |
| Baseball | Bases loaded, runner in scoring position, late and close, extra innings |
| Hockey | One-goal game in the 3rd, empty-net time, overtime, shootout |
| Soccer | Level or one-goal game after 75', stoppage time, extra time, penalties |

Any game that just scored gets a short boost. Blowouts are marked down. Settings let you choose how long Whip stays on a game before it may switch (default 25 seconds), whether it may swap hot games into your coldest tile, and whether you get alerts about hot games that aren't on screen.

## Where streams come from

| Source | Works? |
| --- | --- |
| **HLS links (`.m3u8`)** from an IPTV service, league pass, or your own server | Yes |
| **M3U playlists** from Channels DVR, Plex, Jellyfin, Emby, or an IPTV subscription | Yes: import the playlist, then search it |
| **MPEG-TS links (`.ts`, IPTV "live" URLs)** | Yes on desktop browsers, via mpegts.js. iPhone needs the HLS version |
| **MP4 / WebM files** | Yes |
| **YouTube and Twitch** (free official streams) | Yes: paste the link |
| **A YouTube channel's live stream** (`youtube.com/@channel/live`, `/channel/UC…`, `/c/name`, or links like `youtube.com/thefieldof68/live`) | Yes, with `server.js` running. The tile plays whatever the channel is streaming and moves to its next stream by itself. Without `server.js`, only `/channel/UC…` links work |
| **ESPN+, Peacock, Prime Video, Paramount+, YouTube TV, NFL Sunday Ticket, DAZN** | No. These are DRM-protected and only play in their own apps. Each game has buttons that open the right service |
| **HDHomeRun tuners directly** | Usually not: US broadcast TV is MPEG-2, which browsers can't decode. Put Channels DVR, Plex or Jellyfin in front of it; they convert it |

An antenna plus a DVR app is the cheapest way to get CBS, FOX, NBC and ABC, which carry most NFL games.

**Following a YouTube channel.** Paste a channel link instead of a single video. With `server.js` running, Whiparound checks the channel every minute, plays its current live video, and switches when the channel starts its next stream, which suits all-day events like a tournament or a season-opening marathon. When the stream title names both teams of a game on the scoreboard, the tile links that game, so the score overlay and Auto Whip follow along. If the channel isn't live, the tile says so and keeps checking.

**Tag your channels with a network.** When you add a link, fill in "Network it carries" (for example `CBS`). Whiparound then suggests that channel for every game on CBS. Channels whose names include both teams (common for IPTV event channels) are matched to the game automatically.

## Why run it with server.js

Many stream servers block web pages from loading their video (CORS). `server.js` serves the app and also relays those streams: when a direct load fails, Whiparound retries through the relay without you doing anything. It also rewrites HLS playlists so every segment goes through the relay.

You can host the folder on any static web host instead, but then:

- streams that block CORS won't play, and
- on an `https://` host, `http://` streams won't play at all (browsers block mixed content).

The relay has no password. By default it only listens on your own computer. `--lan` opens it to your home network, so don't use `--lan` on public Wi-Fi.

## Files

```
index.html            app shell and icons
css/app.css           all styles
js/app.js             controller: tiles, panel, Auto Whip, dialogs
js/player.js          one player per tile (native HLS, hls.js, mpegts.js, YouTube, Twitch, demo feed)
js/scores.js          ESPN scoreboard polling and normalizing
js/excitement.js      the heat rating behind Auto Whip
js/sources.js         link detection (incl. YouTube channel links), M3U parsing, matching channels to games
js/logos.js           team logos with dark-background versions and a letters fallback
js/leagues.js         followed leagues and official watch links
js/demo.js            simulated games for ?demo
js/storage.js         settings (localStorage) and channel library (IndexedDB)
server.js             static server, stream relay, YouTube channel live lookup
vendor/               hls.js 1.7.3 and mpegts.js 1.8.2 (Apache-2.0)
tests/                unit tests: npm test
```

Settings and channels are stored in the browser you use. Settings → **Export setup** moves them to another device.

## Notes

- Scores come from ESPN's public, undocumented scoreboard feed. It refreshes every 15 seconds during live games. If ESPN changes it, the panel shows "Can't reach scores" and the video keeps playing.
- Followed leagues by default: NFL, college football, NBA, men's college basketball, MLB, NHL, MLS, Premier League, Champions League. Add WNBA, women's college basketball, LaLiga, Bundesliga and Serie A in Settings.
- Small tiles automatically pull a lower bitrate; the main tile gets full quality.
- Team logos come from the same scoreboard feed. Whiparound uses the version made for dark backgrounds when ESPN has one, and shows the team's letters when a logo can't load.
- The YouTube channel lookup reads YouTube's public channel page. YouTube can change that page or ask some networks to sign in; if that happens, the tile says so, and you can paste the live video's own link instead.
- iPhone and iPad play HLS natively, with AirPlay and Picture in Picture buttons on each tile.
