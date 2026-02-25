# Changelog

## v1.5.0 — 2026-02-25
### Feature — Per-Window CDP Port Isolation
- **High port range**: CDP ports moved from `9000/9222` → `19222–19242` to avoid conflicts with common services
- **Smart Launcher**: Auto-assigns the next available port on each IDE launch — no manual port config needed
- **Port Claim System**: Each extension instance claims its own port via lock files, preventing cross-instance conflicts
- **BG Lock removed**: Multiple windows can now run BG mode simultaneously (each has its own isolated CDP)
- **Setup Guide rewritten**: Focused on smart launcher workflow with multi-instance support

> ⚠️ **Breaking**: Users must re-run CDP setup to get the new port range. Old `--remote-debugging-port=9000` or `9222` shortcuts need updating.

## v1.4.2 — 2026-02-25
### Bug Fixes (8)
- **Async HTTP polling**: Replaced synchronous XHR (froze UI every 2s) with async `fetch()` + AbortController timeout
- **Safe Click in BG mode**: Background mode now checks for sibling Reject button before clicking — prevents clicking non-approval buttons
- **Diff Protection in BG mode**: Background mode now skips diff/merge editor buttons (Accept Changes, Accept Incoming, etc.)
- **Configurable click patterns**: Background mode now respects user-configured click patterns instead of using hardcoded list
- **HTTP Live Sync in BG mode**: Background mode now polls Extension Host for live config updates (was missing entirely)
- **Auto Scroll in BG mode**: Background mode now supports auto-scroll with manual scroll detection and pause
- **Duplicate stop**: Removed redundant `cdpHandler.stop()` call in `deactivate()` — was causing errors on closed WebSockets
- **Weekly ROI interval leak**: Stored interval ID and clear it on deactivate to prevent memory leaks
- **Multi-page stats**: CDP stats now aggregate from ALL connected pages, not just the first one

### Improvements
- **Config passthrough**: CDP handler now passes all safety/scroll config fields to injected scripts
- **Buy Me a Coffee button**: Fixed broken image on GitHub by switching to CDN static image URL

## v1.4.1 — 2026-02-25
### Critical Fix — BG Mode Cross-Window Flickering
- **Single-Leader Election**: Only ONE window can run Background Mode at a time. Lock file prevents multiple windows from conflicting
- **Dedup Guard**: Injected script refuses to start a second BG loop if one is already running on the same page
- **HTTP Port Expansion**: 10 ports (48787–48796) instead of 2, with smart port scanning and caching
- **Lock Cleanup**: BG lock auto-releases on deactivate or window close. Stale locks from dead processes are cleaned up

### Metadata
- Package renamed to `auto-accept-agent-pro`
- Version bump to 1.4.1


## v1.2.0 — 2026-02-25
### Critical Fix
- **Save As bug**: Removed `workbench.action.files.save` from accept commands — was triggering Save As dialog when viewing diffs
- **Dynamic discovery removed**: Was adding too many unrelated commands. Reverted to proven static 10-command list matching MunKhin VSIX
- **Background Mode VSIX fix**: `.vscodeignore` was excluding `main_scripts/` so Background Mode would crash after packaging
- **esbuild path fix**: `compositor.js` now resolves `auto_accept.js` path correctly after bundling

### New
- **Settings Export/Import**: Backup and transfer your frequency + banned commands as JSON
- **Dead code cleanup**: Deleted unused `modules/` directory (7 files, ~28KB)

## v1.1.1 — 2026-02-25
### UI/UX
- Status bar: ON = ✅ xanh lá (không nền vàng), OFF = ❌ nền đỏ
- BG Mode: ON = ✅ xanh lá (không còn quay mãi), OFF = ⊘ icon

### Accept All Fix
- **Dynamic command discovery**: Auto-finds ALL accept commands at startup
- Added `workbench.action.files.save` for auto-save after accept
- No more missing commands — catches every accept/approve/confirm command

## v1.1.0 — 2026-02-25
### Critical Fixes
- **Accept commands**: 2 → 10 Antigravity commands (fix Run/Alt+Enter)
- **CDP auto-reconnect**: Exponential backoff (2s→4s→8s, max 3 retries)
- **ROI stats**: Delta-based collection, no more double-counting
- **Banned commands**: Now works in Simple mode (was broken)
- **Toggle guard**: Prevents race condition on rapid double-click

### New Features
- **Output Channel**: User-visible `Auto Accept` log with timestamps
- **Away Mode**: "X actions handled while you were away" notification
- **Session Summary**: Shows clicks/blocked/time saved on disable
- **Focus State**: Tracks window focus for away detection
- **IDE detection**: Added Windsurf + Trae support
- **Keyboard shortcut**: `Ctrl+Shift+A` toggle

### Cleanup
- Removed dead files: `background_mode.js`, `simple_poll.js`
- Added `.vscodeignore` for clean VSIX (112KB vs 600KB+)

## v1.0.0 — 2026-02-25
- Initial build from scratch (no license/Pro gates)
- Core: toggle, background mode, CDP injection, ROI stats
- Supports Cursor + Antigravity IDEs
