/**
 * Settings Panel — Dashboard WebView
 *
 * Provides ROI stats, frequency slider, banned commands editor,
 * session history, auto-schedule, smart accept, smart frequency.
 */

const vscode = require('vscode');

class SettingsPanel {
    static currentPanel = null;
    static viewType = 'autoAcceptSettings';

    static createOrShow(extensionUri, context) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (SettingsPanel.currentPanel) {
            SettingsPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            SettingsPanel.viewType,
            'Auto Accept Pro Settings',
            column || vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        SettingsPanel.currentPanel = new SettingsPanel(panel, extensionUri, context);
    }

    constructor(panel, extensionUri, context) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._context = context;
        this._disposables = [];

        this._update(context);

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'updateFrequency':
                        await vscode.commands.executeCommand('auto-accept.updateFrequency', message.value);
                        break;
                    case 'updateBannedCommands':
                        await vscode.commands.executeCommand('auto-accept.updateBannedCommands', message.value);
                        break;
                    case 'refreshStats':
                        this._update(this._context);
                        break;
                    case 'support':
                        vscode.commands.executeCommand('auto-accept.support');
                        break;
                    case 'updateSchedule':
                        await vscode.commands.executeCommand('auto-accept.updateSchedule', message.value);
                        this._update(this._context);
                        break;
                    case 'toggleSmartFrequency':
                        await vscode.commands.executeCommand('auto-accept.toggleSmartFrequency');
                        this._update(this._context);
                        break;
                    case 'toggleSmartAccept':
                        await vscode.commands.executeCommand('auto-accept.toggleSmartAccept');
                        this._update(this._context);
                        break;
                    case 'clearHistory':
                        await vscode.commands.executeCommand('auto-accept.clearHistory');
                        this._update(this._context);
                        break;
                    case 'toggleScroll':
                        await vscode.commands.executeCommand('auto-accept.toggleScroll');
                        this._update(this._context);
                        break;
                    case 'toggleSafeClick':
                        await vscode.commands.executeCommand('auto-accept.toggleSafeClick');
                        this._update(this._context);
                        break;
                    case 'toggleDiffProtection':
                        await vscode.commands.executeCommand('auto-accept.toggleDiffProtection');
                        this._update(this._context);
                        break;
                    case 'toggleGodMode':
                        await vscode.commands.executeCommand('auto-accept.toggleGodMode');
                        this._update(this._context);
                        break;
                    case 'autoFixCDP':
                        await vscode.commands.executeCommand('auto-accept.autoFixCDP');
                        break;
                    case 'updateClickPatterns':
                        await vscode.commands.executeCommand('auto-accept.updateClickPatterns', message.value);
                        this._update(this._context);
                        break;
                    case 'updateScrollConfig':
                        await vscode.commands.executeCommand('auto-accept.updateScrollConfig', message.value);
                        break;
                    case 'exportConfig': {
                        const config = {
                            frequency: this._context.globalState.get('auto-accept-frequency', 1000),
                            bannedCommands: this._context.globalState.get('auto-accept-banned-commands', []),
                            isEnabled: this._context.workspaceState.get('auto-accept-isEnabled', false),
                            backgroundMode: this._context.workspaceState.get('auto-accept-backgroundMode', false),
                            smartAcceptEnabled: this._context.globalState.get('auto-accept-smart-accept', true),
                            smartRules: this._context.globalState.get('auto-accept-smart-rules', []),
                            scheduleEnabled: this._context.globalState.get('auto-accept-schedule-enabled', false),
                            scheduleStart: this._context.globalState.get('auto-accept-schedule-start', '23:00'),
                            scheduleEnd: this._context.globalState.get('auto-accept-schedule-end', '07:00'),
                            smartFrequency: this._context.globalState.get('auto-accept-smart-frequency', false),
                            clickPatterns: this._context.globalState.get('auto-accept-click-patterns', []),
                            disabledPatterns: this._context.globalState.get('auto-accept-disabled-patterns', []),
                            scrollPause: this._context.globalState.get('auto-accept-scroll-pause', 7000),
                            scrollInterval: this._context.globalState.get('auto-accept-scroll-interval', 500)
                        };
                        const uri = await vscode.window.showSaveDialog({
                            defaultUri: vscode.Uri.file('auto-accept-config.json'),
                            filters: { 'JSON': ['json'] }
                        });
                        if (uri) {
                            const fs = require('fs');
                            fs.writeFileSync(uri.fsPath, JSON.stringify(config, null, 2));
                            vscode.window.showInformationMessage('Config exported successfully.');
                        }
                        break;
                    }
                    case 'importConfig': {
                        const uris = await vscode.window.showOpenDialog({
                            canSelectMany: false,
                            filters: { 'JSON': ['json'] }
                        });
                        if (uris && uris[0]) {
                            const fs = require('fs');
                            try {
                                const raw = fs.readFileSync(uris[0].fsPath, 'utf8');
                                const cfg = JSON.parse(raw);
                                if (cfg.frequency) await vscode.commands.executeCommand('auto-accept.updateFrequency', cfg.frequency);
                                if (cfg.bannedCommands) await vscode.commands.executeCommand('auto-accept.updateBannedCommands', cfg.bannedCommands);
                                if (cfg.scheduleEnabled !== undefined) {
                                    await vscode.commands.executeCommand('auto-accept.updateSchedule', {
                                        enabled: cfg.scheduleEnabled,
                                        start: cfg.scheduleStart,
                                        end: cfg.scheduleEnd
                                    });
                                }
                                vscode.window.showInformationMessage('Config imported. Reload to apply.');
                                this._update(this._context);
                            } catch (e) {
                                vscode.window.showErrorMessage('Import failed: ' + e.message);
                            }
                        }
                        break;
                    }
                }
            },
            null,
            this._disposables
        );

        // Auto-refresh stats every 5s
        this._refreshTimer = setInterval(() => {
            if (this._panel.visible) {
                this._update(this._context);
            }
        }, 5000);

        this._disposables.push({ dispose: () => clearInterval(this._refreshTimer) });
    }

    _update(context) {
        const stats = vscode.commands.executeCommand('auto-accept.getROIStats');
        const history = vscode.commands.executeCommand('auto-accept.getSessionHistory');
        const frequency = context.globalState.get('auto-accept-frequency', 1000);
        const bannedCommands = context.globalState.get('auto-accept-banned-commands', []);
        const isEnabled = context.workspaceState.get('auto-accept-isEnabled', false);
        const isBackground = context.workspaceState.get('auto-accept-backgroundMode', false);
        const smartFreq = context.globalState.get('auto-accept-smart-frequency', false);
        const smartAccept = context.globalState.get('auto-accept-smart-accept', true);
        const schedEnabled = context.globalState.get('auto-accept-schedule-enabled', false);
        const schedStart = context.globalState.get('auto-accept-schedule-start', '23:00');
        const schedEnd = context.globalState.get('auto-accept-schedule-end', '07:00');
        const isScrollEnabled = context.workspaceState.get('auto-accept-scrollEnabled', true);
        const clickPatterns = context.globalState.get('auto-accept-click-patterns', ['Run', 'Allow', 'Always Allow', 'Keep Waiting', 'Retry', 'Continue', 'Allow Once', 'Allow This Con', 'Accept all']);
        const disabledPatterns = context.globalState.get('auto-accept-disabled-patterns', ['Accept all']);
        const scrollPause = context.globalState.get('auto-accept-scroll-pause', 7000);
        const scrollInterval = context.globalState.get('auto-accept-scroll-interval', 500);
        const safeClickEnabled = context.globalState.get('auto-accept-safe-click', true);
        const diffProtectionEnabled = context.globalState.get('auto-accept-diff-protection', true);
        const godModeEnabled = context.globalState.get('auto-accept-god-mode', false);

        Promise.all([Promise.resolve(stats), Promise.resolve(history)]).then(([roiStats, historyData]) => {
            this._panel.webview.html = this._getHtml(
                roiStats || { clicks: 0, blocked: 0, sessions: 0, clicksThisWeek: 0, blockedThisWeek: 0, sessionsThisWeek: 0, timeSavedFormatted: '0s' },
                frequency,
                bannedCommands,
                isEnabled,
                isBackground,
                smartFreq,
                smartAccept,
                schedEnabled,
                schedStart,
                schedEnd,
                historyData || [],
                isScrollEnabled,
                clickPatterns,
                disabledPatterns,
                scrollPause,
                scrollInterval,
                safeClickEnabled,
                diffProtectionEnabled,
                godModeEnabled
            );
        });
    }

    _getHtml(stats, frequency, bannedCommands, isEnabled, isBackground, smartFreq, smartAccept, schedEnabled, schedStart, schedEnd, history, isScrollEnabled, clickPatterns, disabledPatterns, scrollPause, scrollInterval, safeClickEnabled, diffProtectionEnabled, godModeEnabled) {
        const bannedStr = (bannedCommands || []).join('\n');
        const allPatterns = clickPatterns || ['Run', 'Allow', 'Always Allow', 'Keep Waiting', 'Retry', 'Continue', 'Allow Once', 'Allow This Con', 'Accept all'];
        const disabledPats = disabledPatterns || ['Accept all'];
        const historyHtml = (history || []).slice(0, 50).map(h => {
            const icon = h.action === 'accept' ? '✅' : h.action === 'block' ? '🚫' : '⚠️';
            const time = h.timestamp ? h.timestamp.split('T')[1].split('.')[0] : '';
            const cls = h.action === 'block' ? 'history-block' : h.action === 'warn' ? 'history-warn' : 'history-accept';
            return `<div class="history-item ${cls}"><span class="history-icon">${icon}</span><span class="history-time">${time}</span><span class="history-detail">${(h.detail || '').substring(0, 80)}</span></div>`;
        }).join('');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Auto Accept Pro Settings</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: system-ui, -apple-system, sans-serif;
            background: #1a1a2e;
            color: #e0e0e0;
            padding: 24px;
            line-height: 1.6;
        }

        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
        h1 {
            font-size: 1.6em;
            color: #fff;
        }
        .coffee-btn {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            background: linear-gradient(135deg, #ff813f, #ff5f1f);
            color: #fff;
            text-decoration: none;
            padding: 8px 16px;
            border-radius: 8px;
            font-weight: 600;
            font-size: 13px;
            cursor: pointer;
            border: none;
            transition: transform 0.2s, box-shadow 0.2s;
        }
        .coffee-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(255, 95, 31, 0.4); }
        .subtitle {
            font-size: 0.85em;
            color: #888;
            margin-bottom: 24px;
        }

        .card {
            background: rgba(255, 255, 255, 0.04);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 16px;
        }
        .card h2 {
            font-size: 1.1em;
            color: #ccc;
            margin-bottom: 12px;
        }

        .status-badges {
            display: flex;
            gap: 8px;
            margin-bottom: 16px;
            flex-wrap: wrap;
        }
        .badge {
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 0.8em;
            font-weight: 600;
        }
        .badge.on { background: rgba(78, 201, 176, 0.15); color: #4EC9B0; }
        .badge.off { background: rgba(255, 80, 80, 0.15); color: #ff5050; }
        .badge.bg { background: rgba(168, 85, 247, 0.15); color: #a855f7; }
        .badge.smart { background: rgba(56, 189, 248, 0.15); color: #38bdf8; }
        .badge.sched { background: rgba(251, 191, 36, 0.15); color: #fbbf24; }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 12px;
        }
        .stat-item {
            text-align: center;
            padding: 12px;
            background: rgba(0, 0, 0, 0.2);
            border-radius: 8px;
        }
        .stat-value {
            font-size: 1.8em;
            font-weight: 700;
            display: block;
        }
        .stat-value.purple { color: #a855f7; }
        .stat-value.orange { color: #f97316; }
        .stat-value.green { color: #4EC9B0; }
        .stat-label {
            font-size: 0.75em;
            color: #888;
            text-transform: uppercase;
            letter-spacing: 1px;
        }

        .slider-row {
            display: flex;
            align-items: center;
            gap: 12px;
        }
        input[type="range"] {
            flex: 1;
            height: 6px;
            appearance: none;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 3px;
            outline: none;
        }
        input[type="range"]::-webkit-slider-thumb {
            appearance: none;
            width: 18px;
            height: 18px;
            border-radius: 50%;
            background: #a855f7;
            cursor: pointer;
        }
        .slider-value {
            font-size: 1.2em;
            font-weight: 600;
            color: #a855f7;
            min-width: 60px;
            text-align: right;
        }

        textarea {
            width: 100%;
            min-height: 100px;
            background: rgba(0, 0, 0, 0.3);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 8px;
            color: #e0e0e0;
            padding: 12px;
            font-family: 'Cascadia Code', 'Fira Code', monospace;
            font-size: 13px;
            resize: vertical;
            margin-bottom: 12px;
        }
        textarea:focus { outline: none; border-color: #a855f7; }

        button {
            background: #a855f7;
            color: #fff;
            border: none;
            padding: 8px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-weight: 600;
            font-size: 13px;
        }
        button:hover { background: #9333ea; }
        button.secondary {
            background: rgba(255, 255, 255, 0.08);
            color: #ccc;
        }
        button.secondary:hover { background: rgba(255, 255, 255, 0.15); }
        button.danger { background: #ef4444; }
        button.danger:hover { background: #dc2626; }

        .divider {
            height: 1px;
            background: rgba(255, 255, 255, 0.06);
            margin: 20px 0;
        }

        .help-text {
            font-size: 0.8em;
            color: #666;
            margin-top: 8px;
        }

        .toggle-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 0;
        }
        .toggle-label { font-size: 0.95em; color: #ccc; }
        .toggle-status { font-size: 0.85em; font-weight: 600; }
        .toggle-status.on { color: #4EC9B0; }
        .toggle-status.off { color: #888; }

        .schedule-row {
            display: flex;
            gap: 12px;
            align-items: center;
            margin-top: 8px;
        }
        .schedule-row input[type="time"] {
            background: rgba(0, 0, 0, 0.3);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 6px;
            color: #e0e0e0;
            padding: 6px 10px;
            font-size: 13px;
        }
        .schedule-row input[type="time"]:focus { outline: none; border-color: #fbbf24; }
        .schedule-row label { font-size: 0.85em; color: #888; }

        .freq-tier {
            display: inline-block;
            padding: 2px 10px;
            border-radius: 12px;
            font-size: 0.75em;
            font-weight: 700;
            letter-spacing: 1px;
        }
        .freq-tier.fast { background: rgba(34, 197, 94, 0.2); color: #22c55e; }
        .freq-tier.normal { background: rgba(168, 85, 247, 0.2); color: #a855f7; }
        .freq-tier.slow { background: rgba(251, 146, 60, 0.2); color: #fb923c; }
        .freq-tier.idle { background: rgba(239, 68, 68, 0.2); color: #ef4444; }

        .history-container {
            max-height: 250px;
            overflow-y: auto;
            margin-top: 8px;
        }
        .history-item {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px 8px;
            border-radius: 6px;
            font-size: 0.82em;
            margin-bottom: 2px;
        }
        .history-accept { background: rgba(78, 201, 176, 0.05); }
        .history-block { background: rgba(239, 68, 68, 0.1); }
        .history-warn { background: rgba(251, 191, 36, 0.1); }
        .history-icon { flex-shrink: 0; }
        .history-time { color: #666; min-width: 60px; font-family: monospace; font-size: 0.9em; }
        .history-detail { color: #aaa; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .btn-row { display: flex; gap: 8px; flex-wrap: wrap; }
    </style>
</head>
<body>
    <div class="header">
        <h1>⚡ Auto Accept Agent Pro</h1>
        <button class="coffee-btn" onclick="support()">☕ Buy Me a Coffee</button>
    </div>
    <p class="subtitle">Performance Dashboard & Settings</p>

    <div class="status-badges">
        <span class="badge ${isEnabled ? 'on' : 'off'}">${isEnabled ? '🟢 Active' : '🔴 Inactive'}</span>
        ${isBackground ? '<span class="badge bg">🔄 Background</span>' : ''}
        <span class="badge ${isScrollEnabled ? 'on' : 'off'}">${isScrollEnabled ? '📜 Scroll ON' : '📜 Scroll OFF'}</span>
        ${smartAccept ? '<span class="badge smart">🧠 Smart Accept</span>' : ''}
        ${schedEnabled ? '<span class="badge sched">⏰ ' + schedStart + '-' + schedEnd + '</span>' : ''}
    </div>

    <div class="card">
        <h2>📊 This Week</h2>
        <div class="stats-grid">
            <div class="stat-item">
                <span class="stat-value purple" id="clicks-week">${stats.clicksThisWeek || 0}</span>
                <span class="stat-label">Accepts</span>
            </div>
            <div class="stat-item">
                <span class="stat-value orange" id="blocked-week">${stats.blockedThisWeek || 0}</span>
                <span class="stat-label">Blocked</span>
            </div>
            <div class="stat-item">
                <span class="stat-value green" id="sessions-week">${stats.sessionsThisWeek || 0}</span>
                <span class="stat-label">Sessions</span>
            </div>
        </div>
    </div>

    <div class="card">
        <h2>📈 Lifetime</h2>
        <div class="stats-grid">
            <div class="stat-item">
                <span class="stat-value purple">${stats.clicks || 0}</span>
                <span class="stat-label">Total Accepts</span>
            </div>
            <div class="stat-item">
                <span class="stat-value orange">${stats.blocked || 0}</span>
                <span class="stat-label">Total Blocked</span>
            </div>
            <div class="stat-item">
                <span class="stat-value green">${stats.timeSavedFormatted || '0s'}</span>
                <span class="stat-label">Time Saved</span>
            </div>
        </div>
    </div>

    <div class="divider"></div>

    <!-- Smart Accept -->
    <div class="card">
        <h2>🧠 Smart Accept</h2>
        <div class="toggle-row">
            <span class="toggle-label">File & System Protection</span>
            <button id="smart-toggle" class="${smartAccept ? '' : 'secondary'}" onclick="toggleSmartAccept()">
                ${smartAccept ? '🛡️ ON' : 'OFF'}
            </button>
        </div>
        <p class="help-text">Blocks dangerous commands: file deletion, system modification, force push. Warns on risky operations.</p>
    </div>

    <!-- Conversation Guard (replaces Safe Click) -->
    <div class="card">
        <h2>🔒 Conversation Guard</h2>
        <div class="toggle-row">
            <span class="toggle-label">Only click inside agent panel</span>
            <button id="safec-toggle" class="${safeClickEnabled ? '' : 'secondary'}" onclick="toggleSafeClick()">
                ${safeClickEnabled ? '🔒 ON' : 'OFF'}
            </button>
        </div>
        <p class="help-text">
            When ON, buttons are only auto-clicked inside the conversation/agent panel area.
            Excludes: sidebar, editor, title bar, status bar, explorer, tabs.
            <br>When OFF, auto-click works on all visible buttons matching patterns (less safe, more coverage).
        </p>
    </div>

    <!-- Diff Protection -->
    <div class="card">
        <h2>🛡️ Diff Protection</h2>
        <div class="toggle-row">
            <span class="toggle-label">Skip diff/merge editor buttons</span>
            <button id="diffp-toggle" class="${diffProtectionEnabled ? '' : 'secondary'}" onclick="toggleDiffProtection()">
                ${diffProtectionEnabled ? '🛡️ ON' : 'OFF'}
            </button>
        </div>
        <p class="help-text">
            When ON, ignores "Accept Changes", "Accept Incoming", "Accept Current", etc. inside diff and merge editors.
            <br><strong>Note:</strong> "Accept All" in agent panel is NOT blocked — only diff/merge editor buttons.
            <br><strong>Two-layer check:</strong> 1) Text-matching against known editor button labels, 2) DOM container check for <code>.monaco-diff-editor</code>, <code>.merge-editor-view</code>, etc.
        </p>
    </div>

    <!-- God Mode -->
    <div class="card">
        <h2>🔥 God Mode</h2>
        <div class="toggle-row">
            <span class="toggle-label">Auto-accept folder access prompts</span>
            <button id="godmode-toggle" class="${godModeEnabled ? '' : 'secondary'}" onclick="toggleGodMode()">
                ${godModeEnabled ? '🔥 ON' : 'OFF'}
            </button>
        </div>
        <p class="help-text">
            When ON, "Always Allow" and "Allow This Conversation" are auto-accepted.
            <br><strong>⚠️ Warning:</strong> The agent can access files <strong>outside</strong> your workspace.
            <br>When OFF, only safe actions (Run, Accept, Allow Once) are auto-accepted.
        </p>
    </div>

    <!-- Auto-Fix CDP -->
    <div class="card">
        <h2>🔧 Auto-Fix CDP</h2>
        <div class="toggle-row">
            <span class="toggle-label">Patch Antigravity shortcut</span>
            <button class="secondary" onclick="autoFixCDP()">🔧 Fix Shortcut</button>
        </div>
        <p class="help-text">
            Automatically adds <code>--remote-debugging-port=9222</code> to Desktop/Start Menu Antigravity shortcuts.
            <br>Required for background mode and button clicking.
        </p>
    </div>

    <!-- HTTP Live Sync Info -->
    <div class="card">
        <h2>📡 HTTP Live Sync</h2>
        <div class="toggle-row">
            <span class="toggle-label">Real-time config sync</span>
            <span class="toggle-status on">✅ Always Active</span>
        </div>
        <p class="help-text">
            Settings changes (toggle, patterns, scroll) are pushed to the injected script in real-time via HTTP on port 48787.
            The script polls every 2 seconds. No restart required.
        </p>
    </div>

    <!-- Auto-Schedule -->
    <div class="card">
        <h2>⏰ Auto-Schedule</h2>
        <div class="toggle-row">
            <span class="toggle-label">Auto enable/disable by time</span>
            <button id="sched-toggle" class="${schedEnabled ? '' : 'secondary'}" onclick="toggleSchedule()">
                ${schedEnabled ? '⏰ ON' : 'OFF'}
            </button>
        </div>
        <div class="schedule-row">
            <label>Start:</label>
            <input type="time" id="sched-start" value="${schedStart}">
            <label>End:</label>
            <input type="time" id="sched-end" value="${schedEnd}">
            <button class="secondary" onclick="saveSchedule()">Save</button>
        </div>
        <p class="help-text">Overnight example: 23:00 → 07:00. Auto Accept Pro enables at start, disables at end.</p>
    </div>

    <!-- Smart Frequency -->
    <div class="card">
        <h2>🔄 Smart Frequency</h2>
        <div class="toggle-row">
            <span class="toggle-label">Auto-adjust poll speed</span>
            <button id="freq-toggle" class="${smartFreq ? '' : 'secondary'}" onclick="toggleSmartFreq()">
                ${smartFreq ? '🔄 ON' : 'OFF'}
            </button>
        </div>
        <p class="help-text">FAST (500ms) when agent active → NORMAL (1s) → SLOW (2s) → IDLE (3s)</p>
    </div>

    <div class="divider"></div>

    <!-- Frequency Slider (only when Smart Freq is OFF) -->
    ${!smartFreq ? `
    <div class="card">
        <h2>⏱️ Poll Frequency</h2>
        <div class="slider-row">
            <input type="range" id="frequency" min="200" max="3000" step="100" value="${frequency}">
            <span class="slider-value" id="freq-display">${frequency}ms</span>
        </div>
        <p class="help-text">How often to check for accept buttons (200ms—3000ms)</p>
    </div>` : ''}

    <!-- Banned Commands -->
    <div class="card">
        <h2>🚫 Banned Commands</h2>
        <textarea id="banned-commands">${bannedStr}</textarea>
        <div class="btn-row">
            <button onclick="saveBanned()">Save</button>
            <button class="secondary" onclick="resetBanned()">Reset Defaults</button>
        </div>
        <p class="help-text">One pattern per line. Prefix with / for regex (e.g. /rm\\s+-rf/i)</p>
    </div>

    <div class="divider"></div>

    <!-- Auto Scroll -->
    <div class="card">
        <h2>📜 Auto Scroll</h2>
        <div class="toggle-row">
            <span class="toggle-label">Scroll chat panels to bottom</span>
            <button id="scroll-toggle" class="${isScrollEnabled ? '' : 'secondary'}" onclick="toggleScroll()">
                ${isScrollEnabled ? '📜 ON' : 'OFF'}
            </button>
        </div>
        <div class="slider-row" style="margin-top:12px">
            <label style="min-width:80px;font-size:0.85em;color:#888">Pause:</label>
            <input type="range" id="scroll-pause" min="1000" max="20000" step="500" value="${scrollPause || 7000}">
            <span class="slider-value" id="scroll-pause-display">${((scrollPause || 7000) / 1000).toFixed(1)}s</span>
        </div>
        <div class="slider-row" style="margin-top:4px">
            <label style="min-width:80px;font-size:0.85em;color:#888">Interval:</label>
            <input type="range" id="scroll-interval" min="200" max="2000" step="100" value="${scrollInterval || 500}">
            <span class="slider-value" id="scroll-interval-display">${scrollInterval || 500}ms</span>
        </div>
        <p class="help-text">Pauses when you scroll manually. Skips code editors.</p>
    </div>

    <!-- Click Patterns -->
    <div class="card">
        <h2>🎯 Click Patterns</h2>
        <p class="help-text" style="margin-bottom:12px">Select which button texts to auto-click. Unchecked patterns are ignored.</p>
        <div id="patterns-container">
${allPatterns.map(p => {
            const isDisabled = disabledPats.includes(p);
            return `            <div class="toggle-row" style="padding:4px 0">
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
                    <input type="checkbox" class="pattern-check" data-pattern="${p}" ${isDisabled ? '' : 'checked'}>
                    <span style="font-size:0.9em">${p}</span>
                </label>
            </div>`;
        }).join('\n')}
        </div>
        <div class="btn-row" style="margin-top:12px">
            <button onclick="savePatterns()">Save Patterns</button>
        </div>
    </div>

    <div class="divider"></div>

    <!-- Session History -->
    <div class="card">
        <h2>📋 Session History</h2>
        ${historyHtml ? `<div class="history-container">${historyHtml}</div>` : '<p class="help-text">No actions recorded yet.</p>'}
        <div class="btn-row" style="margin-top:12px">
            <button class="secondary" onclick="vscode.postMessage({command:'refreshStats'})">↻ Refresh</button>
            <button class="secondary danger" onclick="clearHistory()">Clear</button>
            <button class="secondary" onclick="vscode.postMessage({command:'exportConfig'})">📤 Export Config</button>
            <button class="secondary" onclick="vscode.postMessage({command:'importConfig'})">📥 Import Config</button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function support() { vscode.postMessage({ command: 'support' }); }

        // Frequency slider
        const slider = document.getElementById('frequency');
        const display = document.getElementById('freq-display');
        let debounceTimer;

        if (slider) {
            slider.addEventListener('input', () => {
                display.textContent = slider.value + 'ms';
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    vscode.postMessage({ command: 'updateFrequency', value: slider.value });
                }, 500);
            });
        }

        // Banned commands
        function saveBanned() {
            const text = document.getElementById('banned-commands').value;
            const commands = text.split('\\n').map(c => c.trim()).filter(c => c.length > 0);
            vscode.postMessage({ command: 'updateBannedCommands', value: commands });
        }

        function resetBanned() {
            const defaults = [
                'rm -rf /', 'rm -rf ~', 'rm -rf *',
                'format c:', 'del /f /s /q', 'rmdir /s /q',
                ':(){:|:&};:', 'dd if=', 'mkfs.',
                '> /dev/sda', 'chmod -R 777 /'
            ];
            document.getElementById('banned-commands').value = defaults.join('\\n');
            vscode.postMessage({ command: 'updateBannedCommands', value: defaults });
        }

        // Schedule
        function toggleSchedule() {
            const btn = document.getElementById('sched-toggle');
            const isOn = btn.textContent.includes('ON');
            vscode.postMessage({ command: 'updateSchedule', value: { enabled: !isOn, start: document.getElementById('sched-start').value, end: document.getElementById('sched-end').value } });
        }

        function saveSchedule() {
            vscode.postMessage({ command: 'updateSchedule', value: {
                enabled: document.getElementById('sched-toggle').textContent.includes('ON'),
                start: document.getElementById('sched-start').value,
                end: document.getElementById('sched-end').value
            }});
        }

        // Smart Frequency
        function toggleSmartFreq() {
            vscode.postMessage({ command: 'toggleSmartFrequency' });
        }

        // Smart Accept
        function toggleSmartAccept() {
            vscode.postMessage({ command: 'toggleSmartAccept' });
        }

        // Safe Click
        function toggleSafeClick() {
            vscode.postMessage({ command: 'toggleSafeClick' });
        }

        // Diff Protection
        function toggleDiffProtection() {
            vscode.postMessage({ command: 'toggleDiffProtection' });
        }

        // God Mode
        function toggleGodMode() {
            vscode.postMessage({ command: 'toggleGodMode' });
        }

        // Auto-Fix CDP
        function autoFixCDP() {
            vscode.postMessage({ command: 'autoFixCDP' });
        }

        // History
        function clearHistory() {
            vscode.postMessage({ command: 'clearHistory' });
        }

        // Count-up animation for stat values
        document.querySelectorAll('.stat-value').forEach(el => {
            const target = parseInt(el.textContent);
            if (isNaN(target) || target === 0) return;

            el.textContent = '0';
            let current = 0;
            const step = Math.max(1, Math.floor(target / 30));
            const interval = setInterval(() => {
                current = Math.min(current + step, target);
                el.textContent = current;
                if (current >= target) clearInterval(interval);
            }, 30);
        });

        // Scroll toggle
        function toggleScroll() {
            vscode.postMessage({ command: 'toggleScroll' });
        }

        // Scroll config sliders
        var scrollPauseEl = document.getElementById('scroll-pause');
        var scrollPauseDisp = document.getElementById('scroll-pause-display');
        var scrollIntEl = document.getElementById('scroll-interval');
        var scrollIntDisp = document.getElementById('scroll-interval-display');
        var scrollDebounce;
        if (scrollPauseEl) {
            scrollPauseEl.addEventListener('input', () => {
                scrollPauseDisp.textContent = (scrollPauseEl.value / 1000).toFixed(1) + 's';
                clearTimeout(scrollDebounce);
                scrollDebounce = setTimeout(() => {
                    vscode.postMessage({ command: 'updateScrollConfig', value: { pauseMs: parseInt(scrollPauseEl.value) } });
                }, 500);
            });
        }
        if (scrollIntEl) {
            scrollIntEl.addEventListener('input', () => {
                scrollIntDisp.textContent = scrollIntEl.value + 'ms';
                clearTimeout(scrollDebounce);
                scrollDebounce = setTimeout(() => {
                    vscode.postMessage({ command: 'updateScrollConfig', value: { intervalMs: parseInt(scrollIntEl.value) } });
                }, 500);
            });
        }

        // Click patterns
        function savePatterns() {
            var checks = document.querySelectorAll('.pattern-check');
            var patterns = [];
            var disabled = [];
            checks.forEach(function(cb) {
                patterns.push(cb.dataset.pattern);
                if (!cb.checked) disabled.push(cb.dataset.pattern);
            });
            vscode.postMessage({ command: 'updateClickPatterns', value: { patterns: patterns, disabled: disabled } });
        }
    </script>
</body>
</html>`;
    }

    dispose() {
        SettingsPanel.currentPanel = null;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }
}

module.exports = { SettingsPanel };
