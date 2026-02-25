# ⚡ Auto Accept Agent Pro

> Automatically accept file edits, terminal commands, and agent prompts in **Cursor**, **Antigravity**, and **VS Code** IDEs. Premium protection, live configuration, and full analytics.

---

## ✨ Features

### 🎯 Auto Click — Configurable Patterns
Automatically clicks **Accept**, **Run**, **Allow**, **Continue**, **Retry**, and more — fully configurable from the Settings panel. Each pattern can be individually enabled or disabled via checkboxes.

**Default patterns:** `Run`, `Allow`, `Always Allow`, `Keep Waiting`, `Retry`, `Continue`, `Allow Once`, `Allow This Con`, `Accept all`

### 🔄 Background Mode — Multi-Tab Cycling
Accepts across **all open conversations** by connecting via Chrome DevTools Protocol (CDP). Cycles through tabs, detects completion badges, and shows a visual progress overlay.

### 📜 Auto Scroll
Automatically scrolls chat panels to the bottom so you never miss new content.
- **Manual scroll detection** — pauses scrolling when you scroll up manually
- **Configurable timing** — Pause duration (1–20s) and scroll interval (200–2000ms)
- **Editor-safe** — skips `.monaco-editor` containers

### 🔒 Safe Click
Only clicks buttons that have a sibling **Reject** / **Deny** / **Cancel** button nearby. This prevents accidental clicks on buttons that look like "accept" but aren't part of a real confirmation dialog.
- Checks **3 DOM levels**: parent → grandparent → great-grandparent
- Toggleable ON/OFF from Settings

### 🛡️ Diff Protection
Prevents clicking **"Accept Changes"**, **"Accept All"**, **"Accept Incoming"**, etc. inside diff and merge editors — protecting your git merges and code reviews.
- **Two-layer check:**
  1. Text-matching against known editor button labels (`EDITOR_SKIP_WORDS`)
  2. DOM container detection (`.monaco-diff-editor`, `.merge-editor-view`, `.inline-merge-region`, `.merged-editor`)
- Toggleable ON/OFF from Settings

### 🧠 Smart Accept — Command Safety
Blocks dangerous terminal commands before they execute:
- **Block list:** `rm -rf`, `format c:`, `del /f /s /q`, `dd if=`, `chmod -R 777 /`, etc.
- **Smart rules:** Pattern-based rules with configurable actions (block, warn, allow)
- **Regex support:** Use `/pattern/i` syntax in banned commands
- Fully editable from Settings panel

### 📡 HTTP Live Sync
All settings changes are pushed to the injected script **in real-time** via an HTTP server on port `48787`. The script polls every 2 seconds — no restart required when toggling features or changing patterns.

### ⏰ Auto-Schedule
Automatically enable/disable the extension by time of day. Perfect for overnight coding sessions.
- Supports **cross-midnight** ranges (e.g., 23:00 → 07:00)
- Auto-enables at start time, auto-disables at end time

### 🔄 Smart Frequency
Dynamically adjusts poll speed based on agent activity:
| Tier | Interval | When |
|------|----------|------|
| ⚡ FAST | 500ms | Agent actively generating |
| 🟢 NORMAL | 1,000ms | Recent activity |
| 🟡 SLOW | 2,000ms | Idle for a while |
| 🔴 IDLE | 3,000ms | No activity detected |

### 📊 ROI Dashboard
Track your productivity gains with detailed analytics:
- **This Week:** Accepts, Blocked, Sessions
- **Lifetime:** Total Accepts, Total Blocked, Time Saved
- **Session History:** Live feed with ✅ accepts, 🚫 blocks, ⚠️ warnings
- **Weekly Notifications:** Automatic summary each week
- **Config Export/Import:** JSON backup of all settings

### 📊 Dual Status Bar
Four right-aligned status bar items for instant visibility:

| Item | Function |
|------|----------|
| `$(check) Accept ON/OFF` | Toggle auto-accept |
| `$(arrow-down) Scroll ON/OFF` | Toggle auto-scroll |
| `BG Mode ON/OFF` | Toggle background mode |
| `$(gear)` | Open Settings panel |

---

## 🚀 Quick Start

1. **Install the extension** (`.vsix` file)
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
| `Auto Accept: Support` | Open support page |

---

## ⚙️ Settings Panel

Open via the `$(gear)` status bar icon or `Auto Accept: Open Settings` command.

### Dashboard Cards
- **📊 This Week / Lifetime** — Animated stat counters
- **🧠 Smart Accept** — Toggle file & system protection
- **🔒 Safe Click** — Toggle sibling-reject requirement + description
- **🛡️ Diff Protection** — Toggle diff/merge editor protection + description
- **📡 HTTP Live Sync** — Info card showing real-time sync status
- **⏰ Auto-Schedule** — Toggle + time range inputs
- **🔄 Smart Frequency** — Toggle adaptive polling
- **⏱️ Poll Frequency** — Manual slider (when Smart Frequency is OFF)
- **🚫 Banned Commands** — Textarea editor with regex support
- **📜 Auto Scroll** — Toggle + Pause slider + Interval slider
- **🎯 Click Patterns** — Checkbox for each pattern
- **📋 Session History** — Live feed with refresh, clear, export, import

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

1. **Simple Mode**: Executes IDE accept commands at configured intervals
2. **Background Mode**: Connects via CDP, injects a sophisticated script that:
   - Clicks accept buttons across all tabs using configurable patterns
   - Validates clicks with Safe Click (sibling-reject check)
   - Skips diff/merge editor buttons (Diff Protection)
   - Auto-scrolls chat panels with manual scroll detection
   - Syncs configuration in real-time via HTTP polling
   - Tracks statistics for the ROI dashboard

---

## 📝 Changelog

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

## 📄 License

MIT License — Free and open source.

---

## ☕ Support

If this extension saves you time, consider buying me a coffee!

<p>
  <a href="https://buymeacoffee.com/lynkv" target="_blank"><img src="https://img.buymeacoffee.com/button-api/?text=Buy%20me%20a%20coffee&emoji=&slug=lynkv&button_colour=FFDD00&font_colour=000000&font_family=Cookie&outline_colour=000000&coffee_colour=ffffff" alt="Buy Me A Coffee" height="60" /></a>
  &nbsp;&nbsp;
  <a href="https://buymeacoffee.com/lynkv" target="_blank"><img src="media/bmc_qr.png" alt="QR Code" height="60" /></a>
</p>
