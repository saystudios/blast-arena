# Ben Zone

A colorful, cartoon-style 3D arena blaster for iPhone, iPad and desktop. Original game by Say Studios LLC.

**Current build: Phase 3 + weapon pack 2 — online multiplayer (quick match, private rooms, friends, rankings) plus everything from Phase 2 offline vs bots.**

## What's in the game

**Modes:** 1v1 Duel (first to 5), Free-for-All (6 players, first to 12), 2v2 / 3v3 / 5v5 Team (Blue vs Orange, first team to 10 / 15 / 25), Target Practice (60 s, all 8 weapons). Matches run 3–5 minutes with quick respawns and a Rematch button.

**Weapons** (pick two in **Loadout**; Practice gives you all 14). Everyone starts with **150 health**:

| Weapon | Type | Feel |
|---|---|---|
| Laser Blaster | Instant beam | Accurate all-rounder, 16 shots |
| Scatter Blaster | Instant spread | 8 darts close range, 4 shots |
| Foam Dart Blaster | Projectile | Fast darts with slight drop, 10 shots |
| Paintball Launcher | Lobbed projectile | Splash damage, paint splats on walls |
| Precision Blaster | Instant beam | Scope zoom, 2× headshots, 5 shots |
| Rapid-Fire Blaster | Instant beam | 40-shot mag, fast fire |
| Rocket Launcher | Projectile | Big splash, knockback, rocket jumps |
| Energy Bow | Charged projectile | Hold to draw, release; stronger and faster at full charge |
| Burst Blaster | Instant beam | 3-shot bursts per trigger pull, mid range |
| Frost Beam | Instant beam | Each hit slows the target to half speed for 1.4 s |
| Bounce Bomb | Bouncing projectile | Ricochets off floors and walls up to 3 times, explodes on contact or after 1.6 s |
| Bubble Blaster | Projectile stream | Fast stream of floating bubbles, short range |
| Spin Blaster | Instant beam | Fire rate ramps up over 1 s while held; you move slower while spinning |
| Rail Charger | Charged beam | Hold to charge, release; passes through every enemy in a line |

Each has its own damage, range falloff, spread, aim spread, recoil, fire rate, mag size, reload time, tracer/projectile look and sound. Bigger hitters are slower, so nothing dominates.

**Arenas:**
- **Neon City**: night rooftops, two raised buildings, a bridge you can fight on and under, side towers, glowing signs, skyline.
- **Candy Factory**: two conveyor belts that carry you, a central mixer tower, catwalks along both walls, gumdrops, lollipop trees, candy-cane pillars.
- **Sky Islands**: floating islands joined by bridges, jump pads to high corner platforms. Fall off and you're out; whoever knocked you off within 6 seconds gets the point.
- **Training Yard**: the Phase 1 block arena, also the practice range.

**Locker (character editor):** 6 skin tones, 6 hair/headgear styles (spiky, buzz, mohawk, cap, helmet, beanie), 6 hair colors, 9 shirt colors, 6 pants colors, gear (goggles, headphones, jetpack, bandana), 3 saved outfit slots, Random, a Wave emote and a spinning preview. Bots get random outfits.

**Bots** look like **skinwalkers** by default: tall, hunched gray creatures with a bone skull, antlers, glowing red eyes and a fur mantle (spooky, no gore). They growl when they spot you. Settings → *Skinwalker bots* switches back to cartoon bots. Each match mixes these types (same health and hitbox, slightly different play):

| Type | Look | Plays |
|---|---|---|
| Stag Walker | Antlers, red eyes, fur cape | The all-rounder |
| Wolf Walker | Pointed ears, long snout, yellow eyes, shaggy fur | 18% faster, rushes in close |
| Crow Walker | Black feathers, beak, crest, purple eyes | Jumps a lot, harder to hit |
| Pale Walker | See-through ghostly white, head spikes, cyan eyes | Slightly faster, keeps distance |
| Ram Walker | Curled horns, wool, orange eyes | Charges in close |
| Bog Walker | Mossy green, mossy antlers, green eyes | Slower, but aims better |

