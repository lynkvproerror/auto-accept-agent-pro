# Changelog

## v1.5.8 — 2026-03-02
### Major Fix — Error Loop Protection
- **Error Context Guard**: Trước khi click "Continue"/"Retry", quét DOM xung quanh tìm error keywords → chặn click nếu phát hiện lỗi
- **Click Cooldown**: Click cùng nút 3 lần trong 30s → tự chặn
- **Loop Brake**: Khi trigger cooldown → dừng TẤT CẢ click 1 phút, log cảnh báo 🛑
- **Permission Script Guard**: Lớp click thứ 3 (CDP Permission) cũng được bảo vệ — dùng persistent `window.__permClickCooldown`
- **ROI Fix**: Chỉ đếm actual clicks vào ROI, không đếm blocked
- **Startup Delay**: Auto-resume sau restart IDE delay 5s, tránh click nhầm khi chưa sẵn sàng

## v1.5.7 — 2026-03-01
### Major Fix — Scroll Not Working in Background
- **Web Worker scroll timer**: Thay `setInterval` (bị throttle) bằng `workerDelay` — scroll chạy chính xác 500ms kể cả khi cửa sổ mất focus
- **12 panel selectors**: Mở rộng `findAgentPanel()` từ 3 → 12 selectors (chat-widget, agentic, conversation, copilot, auxiliary-bar...)
- **Multi-strategy scroll**: 3 fallback: `scrollTop` → `scrollTo` → `scrollIntoView` trên last child
- **Scroll verification**: `isAtBottom()` check sau mỗi strategy, chỉ scroll khi chưa ở bottom
- **Keyboard detection**: Detect PageUp/Down, Arrow, Home/End ngoài wheel event
- **DOM cache 2s**: Cache panel + target 2 giây, tránh query DOM mỗi 500ms
- **Panel fallback**: Nếu không tìm thấy scrollable element → scroll panel trực tiếp
- **`overflowY: overlay`**: Thêm detect kiểu overlay (Chrome/Edge)

## v1.5.6 — 2026-03-01
### Bug Fix — Accept Button Not Auto-Clicked
- **Missing `'Accept'` pattern**: Nút "Accept Alt+↵" trong terminal chat không được auto-click vì chỉ có pattern `'Accept all'` — thêm `'Accept'` standalone vào clickPatterns
- Fixed in: `extension.js`, `background_mode.js`, `compositor.js`

## v1.5.5 — 2026-02-27
### Bug Fix — Fix Shortcut Not Patching Taskbar
- **Taskbar shortcut**: Thêm scan path `%APPDATA%\...\Quick Launch\User Pinned\TaskBar` — shortcut pin trên Taskbar trước đây không được quét
- **Quick Launch**: Thêm scan path Quick Launch cho các shortcut khác

## v1.5.4 — 2026-02-27
### Improvement — Auto-Fix CDP Shortcut
- **Auto-detect IDE update**: Extension tự động phát hiện khi IDE cập nhật version mới, kiểm tra shortcuts và hiện cảnh báo ⚠️ với nút "Fix Now" nếu flag bị mất
- **3 outcome feedback**: PATCHED (flag added), ALREADY_OK (flag correct), NOT_FOUND (no shortcut) — thay vì chỉ SUCCESS/NOT_FOUND
- **Multi-IDE support**: Tìm shortcut Antigravity, Cursor, Windsurf, Trae (trước chỉ Antigravity)
- **Match cả tên file**: Kiểm tra cả `TargetPath` và tên file `.lnk` — bắt shortcut đã đổi tên
- **Wrong port fix**: Nếu shortcut có `--remote-debugging-port=9xxx` sai port → tự ghi đè thành `9222`
- **Copy Flag button**: Khi không tìm thấy shortcut → hiện nút "Copy Flag" cho user tự dán
- **Try/catch per shortcut**: Bắt lỗi từng shortcut thay vì crash cả script
- **Readme**: Thêm cảnh báo ⚠️ và hình ảnh minh hoạ Fix Shortcut

## v1.5.2 — 2026-02-26
### Bug Fix — Background Operation When Window Loses Focus
- **Web Worker Timer**: Added Web Worker-based timer that bypasses browser throttling — `setTimeout` gets throttled to ≥1s when tab is in background, Web Worker runs in a separate thread and is NOT affected
- **`requestAnimationFrame` → `setTimeout`**: Replaced `requestAnimationFrame` in `waitForDisappear()` — `rAF` stops completely when window loses focus, causing click verification to hang indefinitely
- **Background loop delays**: All `setTimeout` delays in `cursorLoop()` and `antigravityLoop()` now use `workerDelay()` via Web Worker
- **Simple poll mode**: Same fixes applied to the inline simple poll script in `compositor.js`

### Files Changed
- `background_mode.js`: Added `workerDelay()` + Web Worker, fixed `waitForDisappear()`, 6 loop delays → `workerDelay()`
- `compositor.js`: Added `workerDelay()` + Web Worker, fixed `waitForDisappear()`, main loop delay → `workerDelay()`

