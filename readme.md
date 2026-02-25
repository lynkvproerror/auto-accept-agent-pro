# ⚡ Auto Accept Agent Pro

> Automatically accept file edits, terminal commands, and agent prompts in **Cursor**, **Antigravity**, and **VS Code** IDEs. Premium protection, live configuration, and full analytics.

<p>
  <a href="https://www.buymeacoffee.com/lynkv" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>
  &nbsp;&nbsp;
  <a href="https://buymeacoffee.com/lynkv" target="_blank"><img src="media/bmc_qr.png" alt="QR Code" height="60" /></a>
</p>

---

## 🚀 Quick Start

1. **Install the extension** (`.vsix` file or from marketplace)
2. Look for **`Accept OFF`** in the status bar (bottom-right)
3. **Click to enable** → it starts auto-accepting immediately
4. Press `$(gear)` to open the Settings dashboard

### Background Mode
1. Enable Auto Accept first
2. Click **`BG Mode: OFF`** in the status bar
3. Follow the **CDP setup** if prompted (one-time)
4. The overlay will show progress for all tabs

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+A` | Toggle Auto Accept ON/OFF |
| `Alt+Shift+A` | Toggle Background Mode |
| `Ctrl+Shift+S` | Toggle Auto Scroll |

---

## ✨ Features

### 🎯 Auto Click — Configurable Patterns
Automatically clicks **Accept**, **Run**, **Allow**, **Continue**, **Retry**, and more — fully configurable from the Settings panel.

**Default patterns:** `Run`, `Allow`, `Always Allow`, `Keep Waiting`, `Retry`, `Continue`, `Allow Once`, `Allow This Con`, `Accept all`

### 🔄 Background Mode — Multi-Tab Cycling
Accepts across **all open conversations** by connecting via Chrome DevTools Protocol (CDP). Cycles through tabs, detects completion badges, and shows a visual progress overlay.

### 📜 Auto Scroll
Automatically scrolls chat panels to the bottom so you never miss new content.
- **Manual scroll detection** — pauses scrolling when you scroll up manually
- **Configurable timing** — Pause duration (1–20s) and scroll interval (200–2000ms)
- **Editor-safe** — skips `.monaco-editor` containers

### 🔒 Safe Click
Only clicks buttons that have a sibling **Reject** / **Deny** / **Cancel** button nearby — prevents accidental clicks on non-confirmation buttons.
- Checks **3 DOM levels**: parent → grandparent → great-grandparent
- Toggleable ON/OFF from Settings

### 🛡️ Diff Protection
Prevents clicking **"Accept Changes"**, **"Accept All"**, **"Accept Incoming"**, etc. inside diff and merge editors.
- **Two-layer check:**
  1. Text-matching against known editor button labels
  2. DOM container detection (`.monaco-diff-editor`, `.merge-editor-view`)
- Toggleable ON/OFF from Settings

### 🧠 Smart Accept — Command Safety
Blocks dangerous terminal commands before they execute:
- **Block list:** `rm -rf`, `format c:`, `del /f /s /q`, `dd if=`, etc.
- **Smart rules:** Pattern-based rules with configurable actions (block, warn, allow)
- **Regex support:** Use `/pattern/i` syntax in banned commands

### 📡 HTTP Live Sync
All settings changes are pushed to the injected script **in real-time** via HTTP. No restart required when toggling features or changing patterns.

### ⏰ Auto-Schedule
Automatically enable/disable the extension by time of day.
- Supports **cross-midnight** ranges (e.g., 23:00 → 07:00)

### 🔄 Smart Frequency
Dynamically adjusts poll speed based on agent activity:

| Tier | Interval | When |
|------|----------|------|
| ⚡ FAST | 500ms | Agent actively generating |
| 🟢 NORMAL | 1,000ms | Recent activity |
| 🟡 SLOW | 2,000ms | Idle for a while |
| 🔴 IDLE | 3,000ms | No activity detected |

### 📊 ROI Dashboard
Track productivity gains with detailed analytics:
- **This Week / Lifetime** stats with animated counters
- **Session History** — Live feed with ✅ accepts, 🚫 blocks, ⚠️ warnings
- **Weekly Notifications** — Automatic summary each week
- **Config Export/Import** — JSON backup of all settings

### 📊 Dual Status Bar

| Item | Function |
|------|----------|
| `$(check) Accept ON/OFF` | Toggle auto-accept |
| `$(arrow-down) Scroll ON/OFF` | Toggle auto-scroll |
| `BG Mode ON/OFF` | Toggle background mode |
| `$(gear)` | Open Settings panel |

---

## 🛠️ Requirements

- **Cursor IDE**, **Antigravity IDE**, or **VS Code** (partial support)
- For **Background Mode**: Chrome DevTools Protocol enabled (the extension will guide you through setup)

---

## 📋 All Commands

| Command | Description |
|---------|-------------|
| `Auto Accept: Toggle ON/OFF` | Enable/disable auto-accepting |
| `Auto Accept: Toggle Background Mode` | Enable multi-tab mode |
| `Auto Accept: Toggle Auto Scroll` | Enable/disable auto-scroll |
| `Auto Accept: Toggle Safe Click` | Enable/disable sibling-reject check |
| `Auto Accept: Toggle Diff Protection` | Enable/disable diff editor protection |
| `Auto Accept: Toggle Smart Accept` | Enable/disable command safety |
| `Auto Accept: Toggle Smart Frequency` | Enable/disable adaptive polling |
| `Auto Accept: Open Settings` | Open the full dashboard |
| `Auto Accept: Update Frequency` | Set poll frequency (200–3000ms) |
| `Auto Accept: Update Banned Commands` | Edit blocked command patterns |
| `Auto Accept: Update Click Patterns` | Configure which buttons to auto-click |
| `Auto Accept: Update Scroll Config` | Set scroll pause/interval timing |
| `Auto Accept: Update Schedule` | Set auto-schedule times |
| `Auto Accept: Update Smart Rules` | Edit smart accept rules |
| `Auto Accept: Get ROI Stats` | Retrieve productivity statistics |
| `Auto Accept: Get Session History` | View recent accept/block history |
| `Auto Accept: Clear Session History` | Reset the session log |

---

## ⚙️ Settings Panel

Open via the `$(gear)` status bar icon or `Auto Accept: Open Settings` command.

All features are configurable from the dashboard — no manual JSON editing required.

---

## 🔧 Architecture

```
Extension Host                    CDP / Browser
┌─────────────────┐              ┌─────────────────┐
│  extension.js   │──── CDP ────▶│  Injected Script │
│  ┌────────────┐ │              │  (compositor.js)  │
│  │ HTTP :48787│◀─── Poll 2s ──│                   │
│  └────────────┘ │              │  • Auto Click     │
│  • State Mgmt   │              │  • Safe Click     │
│  • Status Bar   │              │  • Diff Protection│
│  • Commands     │              │  • Auto Scroll    │
│  • ROI Stats    │              │  • HTTP Polling   │
│  • Scheduling   │              │  • Stats Tracking │
└─────────────────┘              └─────────────────┘
```

---

## 📝 Changelog

### v1.4.2
- 🐛 **8 Bug Fixes**: Async HTTP polling, Safe Click + Diff Protection + HTTP Sync + Auto Scroll in BG mode, configurable click patterns in BG mode, multi-page stats aggregation, interval cleanup, deactivate fix
- ☕ Fixed Buy Me a Coffee button on GitHub

### v1.4.1
- 🔒 Obfuscated build for all JavaScript files
- 📦 Published to Open VSX marketplace

### v1.4.0
- ✨ **Auto Scroll** — auto-scroll chat panels with manual scroll detection
- ✨ **Safe Click** — sibling Reject/Deny/Cancel button validation
- ✨ **Diff Protection** — skip diff/merge editor buttons
- ✨ **HTTP Live Sync** — real-time config push via port 48787
- ✨ **Dual Status Bar** — 4 right-aligned items (Accept, Scroll, BG, Settings)
- ✨ **Click Patterns** — configurable button text patterns with checkboxes
- 🔧 Comprehensive Settings panel with info cards for all features

### v1.3.0
- Smart Accept with command safety rules
- Auto-Schedule for overnight sessions
- Smart Frequency with adaptive polling
- ROI Dashboard with weekly notifications
- Session History with export/import
- Background Mode with multi-tab cycling

---

## ☕ Support

If this extension saves you time, consider buying me a coffee!

<p>
  <a href="https://www.buymeacoffee.com/lynkv" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>
  &nbsp;&nbsp;
  <a href="https://buymeacoffee.com/lynkv" target="_blank"><img src="media/bmc_qr.png" alt="QR Code" height="60" /></a>
</p>

---

## 📄 License

MIT License — Free and open source.