Bots also pathfind across stairs, bridges and catwalks; avoid walking off island edges; lead moving targets with projectile weapons and arc for drop; aim rockets at feet; charge the bow; keep each weapon's best range; fight only enemies in team modes.

**Also:** movement (sprint, double jump, slide, dash, crouch, air control that keeps momentum), health regen, spawn shields, team-side spawns, teammate markers visible through walls, colorblind enemy outlines, hit markers, damage numbers, kill feed, touch / keyboard + mouse / controller, saved settings and stats.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Rendering | **Three.js (WebGL)** | Runs in every browser and inside an iOS app; small download; fast loading; stylized low-poly art keeps 60 FPS on recent iPhones/iPads. |
| Game rules | `src/core.js`, plain JS, no engine dependency | The same file runs in the browser and on the server, so damage and hit detection can't drift apart. |
| Multiplayer | **Own Node.js server, zero dependencies** (`server/`) | Built-in WebSocket, rooms, matchmaking, ratings and persistence in ~1,100 lines. Nothing to `npm install`, one process serves the game and the multiplayer. |
| iOS / iPadOS | **Capacitor** wrapper → Xcode → TestFlight | Same workflow as Little Days. |
| Desktop | Browser, or the same web build wrapped later (Tauri/Electron) | No separate codebase. |
| Accounts, leaderboards, match history | Stored by the game server in `data/db.json` | Simple to run. Move to Supabase or Postgres when you outgrow one server. |

**Trade-off to know about:** Unity with Photon Fusion would give more performance headroom for very large maps or realistic graphics, but needs the Unity editor, a C# rewrite, and a bigger app. For a bright cartoon arena shooter with 2–10 players, the web stack hits the targets and keeps one codebase for iPhone, iPad and desktop.

## Project structure

```
blast-arena/
├── index.html          Screens, HUD, touch controls, styles
├── src/
│   ├── core.js         Rules: weapons, damage, splash, ray tests, collision, bot navigation, spawns, team scoring (shared with server)
│   ├── maps.js         The four arenas as data + build functions
│   ├── characters.js   Original cartoon character builder and outfit options
│   ├── online.js       Online client: connection, sign-in token, lobby/room/friends screens
│   └── game.js         Client: renderer, effects, player, projectiles, bots, input, HUD, Loadout, Locker, online match play
├── server/
│   ├── index.js        HTTP + WebSocket server (serves the game and /ws on one port)
│   ├── ws.js           Minimal WebSocket implementation (RFC 6455)
│   ├── lobby.js        Accounts, quick match, private rooms, friends, ratings, history, reports, persistence
│   ├── match.js        Authoritative match: validation, lag-compensated hits, projectiles, scoring
│   └── maps-node.js    Builds map collision on the server from src/maps.js
├── tests/
│   ├── core.test.js    Unit tests for core.js
│   ├── server.test.js  Multiplayer server tests over real WebSockets
│   ├── online-e2e.js   Browser joins a real server, plays, gets hit, respawns, rematches, leaves
│   ├── smoke.js        Offline playthrough: all maps, modes and weapons
│   └── three-stub.js   Lightweight Three.js stand-in used by the browser tests
├── Dockerfile          For hosting the server
├── package.json
└── README.md
```

**Add a weapon:** add an entry to `WEAPONS` and `WEAPON_ORDER` in `src/core.js`, then a case in `buildViewmodel()` in `src/game.js`.
**Add a map:** add an entry to `BA.MAPS` and `BA.MAP_ORDER` in `src/maps.js`. Its `build(ctx)` places boxes and returns spawns tagged `blue`/`orange`; the bot walk graph is built automatically.

## Play and test locally

Needs Node.js 22 or newer. No `npm install`.

```bash
cd blast-arena
npm start                # game + multiplayer server on http://localhost:8080
```

Open `http://localhost:8080` in two browser windows (or a phone and a computer on the same Wi-Fi using `http://<your-computer's-LAN-IP>:8080`), tap **Play Online** in both, create a room in one and join with the code in the other.

