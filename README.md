# KiCon Live Translate

**English** | [简体中文](README.zh-CN.md)

Real-time Chinese–English speech translation and live captions for KiCon Asia 2026. Capture a microphone, mixing console, or computer audio, translate with Qwen, and display captions in the workspace, on a projector, or in an always-on-top desktop overlay.

Current release: **1.0.1 · Windows x64 · October 25, 2026**. The installer bundles Electron, Chromium, Node.js, and the local service. Users do not need a development environment or to build the app. Installation works offline; live recognition and translation require internet access and your own API key.

The application interface and bundled offline guides are currently primarily in Chinese. This README includes the Chinese labels needed to follow the instructions.

## Download and get started

- [Windows x64 installer (.exe)](https://github.com/HubertHQH/kicon-live-translate/releases/download/v1.0.1/KiCon-Live-Translate-Setup-1.0.1-x64.exe) — download and run directly.
- [Complete distribution (.zip)](https://github.com/HubertHQH/kicon-live-translate/releases/download/v1.0.1/KiCon-Live-Translate-1.0.1-Windows-x64.zip) — the same installer, Chinese user guide, third-party licenses, release manifest, and checksums.
- [Release notes and SHA-256 checksums](https://github.com/HubertHQH/kicon-live-translate/releases/tag/v1.0.1).

The repository is currently private. Downloads require a GitHub account with access to this repository.

1. Download the installer, or extract the ZIP and read `请先阅读-安装与使用.txt` first.
2. Run `KiCon-Live-Translate-Setup-1.0.1-x64.exe` and launch **KiCon 实时同传** from the desktop or Start menu. Windows 11 x64 is recommended; allow at least 1 GB of disk space. Windows 11 has been tested locally. Windows 10 x64 and other graphics/audio hardware need testing on the target computer. This release does not target macOS, Linux, or 32-bit Windows; Windows ARM has not been validated.
3. Open **Settings (配置)**, enter your own API key, and save. The installer includes no developer credentials, meeting recordings, or personal settings. An existing key is never shown in the input field; leaving it blank preserves the saved key.
4. Return to the workspace and select **Preview demo captions (预览演示字幕)**. The demo captures no audio and makes no paid model requests. Use it to check the caption windows and projector setup.
5. Stop the demo, select the audio input and speaking language, and click **Start interpreting (开始同传)**. Speak after the status shows **正在同传**. When finished, click **Stop interpreting (停止同传)**, wait for the final sentence, then export your records.

The installed app does not need `start.cmd`, `start-overlay.cmd`, source files, or a separate browser. Press **Alt → KiCon 同传 → 使用说明** for the offline guide, or **关于** to check the version.

See the [installation and migration guide](docs/安装与迁移说明.txt) and [release notes](docs/更新说明.txt) for additional details; both documents are in Chinese.

## Model configuration

| Setting | Default |
| --- | --- |
| Base URL | `https://maas.qianwenaiapi.com/compatible-mode/v1` |
| Model ID | `qwen3.8-livetranslate-flash-realtime` |
| Realtime endpoint (advanced) | `wss://maas.qianwenaiapi.com/api-ws/v1/realtime` |
| API key | Supplied by each user |

This is the model integrated by the project; it does not run locally. A replacement endpoint or model must support the Qwen realtime WebSocket protocol. A standard chat API is not a direct substitute. Your account must have access to the selected model.

Saving settings validates their format, not remote permissions or your balance. Changes apply to the next interpreting session. Settings cannot be saved while a session is running.

## Speech, captions, and usage

- **Chinese talk → English / English talk → Chinese:** uses one session in a fixed direction. Source captions use recognition updates directly; translations appear as they are generated. Prefer this mode when the speaking language is fixed.
- **Automatic bidirectional mode (中英交替 · 自动双向):** sends the same audio to two sessions, producing Chinese and English separately. Both caption streams wait for their respective target-language output, which may appear later than source captions in fixed-direction mode and increases usage. The console also keeps the recognized source text.
- **Caption response:** fast segmentation is the default, with 300 ms of silence; the steadier option uses 600 ms. The selection is saved in the current console's site storage and applies to the next session. Smaller 50 ms audio packets and shorter silence thresholds reduce local waiting, but testing has not demonstrated a consistent large latency improvement.
- **Conference terminology:** enter one `中文 = English` pair per line. Changes apply to new sessions. These are model hints, not a guarantee that every technical term will be translated correctly.
- **Visible line limit:** show 1–5 lines per language, or adapt to the window height; the default is 2 lines. Overflow keeps the latest lines visible while retaining the full transcript. The retained-paragraph setting controls caption history separately.
- **Pause, blank screen, or close a caption window:** these affect the display only; audio capture and billing continue. Click **停止同传** to stop capture. Refreshing or closing the capture console also ends capture. Stop and wait for the final sentence before exiting to reduce the risk of losing it.
- **Tokens, duration, and cost:** usage accumulates from server reports, with session duration and estimated average cost per minute. Reports may arrive after streamed text. Bidirectional usage is already combined; do not multiply it by two again. Missing categories, prices, or reports are marked as partial or unpriced, not free. Built-in prices are historical references and do not update automatically. The provider's bill is authoritative.

## Three caption windows

| Window | Purpose | Always on top / transparency | Move and resize |
| --- | --- | --- | --- |
| Audience / projector window (打开投屏窗口) | A projector or extended display connected to the same computer | Regular independent window; supports fullscreen | Drag to the extended display; use the fullscreen button or press F |
| Browser floating captions (打开悬浮字幕) | Browsers supporting picture-in-picture | Browser-managed always-on-top window; cannot reveal other applications through its background | Drag the browser title bar and window edges |
| Desktop captions (桌面字幕) | Captions over slides or other applications | Always on top; supports a truly transparent background | Drag the top area to move; drag the bottom-right corner to resize |

Choose **Desktop captions (桌面字幕)** for a transparent background. **悬浮窗配色与透明度** lets you set Chinese text, English text, and background colors separately. **Background transparency of 100% is fully transparent; 0% is solid.** These colors affect floating and desktop captions, not the regular audience window. Visual transparency does not mean mouse click-through: text and controls may still receive clicks.

Windows connected to the same service share display settings. Installed and source versions run separate services and save settings separately; avoid capturing audio in both at once. Projection uses a display attached to the same computer. Remote projection to another computer is not implemented in this release.

## Settings, records, and backups

| Data | Installed app (user data directory) | Source version (project directory) |
| --- | --- | --- |
| Root directory | `%APPDATA%\KiConLiveTranslate` | Project root |
| Model, endpoints, API key, pricing | `config.env` | `.env` |
| Display settings, including line limit, font size, colors, transparency | `display.json` | `.local/display.json` |
| Desktop caption position and size | `desktop-window.json` | `.local/desktop-window.json` |
| Full caption revisions and usage | `recordings/*.jsonl` | `recordings/*.jsonl` |
| Speaking direction, terminology, caption response, browser floating-window size | Current console's site storage | Current browser's site storage |

In the installed app, use **Alt → KiCon 同传 → 打开本机数据文件夹** to open the data directory. Upgrades and uninstallation retain user data. Deleting only the installation directory does not remove keys or transcripts.

For migration, install and launch the app once on the new computer, then close both copies. Copy the needed `display.json`, `desktop-window.json`, and `recordings` files into the new data directory. When migrating from source, the display and desktop-window files come from `.local`. Enter your key again on the new computer; transfer `config.env` securely only when intentionally moving your own credentials (`.env` is its source-version equivalent). Site-storage settings may need to be re-entered; copy your terminology into a separate text file beforehand. Do not copy the entire Chromium cache. See the [Chinese migration guide](docs/安装与迁移说明.txt) for details.

Raw audio is not saved locally, but audio and terminology are sent to the configured cloud service during interpreting. Transcripts contain meeting content. Keys are stored locally as configuration text, without encryption through the operating system's credential store. Do not share your user data directory, `.env`, or entire working directory with others. Cloud-side data handling and retention are determined by your chosen provider.

Use **字幕与会话记录 → 查看本地存档** to export TXT or separate SRT files for each language. Exports read complete records, independent of the display's latest-2,000-entry limit. SRT timing is based on when captions were received and should be aligned before video editing. Record filenames use UTC timestamps.

## Troubleshooting and limitations

- **Missing configuration, authentication, or model errors:** check your key, permissions, balance, and endpoints. Save and start a new session. Keep keys out of support screenshots.
- **No audio:** check Windows microphone permissions, the selected device, and the input level. For computer audio, confirm the capture prompt in the installed app; in an external browser, enable audio sharing. System audio may include unrelated applications and notifications.
- **Captions stop updating:** check pause/blank-screen controls, input level, connection status, and errors. After an upstream disconnect, capture does not resume automatically and missed audio is not retransmitted. Restart interpreting once the connection recovers.
- **The background remains solid:** use desktop captions, not browser picture-in-picture, and set transparency to 100%. Remote desktop sessions, drivers, and screen-recording tools may affect rendering.
- **Translation waits for a complete sentence:** the model may need more context. Try fast segmentation. For a fixed language, single-direction mode can show source text earlier, but translation latency is not guaranteed to match the provider's demo.
- **Missing or empty captions when switching languages:** this has been observed in some continuous Chinese–English switching samples and is unresolved. Rehearse with the actual speakers, terminology, and audio equipment before a conference. Testing has not covered hours of continuous use or venue noise.
- **Windows reports an unknown publisher:** the installer is not code-signed. Verify the source and SHA-256 checksum; do not disable security protection. Follow your organization's installation process on managed computers.

When reporting an issue, include the app and Windows versions, audio source, speaking direction, caption-response option, error text, and reproduction steps. Share only redacted captions you have permission to disclose; never send keys or the full user data directory.

## Run from source

Maintainers need Node.js 22 or later with support for `--env-file-if-exists`, plus npm. Installing dependencies for the first time requires internet access.

```powershell
npm ci
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm start
```

Enter your key through Settings, or edit `.env` yourself. The default console is at `http://localhost:3210`; the audience screen is at `http://localhost:3210/screen`. The source version also provides `start.cmd` and `start-overlay.cmd` for the transparent desktop overlay. Keep both the service and capture console open. The service listens on `127.0.0.1` by default; do not expose it to the public internet for distribution to other users.

See [development and API notes](docs/开发与接口说明.md) (Chinese) for the protocol, pricing coverage, latency experiments, live-audio checks, and code structure.

## Build a distribution

```powershell
npm ci
npm test
npm run test:overlay
npm run dist:win
npm run test:package
npm run test:installer
npm run release:bundle
```

The installer test performs a real installation, first launch, restart, and uninstallation in a temporary destination. It stops if an existing installation or matching shortcuts are found, to avoid overwriting an in-use installation. Run it from a test account without an existing installed copy. Self-tests remove external Node/npm paths and use isolated temporary settings. Demo tests make no paid model requests. This is not equivalent to validation on every clean Windows computer.

`release:bundle` collects only the specified installer, user guide, release notes, component licenses, manifest, and checksums. It requires a passing installer-test receipt matching the installer's SHA-256. Every ZIP entry is read back and checked after packaging. It does not bundle the whole `release` directory, source tree, keys, or meeting records.

`release/win-unpacked`, the extracted distribution directory, old installers, and download caches can be regenerated and cleaned up after delivery. Run `npm run pack:win` or `npm run dist:win` before testing the packaged app again. Keep the latest ZIP, its checksum, and the corresponding installer. Keep the latest installer-test receipt in `artifacts`: it binds validation to the installer's hash and is not disposable scratch data.

For direct distribution, send `release/KiCon-Live-Translate-1.0.1-Windows-x64.zip` and its `.sha256.txt` file. Ideally, verify the hash through an independent trusted channel. `release/win-unpacked` is for maintainer testing and is not required for delivery. GitHub Releases also provides the standalone installer and `SHA256SUMS.txt` for the release assets.

## Licensing

Dependency licenses are included in the distribution; see the [third-party component notice](docs/第三方组件说明.txt) (Chinese). The project has not declared a public open-source license. Distribution does not grant rights to cloud-service accounts, credits, or meeting content.