## v1.5.1 — 2026-02-26
### Critical Fix — Run Button (Alt+Enter) Now Auto-Clicks
- **CDP Permission Script Cycle**: Added MarcoDeliaBot-style fresh-eval-per-cycle polling (1500ms) — evaluates permission script on ALL CDP pages via new WebSocket each cycle, ensuring it reaches the OOPIF agent panel webview
- **Webview Context Detection**: `isInConversationArea()` now detects `vscode-webview://` protocol — skips sidebar/editor exclusion checks when running inside the agent panel (the ENTIRE page IS the panel)
- **`textMatches()` with Alt+⏎ support**: Matches `"run alt+⏎"` as target `"run"` using `startsWith(target + ' alt+')` pattern (ported from MarcoDeliaBot)
- **Shadow DOM TreeWalker**: Permission script uses `document.createTreeWalker` with recursive `shadowRoot` traversal for deep button discovery
- **Wide Port Scan**: CDP permission script scans 17 ports (9222, 9229, 9000–9014) instead of just 7
- **Auto Scroll Webview Fallback**: `findAgentPanel()` now falls back to `document.body` in webview context — fixes scroll not working inside OOPIF
- **God Mode in Permission Script**: Permission script includes God Mode guard for `data-testid` / `data-action` attributes

### Architecture
- `cdp-handler.js`: Added `evaluateOnAllPages()`, `_evalFresh()`, `_getAllPages()` methods
- `extension.js`: Added `buildPermissionScript()`, `checkPermissionButtons()`, `startPermissionPolling()` / `stopPermissionPolling()`
- `compositor.js` + `background_mode.js`: Added `_isWebviewContext` detection and `isInConversationArea()` bypass

## v1.5.0 — 2026-02-26
### Auto Scroll Consolidation
- **Removed status bar button**: Auto Scroll no longer has a dedicated `$(check) Auto Scroll` status bar item — managed through Settings panel
- **Removed keybinding**: `Ctrl+Shift+S` keybinding for scroll removed (was conflicting with common shortcuts)
- **Scroll state in tooltip**: Auto Scroll status now shown as tag in Auto Accept tooltip (`ON | 📜 Scroll`)
- **Command palette**: `Auto Accept: Toggle Auto Scroll` still available via command palette
- **Status bar cleanup**: 4 items → 3 items (Accept, BG Mode, Settings)

## v1.4.9 — 2026-02-26
### MarcoDeliaBot Feature Integration
- **🔥 God Mode**: Toggle in Settings panel — auto-accepts "Always Allow", "Always Run", "Allow This Conversation" buttons
  - Dynamic `rejectPatterns`: God Mode ON removes these from reject list; OFF blocks them (default safe)
  - HTTP Live Sync: `godModeEnabled` syncs to injection scripts in real-time
  - State persistence via `globalState`
- **🔧 Auto-Fix CDP Shortcut**: Settings panel button to auto-patch Windows shortcut with `--remote-debugging-port=9222`
  - PowerShell script scans Desktop + Start Menu for Antigravity `.lnk` files
  - Creates backup before modification
- **Async Lock (`isAccepting`)**: Prevents double-accepts when multiple commands fire rapidly
- **Shadow DOM Piercing**: `queryAll()` recursively traverses `shadowRoot` in both injection scripts
- **`antigravity.terminalCommand.run`**: Added to command list for Run button support

### New Commands
- `auto-accept.toggleGodMode` — Toggle God Mode ON/OFF
- `auto-accept.autoFixCDP` — Auto-fix CDP shortcut on Windows

## v1.4.8 — 2026-02-26
### MunKhin Feature Integration
- **`waitForDisappear` + `isElementVisible`**: Click verification helpers in `compositor.js`
- **`findNearbyCommandText` + `isCommandBanned`**: Banned command detection near Run/Execute buttons in both injection scripts
- **`bannedCommands` sync**: HTTP Live Sync server now sends `bannedCommands` to injection scripts
- **Badge skip logic**: Confirmed and verified — background mode skips completed conversations

## v1.4.7 — 2026-02-26
### Bug Fixes
- **Docker error spam**: Removed `run`/`execute` commands from polling — commands like `runTerminalCommand`, `runStep` were firing every second, triggering Docker checks and terminal execution
- **Unintended scrolling**: Replaced broad CSS selectors with smart heuristic (`findAgentPanel()` + `findDeepestScrollable()`) — auto scroll now targets only the chat message container, not terminal/output/explorer
- **CDP port mismatch**: Unified all files to port **9222** (was 9000 in extension.js and relauncher.js but 9222 in cdp-handler.js → CDP never connected)
- **HTTP port mismatch**: CDP injected scripts now receive actual bound HTTP port instead of hardcoded default
- **Native scroll side effects**: Removed native scroll polling entirely — scroll only works via CDP DOM injection for precision
- **Cursor Docker trigger**: Removed `cursorai.action.acceptAndRunGenerateInTerminal` from Cursor commands (triggered Docker/terminal execution)

### Improvements
- **Command discovery**: Only discovers `accept`/`apply`/`confirm` commands (no more `run`/`execute`)
- **Icon optimization**: Reduced icon.png from 2.4 MB (2048×2048) to 103 KB (256×256)
- **Dead code cleanup**: Removed 27 lines of unused native scroll code
- **Guard logic fix**: `Run` pattern now correctly triggers command polling guard

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

