# 🐱 Prismoo · Cross-Platform Desktop Pet

> **English** | [中文](./README.md)

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-1.97-000000?logo=rust&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-8A2BE2)
![Size](https://img.shields.io/badge/installer-8.6%20MB-2ea44f)

![prismoo brand](./docs/prismoo-brand.png)

> A transparent, always-on-top desktop pet built with **Tauri 2 + Rust + TypeScript + HTML5 Canvas** (MVP).
> Supports Windows / macOS / Linux — pixel-art sprite animation, drag-and-walk, sleeping, click interactions, and OpenAI-compatible AI chat.

![pet cat preview](./docs/screenshots/pet-cat-en.png)
![settings panel](./docs/screenshots/settings-panel-en.png)

## 📥 Download

End users should download the latest `Prismoo_x.y.z_x64-setup.exe` installer (~2 MB) from
[GitHub Releases](https://github.com/Aceeee2077/Desk-Petrick/releases/latest).

You can also build it yourself — see "Packaging & Distribution"; one `npx tauri build` produces the installer.

---

## ✨ Features

| Feature | Description |
| :--- | :--- |
| 🪟 Transparent always-on-top window | 300×300, frameless, always on top, hidden from taskbar, draggable |
| 🌐 Chinese/English switch | One-click UI language toggle in Settings (中文 / English); speech lines and bubbles follow |
| 🐱 Animated pixel pets | Gray cat / fox / rabbit / Bulu / robot, with real per-frame limb, tail and ear animation across four states |
| 🐾 Photo pet | Upload your own pet photo → automatic background removal → it becomes the desktop pet, with whole-image actions (dance / stretch / tilt…) |
| 👀 Eye tracking | The robot has procedural eye tracking; mark the two eyes on a photo pet to enable tracking, blinking and sleep closure |
| 🎞️ Four animation states | `idle` (breathing + blinking + tail wag) · `walking` (alternating limb steps) · `sleeping` · `click` (jump) |
| 💬 Click dialogue | Single-click plays a jump animation + random speech bubble (customizable) |
| 🤖 AI chat | Double-click opens a ChatGPT-style chat window with a conversation list (new chat / archive / rename / delete); works with any OpenAI-compatible API (OpenAI / DeepSeek / …); history stays on your machine |
| ⚙️ Settings panel | Skin / animation speed / opacity / auto-launch / sound / AI config / reset position |
| 🎵 Click sound | Short synthesized "meow" via Web Audio (toggleable) |
| ❤️ Affinity | Clicking / dragging / chatting raise your bond through 5 levels (Stranger → Best Friend); hearts shown on a corner badge |
| ⏰ Focus Mode | On by default: reminds you to "Stand up and stretch, boss!" every 40 minutes (configurable 20–90), with a chime and a jump; text follows the UI language |
| ☀️🌙 Theme switch | Light (orange-white gradient) / Dark (original purple) — the pet bubble, chat window and settings panel switch together |
| 🎩 Accessories | Procedural pixel hat / scarf / glasses for the robot skin |
| 🕺 Idle actions | The pet randomly yawns, stretches, scratches and dances while idle — it feels alive |
| 🚶 Auto wander | The pet walks / runs / jumps around your desktop on its own (not just when dragged); stays awake instead of sleeping while on (toggleable) |
| 📊 Interaction stats | Days together, click / chat counts and an affinity growth curve (chart in Settings) |
| 💬 Proactive chat | After 10 idle minutes the pet says hi on its own (toggleable) |
| ☁️ Weather | Clicking the pet sometimes reports today's weather (free APIs, fetched from Rust, toggleable) |
| ⏰ Hourly chime | The pet jumps and announces each hour (toggleable) |
| 📍 Position memory | Remembers its position and returns there on restart |
| 🔄 Auto-update | ⏳ Not wired up yet: the Tauri build is still mid-migration, so this installer does not self-update |

**Quick interactions**

| Action | Effect |
| :--- | :--- |
| Left-drag | The pet follows the cursor and plays its walking animation (affinity +1) |
| Single click | Jump animation + random line + sound (affinity +1; level-ups are announced) |
| Double click | Opens the ChatGPT-style AI chat window (or the settings panel if AI is disabled; each chat reply grants affinity +2) |
| Right-click / tray icon | Settings / AI chat / reset position / quit |
| `Ctrl + Shift + P` | Open the settings panel |
| `Esc` | In the chat window: close it; on the pet window: quit the app |
| No mouse/keyboard for 30s | The pet falls asleep (floating Zzz); any input wakes it |

---

## 🚀 Quick Start

### Requirements

- **Node.js ≥ 18** (20+ recommended) and npm
- **Rust toolchain**: install the stable channel via [rustup](https://rustup.rs/)
- **Windows**: Visual Studio Build Tools (with "Desktop development with C++") + the WebView2 runtime (bundled with Windows 11, usually present on Windows 10 too)
- **macOS**: Xcode Command Line Tools
- **Linux**: `webkit2gtk` / `libayatana-appindicator` etc. — see [Tauri prerequisites](https://tauri.app/start/prerequisites/)

### Install & Run

```bash
# 1. Install dependencies
npm install

# 2. Build the front end (sprites + TypeScript + assets into dist/)
npm run build

# 3. Compile and launch the debug build
npm run tauri:build
./src-tauri/target/debug/prismoo.exe
```

A pixel kitten will appear at the center of your screen. Try dragging it, clicking it, double-clicking it, and pressing `Ctrl + Shift + P` to open settings.

> 💡 **Debug vs release**
> `npm run tauri:build` produces a debug binary that keeps a console window — that's where `println!`,
> panics and the `npm run tauri:check` report go. Use `npm run tauri:build:release` for a console-free
> build at `src-tauri/target/release/prismoo.exe`.

> 💡 **Windows note (PowerShell execution policy)**
> If you see `npm.ps1 cannot be loaded because running scripts is disabled`, either:
>
> ```powershell
> # Option A: use the .cmd variant (no settings changes needed)
> npm.cmd run build
>
> # Option B: allow script execution for the current user (recommended, one-time)
> Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
> npm run build
> ```
>
> 💡 **Slow or timing-out crates.io downloads**
> This project ships a machine-local mirror config at `src-tauri/.cargo/config.toml` (rsproxy).
> It is git-ignored, so CI and other machines keep using the default source; delete the file to revert.

### Useful Scripts

| Command | Description |
| :--- | :--- |
| `npm run build` | Front-end build: sprites / icons / TypeScript / assets / `src-tauri/resources/i18n.json` |
| `npm run tauri:build` | Compile the Tauri debug build (`src-tauri/target/debug/prismoo.exe`) |
| `npm run tauri:build:release` | Compile the Tauri release build (no console window) |
| `npm run tauri:check` | Compile and run the three-phase self-check (pet render / settings read-write / chat CRUD); exit code 0 = pass |
| `npm test` | Run the Rust unit tests (config merging, default back-filling, …) |
| `npx tauri build` | Package the installer (NSIS on Windows) into `src-tauri/target/release/bundle/` |
| `npm run sprites` | Regenerate the pixel sprites and icons only (`scripts/generate-sprites.mjs`) |
| `npm run brand-icons` | Regenerate the brand icons (`icon.png` / `ico` / `icns` / `tray.png`) |

---

## 📦 Packaging & Distribution

Uses [Tauri 2](https://tauri.app/); see `src-tauri/tauri.conf.json`:

- **Windows**: `.exe` (NSIS installer, custom install directory, desktop and Start-menu shortcuts)
- **macOS**: `.dmg` / `.app`
- **Linux**: `.AppImage` / `.deb`

```bash
npm run build       # build the front end (npx tauri build does this automatically too)
npx tauri build     # package the current platform
```

Artifacts land in `src-tauri/target/release/bundle/`:

```
src-tauri/target/release/bundle/nsis/Prismoo_0.5.1_x64-setup.exe
```

For reference: the installer is about **2.05 MB** and the executable about **4.84 MB**
(the Electron build was 140 MB / 188 MB).

> ⚠️ Platform notes:
> - Tauri uses the system WebView (WebView2 on Windows), so **no browser engine is bundled** —
>   that is where the size reduction comes from.
> - Cross-platform packaging requires the target platform; use per-platform runners in CI
>   (GitHub Actions) for release builds.
> - A production macOS release needs an Apple Developer certificate and notarization; unsigned
>   builds are fine for personal use.
> - Windows SmartScreen may warn "Unknown publisher" on first launch — click
>   "More info → Run anyway" (configure code-signing for official distribution).
> - If target machines may lack WebView2, switch `bundle.windows.webviewInstallMode` in
>   `tauri.conf.json` to an offline/embedded installer.

### 🔄 Auto-update

> ⏳ **In progress**: the Tauri build has not been wired to `tauri-plugin-updater` yet, so this
> installer does **not** self-update. Until then, download the new installer from
> [GitHub Releases](https://github.com/Aceeee2077/Desk-Petrick/releases/latest) and install over the old one.
>
> The pre-migration Electron build used `electron-updater`: it generated a `latest.yml` manifest
> next to the installer on the GitHub Release, and about 8 seconds after launch the app compared
> versions, downloaded in the background, then offered a "🔄 Restart & Update" dialog.
> Tauri's equivalent is `latest.json` plus a minisign signature, which will be wired up in a
> follow-up (the "Check for Updates" items in the tray and pet context menu are disabled until then).

---

## ⚙️ Settings Panel

| Setting | Description |
| :--- | :--- |
| Language | 中文 / English one-click toggle (persisted; tray, context menu and speech lines switch too) |
| Theme | Light (orange-white gradient) / Dark (original purple) — the pet window, chat window and settings panel switch together |
| Pet type | Gray cat 🐱 / Fox 🦊 / Rabbit 🐰 / Bulu 🐈 / Robot 🤖 — switches instantly |
| Accessory | None / Hat 🎩 / Scarf 🧣 / Glasses 👓 — procedural pixel art for the robot skin |
| Eye tracking | In "Single image" mode, mark the two eyes on your photo — pupils follow the cursor and blink |
| Affinity | Current affinity value and level (clicking / dragging / chatting raise it; persisted) |
| Interaction stats | Days together, first day, click / chat counts and the affinity growth curve |
| Animation speed | 0.5x ~ 2x slider, applies to all animation frame rates |
| Opacity | 0.5 ~ 1.0 slider (not effective in the Tauri build yet — see "Known Limitations") |
| Click sound | Web Audio synthesized sound, toggleable |
| Auto-launch | Based on `tauri-plugin-autostart` (Windows Run key / macOS LaunchAgent / Linux .desktop) |
| Auto wander | The pet walks / runs / jumps around the desktop by itself; while on it stays awake (no 30 s auto-sleep), off restores the original sleep behavior |
| Reset position | Back to the center of the primary display |
| Focus Mode | Break-reminder toggle + interval (20 / 30 / 40 / 60 / 90 minutes) |
| Life Assistant | Independent toggles: proactive chat / weather / hourly chime |
| AI chat | Enable toggle + Base URL + API Key + model name + test button |

### 🤖 Configuring AI Chat

> ⚠️ **BYOK (Bring Your Own Key)**: this repository ships **no API key of its own** — the
> default config only holds placeholders (the sample Base URL is `https://api.openai.com/v1`)
> and AI chat is off by default. Every user — you, or anyone who clones / downloads this repo —
> must **sign up with an AI provider themselves** and enter **their own** Base URL + API Key +
> model name. Requests are sent only to the endpoint you configure and nowhere else.

Double-click the pet (or tray / right-click menu → "💬 AI Chat") to open the chat window; first
finish the setup under Settings → "AI Chat". Any **OpenAI-compatible** `/chat/completions`
endpoint works:

| Provider | API Base URL | Example model |
| :--- | :--- | :--- |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com` (`/v1` is appended automatically) | `deepseek-chat` |
| Moonshot | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| Ollama (local) | `http://localhost:11434/v1` | `qwen2.5` |

Fill in the values, hit "🧪 Test Chat" to verify, then double-click the pet to chat.

The chat window supports multiple conversations: from the left-hand list you can **start a new
chat, archive (📁 Archived section), rename or delete** conversations; both the pet window and
the chat window share the same history in real time.

> 🔒 **Privacy & data location**: the API key and chat history stay on your machine
> - AI config: `<app config dir>/config.json`
> - Chat history: `<app config dir>/chat-store.json` (persisted by Rust, shared by the pet window and the chat window)
> - On Windows the app config dir is `%APPDATA%\com.petric.desktop-pet\`
>
> ⚠️ The Tauri build uses a different config directory than the pre-migration Electron build
> (`%APPDATA%\Prismoo\`), so old settings and chat history are not carried over — a one-time
> migration is not implemented yet.
> Nothing is uploaded anywhere except to the AI provider you configured. AI is off by default and
> costs nothing until you add a key.

---

## 🎨 Customization Guide

### 0. 🖼️ Use Your Own Image as the Pet

> Besides the built-in cat/fox/rabbit, you can use any image as your pet — dragging,
> clicking, sleeping, AI chat, and settings all keep working.

**Way 1: In-app (recommended, works in packaged builds too)**
Settings → Pet type → "🖼️ Custom" → "Choose File…" → pick an image, applied instantly.
The file is copied into the app config directory's `custom/` folder; use "Clear Custom Appearance" to restore.

**Way 2: Command line (handy in dev)**
```bash
# Single image (default)
node scripts/set-custom.mjs your-image.png

# Sprite sheet (4 rows × 4 columns frame animation)
node scripts/set-custom.mjs your-sheet.png --mode sheet

# Restore default
node scripts/set-custom.mjs --clear
```

**Two appearance types**

| Type | Description |
| :--- | :--- |
| Single image | Any PNG / JPG / WebP / GIF (≤60MB). Shown as-is; the app adds procedural breathing / walking bounce / sleep dimming / click jump. Animated GIFs play their own animation. |
| Sprite sheet | 4 rows × 4 columns, equal-sized frames (row order: idle / walking / sleeping / click); frame size is auto-detected and all four animation states are preserved. |

> ⚠️ Note: with a custom image or model, "eye tracking" is disabled automatically (the built-in
> robot eyes are drawn by the renderer and can't be positioned on arbitrary assets); all other
> interactions remain. Images with transparent backgrounds look best.
>
> ⏳ **Differences from the Electron build**: 3D model (`.glb`) skins and the local U-2-Netp
> auto-cutout are **not available** in the Tauri build yet — they were deliberately dropped during
> the migration in exchange for a much smaller, lighter app. Importing an image still runs the
> renderer's built-in tolerance-based cutout, but it handles busy photo backgrounds less well than
> the old model did.

### 1. Replacing / Adding Sprite Sheets

The gray cat, fox, rabbit and Bulu sheets live in `src/assets/animated-pets/`. Each is a
256×256, 4×4 sheet with 64×64 frames. The robot lives in `src/assets/sprites/` and is
generated by `scripts/generate-sprites.mjs`.

**Option A: swap in your own sheet (recommended)**
Replace the file with the same name — no code changes needed:

```
src/assets/animated-pets/cat.png     ← 256×256, 4 rows × 4 columns (idle/walking/sleeping/click, 64×64 frames)
```

**Option B: extend the generator for a new pet**
In `scripts/generate-sprites.mjs`:
1. Add a color palette to `PALETTES`;
2. Add a `kind` branch in `drawPet()` (ears / tail / snout shapes);
3. Register the skin in the renderer: `loadSheets()` in `src/renderer/app.ts` and the `#skin-seg` buttons in `src/renderer/settings.ts`;
4. Run `npm run sprites`.

**Option C: build a pet from one transparent image**
If you only have a single still (photo or artwork), let the script trim, resize and bake the
four animation states into a 4×4 sheet:

```bash
node scripts/prepare-single-pet.mjs your-cat.png src/assets/animated-pets/bulu.png --cell 192
```

The input needs a transparent background (cut it out in-app or with `npm run set-custom`
first). The script emits 16 frames ordered idle / walking / sleeping / click.
`--cell` sets the per-frame pixel density (default 128): 64px frames keep the 2x
nearest-neighbour pixel-art upscale, while frames of 128px and up are blitted 1:1 with no
resampling — so more detail survives and the pet is both larger and sharper.

The illustrated animal sheets contain their complete faces. Robot eyes/blinks and the Zzz
particles are overlaid by the renderer.

### 2. Changing the Speech Lines

Edit the `lines` arrays in `src/shared/i18n.ts` (`zhDict` / `enDict` — click lines follow the UI language):

```ts
lines: ['喵～', '别摸我！', '饿了…', '今天也要加油鸭！'],   // zhDict
lines: ['Meow~', "Don't touch me!", 'I\'m hungry…'],       // enDict
```

### 3. Tweaking Animation / Sleep Parameters

- Per-state frame rates: `SHEET.states` in `src/renderer/app.ts` (mirrors `STATE_FPS` in the generator)
- Sleep threshold: `SLEEP_MS` (default 30000ms)
- Blink rhythm: the random range of `blinkTimer`
- Bubble styling: `#bubble` in `src/renderer/styles.css`

---

## 🗂️ Project Structure

```
prismoo/
├── src-tauri/                 # Tauri 2 backend (Rust)
│   ├── src/
│   │   ├── lib.rs             # Entry point: plugins / commands / three-phase self-check
│   │   ├── window.rs          # Window move · drag · click-through · settings/chat windows · auto-launch
│   │   ├── config.rs          # Config read/write (<app config>/config.json)
│   │   ├── i18n.rs            # Embedded zh/en dictionaries for the tray and native dialogs
│   │   ├── tray.rs            # Tray icon + pet context menu
│   │   ├── chat.rs            # Conversation store (chat-store.json) + message orchestration
│   │   ├── ai.rs              # AI requests (reqwest) and the persona system prompt
│   │   ├── weather.rs         # Weather (ipwho.is + Open-Meteo, cached)
│   │   └── custom.rs          # Custom appearance: pick · copy · expose via the asset protocol
│   ├── resources/i18n.json    # Generated from src/shared/i18n.ts
│   ├── capabilities/          # Tauri permission declarations
│   ├── icons/                 # Installer / tray icons
│   └── tauri.conf.json        # Window · bundling · CSP configuration
├── src/
│   ├── renderer/
│   │   ├── tauri-api.ts       # Compatibility shim: reimplements window.api on Tauri invoke
│   │   ├── index.html         # Pet window page
│   │   ├── styles.css         # Pet window styles (transparent bg / bubbles / affinity badge)
│   │   ├── i18n.ts            # Renderer i18n (window.PetricI18n, dictionary from Rust)
│   │   ├── app.ts             # Canvas drawing, animation state machine, drag, interactions & chat rewards
│   │   ├── chat.html / chat.css / chat.ts              # ChatGPT-style chat window
│   │   ├── settings.html / settings.css / settings.ts  # Settings panel
│   ├── shared/
│   │   ├── types.ts           # Global shared types (compile-time only, no runtime)
│   │   └── i18n.ts            # Chinese/English UI string dictionaries (single source)
│   └── assets/
│       ├── sprite-sources/    # Original cat / fox / rabbit reference art
│       ├── animated-pets/     # 64px four-state sheets for gray cat / fox / rabbit / Bulu
│       ├── sprites/           # Procedural robot and compatibility sheets
│       └── icon.png / icon.ico / icon.icns / tray.png
├── scripts/
│   ├── generate-sprites.mjs   # Pixel sprite & icon generator (zero-dependency PNG encoder)
│   ├── generate-brand-icons.mjs    # Brand icons (multi-size ICO included)
│   ├── build-tauri-resources.mjs   # Builds the Rust-side i18n.json from i18n.ts
│   ├── run-tauri-check.mjs    # Three-phase self-check runner
│   ├── prepare-animated-pet.mjs / prepare-single-pet.mjs  # Asset normalization
│   ├── clean-dist.mjs         # Wipes dist/ before a build so stale assets cannot linger
│   ├── copy-assets.mjs        # Copies html/css/assets into dist/ on build
│   └── set-custom.mjs         # CLI to set a custom appearance
├── package.json
├── tsconfig.json
├── README.md
└── README-EN.md
```

**Technical highlights**

- The backend is Rust (`src-tauri/`); the front end is still TypeScript + Canvas (compiled to
  CommonJS by `tsc`, renderer files are module-free single scripts).
- The renderer talks to Rust through the shim in `src/renderer/tauri-api.ts`, which reimplements the
  Electron preload's `window.api` on top of `invoke` / `listen` — so `app.ts` / `settings.ts` /
  `chat.ts` needed almost no changes.
- AI network requests are made in **Rust** (`reqwest`): that sidesteps CORS and keeps the API key
  out of the page.
- Chat data is managed centrally in **Rust** (`chat-store.json`); the pet window and the chat window
  stay in sync through `chats-changed` events.
- **Click-through**: Tauri's `set_ignore_cursor_events` has no Electron-style `forward` option, so a
  click-through window stops receiving `mousemove`. While click-through is on, the renderer polls the
  cursor every 50 ms and restores interaction as soon as it re-enters the pet's pixels or the update
  badge. Repeated polling failures fail safe by handing the clicks back to the pet.
- Dragging records a cursor anchor in Rust and positions the window absolutely — no cumulative drift.
- The transparent window keeps `requestAnimationFrame` running without throttling.

---

## 🧪 Known Limitations (MVP)

- **The migration is not finished**: auto-update is still missing (see above). 3D model skins and the
  ONNX-based local cutout were removed from the codebase as planned, along with their dependencies
  and assets.
- **Per-pixel click-through**: only the pet's **visible pixels** trigger interactions; clicks on
  transparent areas pass through to the desktop. Windows switches dynamically via
  `set_ignore_cursor_events`, with the renderer's alpha hitmap plus cursor polling restoring interaction.
- **Window opacity**: Tauri has no Electron-style `setOpacity` on Windows, so the opacity slider in
  Settings currently does nothing; the plan is to apply it as CSS opacity in the renderer.
- **Platform coverage**: only **Windows** has been fully exercised so far (including the self-check).
  macOS / Linux still need real packaging and testing — especially the transparent window and the
  click-through path, which are where platforms differ most.
- **Unsigned packages**: Windows SmartScreen / macOS Gatekeeper will warn about the unknown developer.
- **Built-in appearances**: gray cat / fox / rabbit / Bulu / robot; add more via the Customization Guide.

---

## 📸 Screenshots & Demo

> ⏳ The images below are still the static files generated before the migration. The Electron build
> had a `--screenshot` self-drawing pipeline (see the `pre-tauri-0.4.0` git tag) that has not been
> ported to Tauri yet; regenerate them with the old build, or just overwrite the files with real screenshots.

- `docs/screenshots/pet-cat.png`: the pet on a (simulated) desktop — composited from the real sprite sheet
- `docs/screenshots/settings-panel.png`: the settings panel (canvas recreation)
- `docs/screenshots/demo.gif`: drag / click / animation switching / AI chat demo — record it on your own
  machine with [ScreenToGif](https://www.screentogif.com/) and drop it in

> Want real desktop screenshots instead of the generated ones? Just overwrite the files in `docs/screenshots/`.

---

## 🤝 Contributing

All contributions are welcome:

- 🎨 New sprite skins (follow the 32×32-frame / 4-row sheet spec, or extend the generator)
- ✨ New animations / interactions (Pomodoro mode, weather awareness, multi-monitor pets, …)
- 🐛 Bug fixes and polish
- 📖 Docs and demos

Flow: Fork → new branch → open a PR. Make sure `npm run build` and `npm run tauri:check` both pass, and include a short description.

See [CONTRIBUTING.md](./.github/CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](./.github/CODE_OF_CONDUCT.md).

---

## 📄 License

[MIT](./LICENSE) © Prismoo Contributors

- The gray cat / fox / rabbit / Bulu animations were generated from project-provided references and ship with this repository; the robot is procedurally generated by the project.
- If you replace them with third-party art or models, verify their license yourself
  (CC0 / MIT / OGA-BY 3.0 recommended, and credit the source in the README).