```bash
npm test                 # 19 rules tests + 30 server tests over real WebSockets
npm i -D playwright && npx playwright install chromium
npm run smoke            # offline: all 4 maps, 3v3 and 5v5 with bots, all 14 weapons, Loadout, Locker, server/client map match
npm run e2e              # online: a browser joins a real server and plays a full match
```

### Controls

| Action | Keyboard/mouse | Touch | Controller |
|---|---|---|---|
| Move | WASD / arrows | Left thumb (floating stick) | Left stick |
| Look | Mouse | Drag right side / drag from FIRE | Right stick |
| Fire (hold to charge bow/rail) | Left click | FIRE (either side) | RT |
| Aim / scope | Right click (hold) | AIM (toggle) | LT |
| Sprint | Shift | Push stick fully | L3 / full stick |
| Jump / double jump | Space | JUMP | A |
| Crouch / slide | C or Ctrl | SLIDE | B |
| Dash | Q or E | DASH | LB / RB |
| Reload | R | ↻ | X |
| Swap weapon | 1–9, 0, mouse wheel | SWAP | Y |
| Pause | P / Esc | ❚❚ | Start |

## GitHub setup

```bash
cd blast-arena
git init -b main
git add . && git commit -m "Ben Zone: initial import"
gh repo create saystudios/blast-arena --private --source . --push
```

Work after this lands as pull requests into `main`.

## Online play (Phase 3)

### What players get
- **Play Online** button on the main menu. Players get a generated name like *SwiftFalcon42* (tap **New name** to reroll), a 6-letter friend code and a rating that starts at 1000. No email, password or personal info.
- **Quick match** for 1v1, Free-for-All, 2v2, 3v3 and 5v5. Ranked: ratings go up and down (Elo). Starts when full, or after 20 s with at least 2 players (team modes). Arenas rotate between Neon City, Candy Factory and Sky Islands.
- **Private rooms** with a 5-letter code. The host picks mode and arena (Training Yard too) and starts when 2+ players are in. Unranked.
- **Friends**: add by friend code; you become friends when both add each other. Invite online friends straight into your room; they get a Join button.
- **Teams** are balanced automatically (quick match shuffles; private rooms alternate by join order).
- **Leaderboard** (top 20) and **My matches** (last 15 results with rating change).
- **Rematch voting** after every match (20 s). Private rooms go back to the room screen; quick-match groups split up if the vote fails.
- **Reconnection**: if the connection drops (tunnel, app in background), the game reconnects and puts you back in the same match. Your slot is held for 60 s.
- **Quick chat**: 6 preset phrases only (V key or CHAT button). Can be turned off in Settings.
- **Report and Block** on the room screen and the results screen. Reports use fixed reasons and are stored in `data/db.json` under `reports` for you to review. Blocked players are never matched with you and can't invite you.
- **Settings**: Online quick chat on/off, Allow friend invites on/off, Server address (under Play Online).

### How it stays fair
- **The server owns all damage.** Clients send where they aimed; the server re-traces every shot.
- **Lag compensation**: hitscan shots are checked against where targets were when the shooter saw them (up to 250 ms back), so aiming feels right on mobile connections.
- **Same spread on both sides**: each shot carries a random seed, so shotgun pellets and projectile spread land identically on the server and in your view.
- **Projectiles** (darts, paintballs, rockets, arrows) are simulated on the server; splash damage and knockback come from the server.
- **Cheat checks**: impossible speed or flying gets snapped back; walking into walls is refused; shots faster than the weapon allows, with empty ammo, during reload, or from somewhere you're not standing are rejected; repeated violations remove the player from the match. Message rate and size are capped.
- **Movement** stays smooth because your own movement runs on your device and the server only checks it. Other players are shown 100 ms behind, smoothly interpolated.

### Put the server online
The server is one Node.js process with no dependencies. It serves the game at `/` and multiplayer at `/ws`. It needs a host that keeps a process running and supports WebSockets, plus a small persistent disk for `data/`. Static-only hosts (GitHub Pages, Cloudflare Pages) can host the game files but not the server.

**Option A: Fly.io (Docker)**
```bash
brew install flyctl           # or see fly.io/docs
fly auth login
fly launch --no-deploy        # pick a name, e.g. blast-arena; it finds the Dockerfile
fly volumes create data --size 1
# add to fly.toml:
#   [mounts]
#     source = "data"
#     destination = "/data"
fly secrets set ALLOWED_ORIGINS="https://blast-arena.fly.dev,capacitor://localhost"
fly deploy
```

**Option B: Railway or Render (no Docker needed)**
- Start command: `node server/index.js`
- Add a persistent volume/disk mounted at `/data` and set `DATA_DIR=/data`.
- Set `ALLOWED_ORIGINS` to your game's address(es).

Check pricing on whichever host you pick; a single small instance is enough to start. One server process comfortably handles dozens of simultaneous matches; scale out later by running more instances behind a matchmaker.

**After deploying:** open `https://<your-app>/` and play online. Visiting `/health` shows `{ ok, players, rooms, matches }`.

**Environment variables**

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 8080 | Port to listen on (hosts usually set this) |
| `DATA_DIR` | `./data` | Where players, ratings, history and reports are saved |
| `ALLOWED_ORIGINS` | any | Comma-separated list of sites allowed to connect. Set it in production. |

**Note on the Claude preview page:** that page can't connect to outside servers, so it always plays offline. Online play works from your server's address and from the iOS app.

## iOS build (Capacitor)

Requires a Mac with Xcode and an Apple Developer account.

```bash
npm i @capacitor/core @capacitor/cli @capacitor/ios
npx cap init "Ben Zone" com.saystudios.benzone --web-dir www
# copy index.html and src/ into www/ (Phase 5 adds a build step that does this)
# set <meta name="blast-server" content="your-app.fly.dev"> in www/index.html so the app knows your server
npx cap add ios
npx cap sync ios
npx cap open ios
```

Before an App Store build, bundle these locally instead of loading from the internet:
- `three.min.js` (currently from cdnjs)
- The Russo One and Exo 2 fonts (currently from Google Fonts)

Add `capacitor://localhost` to `ALLOWED_ORIGINS` on the server so the app can connect.

In Xcode: set the team, lock orientation to landscape, enable "Requires full screen", set the display name and icons.

## TestFlight workflow

1. Bump the version and build number in Xcode (General tab).
2. Product → Archive (with "Any iOS Device" selected).
3. In the Organizer: Distribute App → App Store Connect → Upload.
4. In App Store Connect → TestFlight: add the build to an internal testing group (up to 100 people, no review), or submit for external beta review.
5. Testers install through the TestFlight app.

## Temporary assets to replace

| Asset | Now | Replace with |
|---|---|---|
| Characters | Built from primitive shapes in code | Rigged cartoon character models (glTF) with run/jump/slide animations |
| Weapons | Box/cylinder models | Modeled blaster meshes per weapon + skins |
| Sounds | Synthesized in the browser | Recorded/licensed SFX, victory music, background music |
| Arena | Colored blocks | Themed props and textures per map |
| Fonts, Three.js | Loaded from CDNs | Bundled files for the iOS build |

## Roadmap

- ~~**Phase 1**: playable arena, two weapons, movement, bots.~~
- ~~**Phase 2**: all 8 weapons, Neon City / Candy Factory / Sky Islands, team modes (2v2, 3v3, 5v5), Locker.~~
- ~~**Phase 3**: online multiplayer: quick match, private rooms, friends and invites, team balancing, rankings, match history, rematch voting, reconnection, server-side hits with lag compensation, cheat checks, report/block, quick chat.~~
- **Phase 4**: XP, coins, daily challenges, cosmetic shop (cosmetic only, nothing paid is stronger), weapon skins, victory dances, more emotes, music. Optional: server bots to fill empty quick-match slots.
- **Phase 5**: Robot Factory (moving machinery), Water Park (slides, pools), Space Station (low-gravity zones; `lowGravity` flag already supported), iPhone/iPad performance pass, Sign in with Apple to keep progress across devices, TestFlight.

© Say Studios LLC
