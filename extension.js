/**
 * Auto Accept Agent Pro — Main Extension
 *
 * Automatically accept file edits, terminal commands, and agent prompts.
 * Supports background mode with multi-tab cycling for Cursor and Antigravity IDEs.
 *
 * Architecture:
 *   - IDE detection (Cursor / Antigravity / Windsurf / Trae / VS Code)
 *   - State management via globalState
 *   - Status bar items (toggle, background, settings)
 *   - Command polling (IDE-native accept commands)
 *   - CDP integration for browser script injection
 *   - ROI stats collection (delta-based, no double-counting)
 *   - Instance lock for multi-window support
 *   - Output Channel for user-visible logging
 *   - Away Mode notifications when user returns
 *   - Session summary on disable
 */

const vscode = require('vscode');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { CdpHandler } = require('./main_scripts/cdp-handler');
const { Relauncher } = require('./main_scripts/relauncher');

// ─── Constants ───────────────────────────────────────────────────────
const CDP_PORT = 9000;
const DEFAULT_POLL_FREQUENCY = 1000;
const SECONDS_PER_CLICK = 5;
const SUPPORT_URL = 'https://buymeacoffee.com/lynkv';
const AG_HTTP_PORT_BASE = 48787;
const AG_HTTP_PORT_RANGE = 10; // try 48787..48796

// BG mode lock file — ensures only ONE window runs background mode at a time
const BG_LOCK_DIR = path.join(os.tmpdir(), 'auto-accept-pro');
const BG_LOCK_FILE = path.join(BG_LOCK_DIR, 'bg-mode.lock');
const WINDOW_ID = `${process.pid}-${Date.now()}`;

// Smart Frequency tiers
const FREQ_FAST = 500;
const FREQ_NORMAL = 1000;
const FREQ_SLOW = 2000;
const FREQ_IDLE = 3000;
const ACTIVITY_WINDOW_MS = 10000;
const ACTIVITY_ADAPT_INTERVAL = 5000;

// Default click patterns
const DEFAULT_CLICK_PATTERNS = ['Run', 'Allow', 'Always Allow', 'Keep Waiting', 'Retry', 'Continue', 'Allow Once', 'Allow This Con', 'Accept all'];
const DEFAULT_DISABLED_PATTERNS = ['Accept all'];

const DEFAULT_BANNED_COMMANDS = [
    'rm -rf /', 'rm -rf ~', 'rm -rf *',
    'format c:', 'del /f /s /q', 'rmdir /s /q',
    ':(){:|:&};:', 'dd if=', 'mkfs.',
    '> /dev/sda', 'chmod -R 777 /'
];

// Smart Accept — default protection rules
const DEFAULT_SMART_RULES = [
    { pattern: 'rm -rf /', category: 'delete', severity: 'block' },
    { pattern: 'rm -rf ~', category: 'delete', severity: 'block' },
    { pattern: 'rm -rf *', category: 'delete', severity: 'block' },
    { pattern: 'rmdir /s /q', category: 'delete', severity: 'block' },
    { pattern: 'del /f /s /q', category: 'delete', severity: 'block' },
    { pattern: '/rm\\s+(-[rRf]+\\s+)*\\//i', category: 'delete', severity: 'block', type: 'regex' },
    { pattern: 'format c:', category: 'system', severity: 'block' },
    { pattern: 'mkfs.', category: 'system', severity: 'block' },
    { pattern: 'dd if=', category: 'system', severity: 'block' },
    { pattern: 'diskpart', category: 'system', severity: 'block' },
    { pattern: '> /dev/sda', category: 'system', severity: 'block' },
    { pattern: 'chmod -R 777 /', category: 'permission', severity: 'block' },
    { pattern: ':(){:|:&};:', category: 'system', severity: 'block' },
    { pattern: '/C:\\\\Windows\\\\System32/i', category: 'system-dir', severity: 'warn', type: 'regex' },
    { pattern: '/\\/etc\\/(passwd|shadow|sudoers)/i', category: 'system-dir', severity: 'block', type: 'regex' },
    { pattern: '/\\/usr\\/(bin|sbin|lib)/i', category: 'system-dir', severity: 'warn', type: 'regex' },
    { pattern: 'git push --force', category: 'git', severity: 'warn' },
    { pattern: 'git reset --hard', category: 'git', severity: 'warn' },
    { pattern: 'npm publish', category: 'package', severity: 'warn' },
    { pattern: 'pip install', category: 'package', severity: 'warn' },
];

// ─── Accept Commands Per IDE ─────────────────────────────────────────
const ACCEPT_COMMANDS_ANTIGRAVITY = [
    'antigravity.agent.acceptAgentStep',
    'antigravity.command.accept',
    'antigravity.prioritized.agentAcceptAllInFile',
    'antigravity.prioritized.agentAcceptFocusedHunk',
    'antigravity.prioritized.supercompleteAccept',
    'antigravity.terminalCommand.accept',
    'antigravity.acceptCompletion',
    'antigravity.prioritized.terminalSuggestion.accept',
    'antigravity.acceptEdit',
    'editor.action.acceptInlineSuggestion'
];

const ACCEPT_COMMANDS_CURSOR = [
    'cursorai.action.acceptAndRunGenerateInTerminal',
    'cursorai.action.acceptGenerateInTerminal',
    'cursorAcceptInlineSuggestion',
    'editor.action.acceptInlineSuggestion',
    'aipopup.action.accept'
];

const ACCEPT_COMMANDS_WINDSURF = [
    'editor.action.acceptInlineSuggestion',
    'cascade.acceptSuggestion'
];

const ACCEPT_COMMANDS_FALLBACK = [
    'editor.action.acceptInlineSuggestion'
];

// ─── Global State ────────────────────────────────────────────────────
let isEnabled = false;
let isBackgroundMode = false;
let isToggling = false;
let pollFrequency = DEFAULT_POLL_FREQUENCY;
let bannedCommands = [...DEFAULT_BANNED_COMMANDS];
let commandPollTimer = null;
let cdpSyncTimer = null;
let cdpHandler = null;
let statusBarToggle = null;
let statusBarBackground = null;
let statusBarSettings = null;
let statusBarScroll = null;
let outputChannel = null;
let currentIDE = 'antigravity';
let globalContext = null;
let relauncher = null;
let roiStats = { clicks: 0, blocked: 0, sessions: 0, sessionsThisWeek: 0, clicksThisWeek: 0, blockedThisWeek: 0, weekStart: null };
let sessionClicksAtStart = 0;
let sessionBlockedAtStart = 0;
let weeklyROITimer = null;

// Session History
const MAX_HISTORY = 500;
let sessionHistory = [];

// Smart Frequency
let smartFrequencyEnabled = false;
let activityTimestamps = [];
let activityAdaptTimer = null;
let currentFrequencyTier = 'NORMAL';

// Auto-Schedule
let scheduleEnabled = false;
let scheduleStart = '23:00';
let scheduleEnd = '07:00';
let scheduleTimer = null;
let enabledBySchedule = false;

// Smart Accept
let smartAcceptEnabled = true;
let smartRules = [...DEFAULT_SMART_RULES];

// Auto Scroll
let isScrollEnabled = true;
let scrollPauseMs = 7000;
let scrollIntervalMs = 500;

// Click Patterns
let clickPatterns = [...DEFAULT_CLICK_PATTERNS];
let disabledClickPatterns = [...DEFAULT_DISABLED_PATTERNS];

// Safety Features
let safeClickEnabled = true;
let diffProtectionEnabled = true;

// HTTP Live Sync Server
let httpServer = null;
let httpBoundPort = null;  // actual port the server bound to

// Hybrid Mode — CDP status tracking
let isCDPConnected = false;
let cdpRetryTimer = null;
const CDP_RETRY_INTERVAL = 30000; // auto-retry CDP every 30s

// ─── Logging ─────────────────────────────────────────────────────────
function log(msg) {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    const logLine = `[${timestamp}] ${msg}`;
    console.log(`[AutoAccept] ${logLine}`);
    if (outputChannel) {
        outputChannel.appendLine(logLine);
    }
}

// ─── IDE Detection ───────────────────────────────────────────────────
function detectIDE() {
    const appName = (vscode.env.appName || '').toLowerCase();
    if (appName.includes('cursor')) return 'cursor';
    if (appName.includes('antigravity')) return 'antigravity';
    if (appName.includes('windsurf')) return 'windsurf';
    if (appName.includes('trae')) return 'trae';
    return 'code';
}

function getIDEDisplayName() {
    const ide = detectIDE();
    const names = { cursor: 'Cursor', antigravity: 'Antigravity', windsurf: 'Windsurf', trae: 'Trae' };
    return names[ide] || 'VS Code';
}

function getAcceptCommandsForIDE() {
    const ide = currentIDE;
    if (ide === 'antigravity') return ACCEPT_COMMANDS_ANTIGRAVITY;
    if (ide === 'cursor') return ACCEPT_COMMANDS_CURSOR;
    if (ide === 'windsurf' || ide === 'trae') return ACCEPT_COMMANDS_WINDSURF;
    return ACCEPT_COMMANDS_FALLBACK;
}

// ─── Activation ──────────────────────────────────────────────────────
function activate(context) {
    // Create output channel first so we can log everything
    outputChannel = vscode.window.createOutputChannel('Auto Accept Pro');
    context.subscriptions.push(outputChannel);

    log('Activating extension...');
    globalContext = context;

    currentIDE = detectIDE();
    log(`Detected IDE: ${getIDEDisplayName()}`);
    log(`Accept commands: ${getAcceptCommandsForIDE().join(', ')}`);

    // Load persisted state — workspaceState = per-window independence
    isEnabled = context.workspaceState.get('auto-accept-isEnabled', false);
    isBackgroundMode = context.workspaceState.get('auto-accept-backgroundMode', false);
    isScrollEnabled = context.workspaceState.get('auto-accept-scrollEnabled', true);
    pollFrequency = context.globalState.get('auto-accept-frequency', DEFAULT_POLL_FREQUENCY);
    bannedCommands = context.globalState.get('auto-accept-banned-commands', DEFAULT_BANNED_COMMANDS);
    smartFrequencyEnabled = context.globalState.get('auto-accept-smart-frequency', false);
    smartAcceptEnabled = context.globalState.get('auto-accept-smart-accept', true);
    smartRules = context.globalState.get('auto-accept-smart-rules', DEFAULT_SMART_RULES);
    scheduleEnabled = context.globalState.get('auto-accept-schedule-enabled', false);
    scheduleStart = context.globalState.get('auto-accept-schedule-start', '23:00');
    scheduleEnd = context.globalState.get('auto-accept-schedule-end', '07:00');
    clickPatterns = context.globalState.get('auto-accept-click-patterns', DEFAULT_CLICK_PATTERNS);
    disabledClickPatterns = context.globalState.get('auto-accept-disabled-patterns', DEFAULT_DISABLED_PATTERNS);
    scrollPauseMs = context.globalState.get('auto-accept-scroll-pause', 7000);
    scrollIntervalMs = context.globalState.get('auto-accept-scroll-interval', 500);
    safeClickEnabled = context.globalState.get('auto-accept-safe-click', true);
    diffProtectionEnabled = context.globalState.get('auto-accept-diff-protection', true);
    loadROIStats(context);
    sessionHistory = context.workspaceState.get('auto-accept-session-history', []);

    // Initialize CDP handler and Relauncher
    cdpHandler = new CdpHandler(msg => log(msg));
    relauncher = new Relauncher(msg => log(msg));

    // ─── Status Bar — right-aligned, grouped together ─────────────
    statusBarToggle = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10000);
    statusBarToggle.command = 'auto-accept.toggle';
    statusBarToggle.tooltip = 'Click to toggle Auto Accept Pro';
    context.subscriptions.push(statusBarToggle);

    statusBarScroll = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10001);
    statusBarScroll.command = 'auto-accept.toggleScroll';
    statusBarScroll.tooltip = 'Click to toggle Auto Scroll';
    context.subscriptions.push(statusBarScroll);

    statusBarBackground = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10002);
    statusBarBackground.command = 'auto-accept.toggleBackground';
    statusBarBackground.tooltip = 'Click to toggle Background Mode';
    context.subscriptions.push(statusBarBackground);

    statusBarSettings = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10003);
    statusBarSettings.text = '$(gear)';
    statusBarSettings.command = 'auto-accept.openSettings';
    statusBarSettings.tooltip = 'Auto Accept Pro Settings';
    context.subscriptions.push(statusBarSettings);

    updateStatusBar();

    // ─── Focus Listener — Away Mode ──────────────────────────────
    context.subscriptions.push(
        vscode.window.onDidChangeWindowState(async (e) => {
            // Push focus state to CDP handler
            if (cdpHandler && cdpHandler.setFocusState) {
                await cdpHandler.setFocusState(e.focused);
            }

            // When user returns and auto-accept is running, check for away actions
            if (e.focused && isEnabled) {
                log('[Away] Window focused - checking for away actions...');
                setTimeout(async () => {
                    try {
                        const awayActions = await getAwayActions();
                        if (awayActions > 0) {
                            log(`[Away] ${awayActions} actions handled while away`);
                            vscode.window.showInformationMessage(
                                `🚀 Auto Accept Pro handled ${awayActions} action${awayActions > 1 ? 's' : ''} while you were away.`,
                                'View Dashboard'
                            ).then(choice => {
                                if (choice === 'View Dashboard') openSettings(context);
                            });
                        }
                    } catch (e) {
                        // Away check failed, not critical
                    }
                }, 500);
            }
        })
    );

    // ─── Commands ────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('auto-accept.toggle', () => handleToggle(context)),
        vscode.commands.registerCommand('auto-accept.toggleBackground', () => handleBackgroundToggle(context)),
        vscode.commands.registerCommand('auto-accept.toggleScroll', () => handleScrollToggle(context)),
        vscode.commands.registerCommand('auto-accept.openSettings', () => openSettings(context)),
        vscode.commands.registerCommand('auto-accept.updateFrequency', (value) => handleFrequencyUpdate(context, value)),
        vscode.commands.registerCommand('auto-accept.updateBannedCommands', (cmds) => handleBannedCommandsUpdate(context, cmds)),
        vscode.commands.registerCommand('auto-accept.updateClickPatterns', (data) => handleClickPatternsUpdate(context, data)),
        vscode.commands.registerCommand('auto-accept.updateScrollConfig', (cfg) => handleScrollConfigUpdate(context, cfg)),
        vscode.commands.registerCommand('auto-accept.getROIStats', () => getFormattedROIStats()),
        vscode.commands.registerCommand('auto-accept.getSessionHistory', () => sessionHistory),
        vscode.commands.registerCommand('auto-accept.support', () => {
            vscode.env.openExternal(vscode.Uri.parse(SUPPORT_URL));
        }),
        vscode.commands.registerCommand('auto-accept.updateSchedule', (cfg) => handleScheduleUpdate(context, cfg)),
        vscode.commands.registerCommand('auto-accept.toggleSmartFrequency', () => handleSmartFrequencyToggle(context)),
        vscode.commands.registerCommand('auto-accept.toggleSmartAccept', () => handleSmartAcceptToggle(context)),
        vscode.commands.registerCommand('auto-accept.updateSmartRules', (rules) => handleSmartRulesUpdate(context, rules)),
        vscode.commands.registerCommand('auto-accept.clearHistory', () => { sessionHistory = []; context.workspaceState.update('auto-accept-session-history', []); }),
        vscode.commands.registerCommand('auto-accept.toggleSafeClick', () => handleSafeClickToggle(context)),
        vscode.commands.registerCommand('auto-accept.toggleDiffProtection', () => handleDiffProtectionToggle(context))
    );

    // ─── Per-Window State ─────────────────────────────────────────
    log(`Window state: enabled=${isEnabled}, bg=${isBackgroundMode}`);

    // Start polling if was enabled previously
    if (isEnabled) {
        sessionClicksAtStart = roiStats.clicks;
        sessionBlockedAtStart = roiStats.blocked;
        startPolling(context);
    }

    // ─── Smart Frequency: Activity Tracking ─────────────────────
    if (smartFrequencyEnabled) startActivityTracking(context);

    // ─── Auto-Schedule ──────────────────────────────────────────
    if (scheduleEnabled) startScheduleTimer(context);

    // ─── HTTP Live Sync Server ──────────────────────────────────
    startHttpServer();

    // Weekly ROI notifications
    scheduleWeeklyROI(context);

    log('Extension activated successfully');
}

// ─── Toggle ON/OFF ───────────────────────────────────────────────────
async function handleToggle(context) {
    // Guard against rapid double-clicks
    if (isToggling) return;
    isToggling = true;

    try {
        isEnabled = !isEnabled;
        await context.workspaceState.update('auto-accept-isEnabled', isEnabled);

        // Update UI immediately so user sees feedback
        updateStatusBar();

        if (isEnabled) {
            roiStats.sessions++;
            roiStats.sessionsThisWeek++;
            sessionClicksAtStart = roiStats.clicks;
            sessionBlockedAtStart = roiStats.blocked;
            saveROIStats(context);
            await startPolling(context);
            log('Enabled');
            vscode.window.showInformationMessage('Auto Accept Pro: ON ✅');
        } else {
            // Show session summary before stopping
            const sessionClicks = roiStats.clicks - sessionClicksAtStart;
            const sessionBlocked = roiStats.blocked - sessionBlockedAtStart;

            // MUST await — stops command polling, leader election, AND CDP (kills injected scripts)
            await stopPolling();
            log('Disabled');

            if (sessionClicks > 0 || sessionBlocked > 0) {
                const timeSaved = sessionClicks * SECONDS_PER_CLICK;
                const timeStr = timeSaved >= 60 ? `${Math.round(timeSaved / 60)}m` : `${timeSaved}s`;
                vscode.window.showInformationMessage(
                    `Auto Accept Pro: OFF ⏹️ — This session: ${sessionClicks} accepts, ${sessionBlocked} blocked, ~${timeStr} saved`
                );
            } else {
                vscode.window.showInformationMessage('Auto Accept Pro: OFF ⏹️');
            }
        }
    } finally {
        isToggling = false;
    }
}

// ─── BG Mode Lock File ───────────────────────────────────────────────
function acquireBGLock() {
    try {
        if (!fs.existsSync(BG_LOCK_DIR)) fs.mkdirSync(BG_LOCK_DIR, { recursive: true });
        // Check if another window holds the lock
        if (fs.existsSync(BG_LOCK_FILE)) {
            const existing = fs.readFileSync(BG_LOCK_FILE, 'utf8').trim();
            const existingPid = parseInt(existing.split('-')[0], 10);
            // If the process is still alive, lock is valid
            try { process.kill(existingPid, 0); return false; } catch (e) { /* process dead, stale lock */ }
        }
        fs.writeFileSync(BG_LOCK_FILE, WINDOW_ID, 'utf8');
        log(`BG lock acquired: ${WINDOW_ID}`);
        return true;
    } catch (e) {
        log(`BG lock error: ${e.message}`);
        return false;
    }
}

function releaseBGLock() {
    try {
        if (fs.existsSync(BG_LOCK_FILE)) {
            const owner = fs.readFileSync(BG_LOCK_FILE, 'utf8').trim();
            if (owner === WINDOW_ID) {
                fs.unlinkSync(BG_LOCK_FILE);
                log('BG lock released');
            }
        }
    } catch (e) { /* ignore */ }
}

function isBGLockOwner() {
    try {
        if (!fs.existsSync(BG_LOCK_FILE)) return false;
        return fs.readFileSync(BG_LOCK_FILE, 'utf8').trim() === WINDOW_ID;
    } catch (e) { return false; }
}

// ─── Background Mode Toggle ─────────────────────────────────────────
async function handleBackgroundToggle(context) {
    if (!isEnabled) {
        vscode.window.showWarningMessage('Auto Accept Pro: Please enable the extension first (click the status bar).');
        return;
    }

    if (!isBackgroundMode) {
        // Trying to ENABLE BG mode — check lock
        if (!acquireBGLock()) {
            vscode.window.showWarningMessage(
                'Auto Accept Pro: Background Mode is already running in another window. Only one window can run BG mode at a time.'
            );
            return;
        }
    }

    isBackgroundMode = !isBackgroundMode;
    await context.workspaceState.update('auto-accept-backgroundMode', isBackgroundMode);

    // Release lock when turning OFF
    if (!isBackgroundMode) {
        releaseBGLock();
    }

    // Remove overlay BEFORE stopping CDP (need active connection to evaluate JS)
    if (!isBackgroundMode && cdpHandler && cdpHandler.hideBackgroundOverlay) {
        await cdpHandler.hideBackgroundOverlay().catch(() => { });
    }

    // Restart CDP session with updated mode (SimplePoll vs Background)
    await stopCDPSession();
    await startCDPSession(context);

    if (isBackgroundMode) {
        vscode.window.showInformationMessage('Auto Accept Pro: Background Mode ON 🔄');
    } else {
        vscode.window.showInformationMessage('Auto Accept Pro: Background Mode OFF');
    }

    updateStatusBar();
}

// ─── Frequency Update ────────────────────────────────────────────────
async function handleFrequencyUpdate(context, value) {
    const freq = parseInt(value, 10);
    if (isNaN(freq) || freq < 200 || freq > 3000) return;

    pollFrequency = freq;
    await context.globalState.update('auto-accept-frequency', pollFrequency);
    log(`Frequency updated to ${pollFrequency}ms`);

    // Restart polling with new frequency
    if (isEnabled && commandPollTimer) {
        stopCommandPolling();
        startCommandPolling(context);
    }
}

// ─── Banned Commands Update ──────────────────────────────────────────
async function handleBannedCommandsUpdate(context, commands) {
    if (Array.isArray(commands)) {
        bannedCommands = commands;
    } else if (typeof commands === 'string') {
        bannedCommands = commands.split('\n').map(c => c.trim()).filter(c => c.length > 0);
    }

    await context.globalState.update('auto-accept-banned-commands', bannedCommands);
    log(`Banned commands updated: ${bannedCommands.length} patterns`);

    // Push to CDP if active
    if (cdpHandler && cdpHandler.isConnected()) {
        await cdpHandler.updateBannedCommands(bannedCommands);
    }
}

// ─── Scroll Toggle ───────────────────────────────────────────────────
async function handleScrollToggle(context) {
    isScrollEnabled = !isScrollEnabled;
    await context.workspaceState.update('auto-accept-scrollEnabled', isScrollEnabled);
    updateStatusBar();
    log(`Scroll: ${isScrollEnabled ? 'ON' : 'OFF'}`);
}

// ─── Click Patterns Update ───────────────────────────────────────────
async function handleClickPatternsUpdate(context, data) {
    if (data.patterns) clickPatterns = data.patterns;
    if (data.disabled) disabledClickPatterns = data.disabled;
    await context.globalState.update('auto-accept-click-patterns', clickPatterns);
    await context.globalState.update('auto-accept-disabled-patterns', disabledClickPatterns);
    log(`Click patterns: ${clickPatterns.length} active, ${disabledClickPatterns.length} disabled`);
}

// ─── Scroll Config Update ────────────────────────────────────────────
async function handleScrollConfigUpdate(context, cfg) {
    if (cfg.pauseMs !== undefined) { scrollPauseMs = cfg.pauseMs; await context.globalState.update('auto-accept-scroll-pause', scrollPauseMs); }
    if (cfg.intervalMs !== undefined) { scrollIntervalMs = cfg.intervalMs; await context.globalState.update('auto-accept-scroll-interval', scrollIntervalMs); }
    log(`Scroll config: pause=${scrollPauseMs}ms, interval=${scrollIntervalMs}ms`);
}

// ─── Safe Click Toggle ───────────────────────────────────────────────
async function handleSafeClickToggle(context) {
    safeClickEnabled = !safeClickEnabled;
    await context.globalState.update('auto-accept-safe-click', safeClickEnabled);
    log(`Safe Click: ${safeClickEnabled ? 'ON' : 'OFF'}`);
}

// ─── Diff Protection Toggle ──────────────────────────────────────────
async function handleDiffProtectionToggle(context) {
    diffProtectionEnabled = !diffProtectionEnabled;
    await context.globalState.update('auto-accept-diff-protection', diffProtectionEnabled);
    log(`Diff Protection: ${diffProtectionEnabled ? 'ON' : 'OFF'}`);
}

// ─── HTTP Live Sync Server ───────────────────────────────────────────
function startHttpServer() {
    if (httpServer) return;

    const handler = (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET');
        res.setHeader('Content-Type', 'application/json');
        const activePatterns = clickPatterns.filter(p => !disabledClickPatterns.includes(p));
        res.writeHead(200);
        res.end(JSON.stringify({
            enabled: isEnabled,
            scrollEnabled: isScrollEnabled,
            clickPatterns: activePatterns,
            pauseScrollMs: scrollPauseMs,
            scrollIntervalMs: scrollIntervalMs,
            clickIntervalMs: pollFrequency,
            smartAcceptEnabled: smartAcceptEnabled,
            safeClickEnabled: safeClickEnabled,
            diffProtectionEnabled: diffProtectionEnabled
        }));
    };

    // Try ports in range until one binds
    function tryPort(portOffset) {
        if (portOffset >= AG_HTTP_PORT_RANGE) {
            log(`HTTP server: all ${AG_HTTP_PORT_RANGE} ports busy (${AG_HTTP_PORT_BASE}–${AG_HTTP_PORT_BASE + AG_HTTP_PORT_RANGE - 1})`);
            return;
        }
        const port = AG_HTTP_PORT_BASE + portOffset;
        httpServer = http.createServer(handler);
        httpServer.on('error', () => {
            log(`HTTP port ${port} busy, trying next...`);
            httpServer = null;
            tryPort(portOffset + 1);
        });
        httpServer.listen(port, '127.0.0.1', () => {
            httpBoundPort = port;
            log(`HTTP server started on port ${port}`);
        });
    }

    try {
        tryPort(0);
    } catch (e) {
        log(`HTTP server failed: ${e.message}`);
    }
}

function stopHttpServer() {
    if (httpServer) {
        httpServer.close();
        httpServer = null;
    }
}

// ─── Polling System ──────────────────────────────────────────────────
async function startPolling(context) {
    startCommandPolling(context);
    // Each window independently starts its own CDP session
    await startCDPSession(context);
    log('Polling started (commands + CDP)');
}

async function stopPolling() {
    stopCommandPolling();
    await stopCDPSession();
    log('Polling stopped');
}

// ─── Session History ─────────────────────────────────────────────────
function addHistoryEntry(action, source, detail) {
    const entry = {
        timestamp: new Date().toISOString(),
        action, // 'accept' | 'block' | 'warn'
        source, // 'native' | 'cdp' | 'schedule' | 'smart'
        detail
    };
    sessionHistory.unshift(entry);
    if (sessionHistory.length > MAX_HISTORY) sessionHistory.pop();
    // Persist last 100
    if (globalContext) {
        globalContext.workspaceState.update('auto-accept-session-history', sessionHistory.slice(0, 100));
    }
}

// ─── Smart Frequency ─────────────────────────────────────────────────
function startActivityTracking(context) {
    if (activityAdaptTimer) return;

    // Track text document changes as activity
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(() => {
            activityTimestamps.push(Date.now());
        }),
        vscode.window.onDidChangeActiveTextEditor(() => {
            activityTimestamps.push(Date.now());
        })
    );

    activityAdaptTimer = setInterval(() => {
        if (!isEnabled || !smartFrequencyEnabled) return;
        adaptFrequency();
    }, ACTIVITY_ADAPT_INTERVAL);
}

function stopActivityTracking() {
    if (activityAdaptTimer) {
        clearInterval(activityAdaptTimer);
        activityAdaptTimer = null;
    }
}

function adaptFrequency() {
    const now = Date.now();
    // Clean old timestamps
    activityTimestamps = activityTimestamps.filter(t => now - t < 30000);

    const recentCount = activityTimestamps.filter(t => now - t < ACTIVITY_WINDOW_MS).length;
    let newFreq, newTier;

    if (recentCount > 10) {
        newFreq = FREQ_FAST; newTier = 'FAST';
    } else if (recentCount > 3) {
        newFreq = FREQ_NORMAL; newTier = 'NORMAL';
    } else if (activityTimestamps.length > 0) {
        newFreq = FREQ_SLOW; newTier = 'SLOW';
    } else {
        newFreq = FREQ_IDLE; newTier = 'IDLE';
    }

    if (newTier !== currentFrequencyTier) {
        currentFrequencyTier = newTier;
        pollFrequency = newFreq;
        log(`Smart Frequency: ${newTier} (${newFreq}ms)`);
        // Restart command polling with new frequency
        if (commandPollTimer) {
            stopCommandPolling();
            startCommandPolling(globalContext);
        }
    }
}

async function handleSmartFrequencyToggle(context) {
    smartFrequencyEnabled = !smartFrequencyEnabled;
    await context.globalState.update('auto-accept-smart-frequency', smartFrequencyEnabled);
    if (smartFrequencyEnabled) {
        startActivityTracking(context);
        log('Smart Frequency: ON');
    } else {
        stopActivityTracking();
        currentFrequencyTier = 'NORMAL';
        pollFrequency = context.globalState.get('auto-accept-frequency', DEFAULT_POLL_FREQUENCY);
        if (commandPollTimer) { stopCommandPolling(); startCommandPolling(context); }
        log('Smart Frequency: OFF');
    }
}

// ─── Auto-Schedule ───────────────────────────────────────────────────
function startScheduleTimer(context) {
    if (scheduleTimer) return;
    // Check immediately
    checkSchedule(context);
    // Then every 60s
    scheduleTimer = setInterval(() => checkSchedule(context), 60000);
}

function stopScheduleTimer() {
    if (scheduleTimer) {
        clearInterval(scheduleTimer);
        scheduleTimer = null;
    }
}

function checkSchedule(context) {
    if (!scheduleEnabled) return;
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const [startH, startM] = scheduleStart.split(':').map(Number);
    const [endH, endM] = scheduleEnd.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    let inRange;
    if (startMinutes <= endMinutes) {
        // Same day range (e.g. 09:00-17:00)
        inRange = currentMinutes >= startMinutes && currentMinutes < endMinutes;
    } else {
        // Overnight range (e.g. 23:00-07:00)
        inRange = currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }

    if (inRange && !isEnabled) {
        isEnabled = true;
        enabledBySchedule = true;
        context.workspaceState.update('auto-accept-isEnabled', true);
        startPolling(context);
        updateStatusBar();
        addHistoryEntry('accept', 'schedule', `Schedule auto-enabled (${scheduleStart}-${scheduleEnd})`);
        log(`Schedule: Auto-enabled (${scheduleStart}-${scheduleEnd})`);
        vscode.window.showInformationMessage(`Auto Accept Pro: Schedule ON ⏰ (${scheduleStart}-${scheduleEnd})`);
    } else if (!inRange && isEnabled && enabledBySchedule) {
        isEnabled = false;
        enabledBySchedule = false;
        context.workspaceState.update('auto-accept-isEnabled', false);
        stopPolling();
        updateStatusBar();
        addHistoryEntry('accept', 'schedule', `Schedule auto-disabled (outside ${scheduleStart}-${scheduleEnd})`);
        log(`Schedule: Auto-disabled (outside ${scheduleStart}-${scheduleEnd})`);
        vscode.window.showInformationMessage('Auto Accept Pro: Schedule OFF ⏰');
    }
}

async function handleScheduleUpdate(context, cfg) {
    if (cfg.enabled !== undefined) { scheduleEnabled = cfg.enabled; await context.globalState.update('auto-accept-schedule-enabled', scheduleEnabled); }
    if (cfg.start) { scheduleStart = cfg.start; await context.globalState.update('auto-accept-schedule-start', scheduleStart); }
    if (cfg.end) { scheduleEnd = cfg.end; await context.globalState.update('auto-accept-schedule-end', scheduleEnd); }
    if (scheduleEnabled) { startScheduleTimer(context); } else { stopScheduleTimer(); enabledBySchedule = false; }
    log(`Schedule updated: enabled=${scheduleEnabled}, ${scheduleStart}-${scheduleEnd}`);
}

// ─── Smart Accept ────────────────────────────────────────────────────
async function handleSmartAcceptToggle(context) {
    smartAcceptEnabled = !smartAcceptEnabled;
    await context.globalState.update('auto-accept-smart-accept', smartAcceptEnabled);
    log(`Smart Accept: ${smartAcceptEnabled ? 'ON' : 'OFF'}`);
}

async function handleSmartRulesUpdate(context, rules) {
    if (Array.isArray(rules)) {
        smartRules = rules;
        await context.globalState.update('auto-accept-smart-rules', smartRules);
        log(`Smart Rules updated: ${smartRules.length} rules`);
    }
}

function startCommandPolling(context) {
    if (commandPollTimer) return;

    // Fire immediately once
    executeAcceptCommandsForIDE();

    // Hybrid mode: poll faster when CDP unavailable for better responsiveness
    const interval = isCDPConnected ? pollFrequency : Math.max(pollFrequency, 800);
    commandPollTimer = setInterval(() => {
        if (!isEnabled) return;
        executeAcceptCommandsForIDE();
    }, interval);
}

function stopCommandPolling() {
    if (commandPollTimer) {
        clearInterval(commandPollTimer);
        commandPollTimer = null;
    }
}

// ─── Hybrid Fallback Commands ────────────────────────────────────────
// Extended command sets fired when CDP is unavailable
const HYBRID_FALLBACK_COMMANDS_ANTIGRAVITY = [
    'antigravity.agent.acceptAgentStep',
    'antigravity.command.accept',
    'antigravity.prioritized.agentAcceptAllInFile',
    'antigravity.prioritized.agentAcceptFocusedHunk',
    'antigravity.prioritized.supercompleteAccept',
    'antigravity.terminalCommand.accept',
    'antigravity.acceptCompletion',
    'antigravity.prioritized.terminalSuggestion.accept',
    'antigravity.acceptEdit',
    'editor.action.acceptInlineSuggestion',
    // Extra dialog-style commands for fallback
    'antigravity.prioritized.agentApprove',
    'antigravity.agent.runCommand',
    'antigravity.agent.approveAgentStep',
];

const HYBRID_FALLBACK_COMMANDS_CURSOR = [
    'cursorai.action.acceptAndRunGenerateInTerminal',
    'cursorai.action.acceptGenerateInTerminal',
    'cursorAcceptInlineSuggestion',
    'editor.action.acceptInlineSuggestion',
    'aipopup.action.accept',
    // Extra dialog-style commands for fallback
    'cursorai.action.acceptEdit',
    'cursorai.action.acceptAllEdits',
];

function getHybridFallbackCommands() {
    if (currentIDE === 'cursor') return HYBRID_FALLBACK_COMMANDS_CURSOR;
    if (currentIDE === 'windsurf') return ACCEPT_COMMANDS_WINDSURF;
    return HYBRID_FALLBACK_COMMANDS_ANTIGRAVITY;
}

// ─── Accept Commands ─────────────────────────────────────────────────
function executeAcceptCommandsForIDE() {
    // Guard: only fire accept commands if user has an 'Accept' pattern enabled
    const activePatterns = clickPatterns.filter(p => !disabledClickPatterns.includes(p));
    const wantsAccept = activePatterns.some(p => p.toLowerCase().includes('accept'));
    if (!wantsAccept) return;

    // Hybrid mode: use extended command set when CDP is unavailable
    const commands = isCDPConnected ? getAcceptCommandsForIDE() : getHybridFallbackCommands();
    // Fire all in parallel, silently fail if command doesn't exist
    Promise.allSettled(commands.map(cmd => vscode.commands.executeCommand(cmd))).catch(() => { });
}

// ─── CDP Integration ─────────────────────────────────────────────────
async function checkCDPAvailable() {
    try {
        const available = await cdpHandler.scanForDebugPort();
        return available;
    } catch (e) {
        log(`CDP check failed: ${e.message}`);
        return false;
    }
}

async function startCDPSession(context) {
    try {
        const activePatterns = clickPatterns.filter(p => !disabledClickPatterns.includes(p));
        const config = {
            ide: currentIDE,
            isBackgroundMode: isBackgroundMode,
            pollInterval: pollFrequency,
            bannedCommands: bannedCommands,
            smartRules: smartRules,
            smartAcceptEnabled: smartAcceptEnabled,
            clickPatterns: activePatterns,
            scrollEnabled: isScrollEnabled,
            scrollPauseMs: scrollPauseMs,
            scrollIntervalMs: scrollIntervalMs,
            safeClickEnabled: safeClickEnabled,
            diffProtectionEnabled: diffProtectionEnabled
        };

        await cdpHandler.start(config);
        isCDPConnected = true;
        stopCDPRetry(); // Connected — no need to retry
        startCDPSync(context);
        log('CDP session started (full mode)');
        updateStatusBar();
    } catch (e) {
        isCDPConnected = false;
        log(`CDP unavailable: ${e.message} — running in Hybrid fallback mode`);
        updateStatusBar();

        // Restart command polling with enhanced fallback commands
        stopCommandPolling();
        startCommandPolling(context);

        // Start auto-retry timer to reconnect CDP in background
        startCDPRetry(context);

        // Only show error on FIRST attempt (not during auto-retry)
        if (!cdpRetryTimer) {
            vscode.window.showWarningMessage(
                'Auto Accept Pro: CDP unavailable — running in Hybrid mode (VS Code commands only). For full button-clicking, enable --remote-debugging-port.',
                'Show Setup Guide', 'Dismiss'
            ).then(choice => {
                if (choice === 'Show Setup Guide' && relauncher) {
                    relauncher.showSetupPanel();
                }
            });
        }
    }
}

// ─── CDP Auto-Retry ──────────────────────────────────────────────────
function startCDPRetry(context) {
    if (cdpRetryTimer) return;
    cdpRetryTimer = setInterval(async () => {
        if (!isEnabled || isCDPConnected) { stopCDPRetry(); return; }
        log('CDP auto-retry: attempting reconnect...');
        try {
            const activePatterns = clickPatterns.filter(p => !disabledClickPatterns.includes(p));
            await cdpHandler.start({
                ide: currentIDE,
                isBackgroundMode: isBackgroundMode,
                pollInterval: pollFrequency,
                bannedCommands: bannedCommands,
                smartRules: smartRules,
                smartAcceptEnabled: smartAcceptEnabled,
                clickPatterns: activePatterns,
                scrollEnabled: isScrollEnabled,
                scrollPauseMs: scrollPauseMs,
                scrollIntervalMs: scrollIntervalMs,
                safeClickEnabled: safeClickEnabled,
                diffProtectionEnabled: diffProtectionEnabled
            });
            isCDPConnected = true;
            stopCDPRetry();
            startCDPSync(context);
            // Switch command polling back to normal frequency
            stopCommandPolling();
            startCommandPolling(context);
            log('CDP auto-retry: reconnected successfully! Full mode restored.');
            vscode.window.showInformationMessage('Auto Accept Pro: CDP reconnected ✅ Full mode restored.');
            updateStatusBar();
        } catch (e) {
            log(`CDP auto-retry: still unavailable — ${e.message}`);
        }
    }, CDP_RETRY_INTERVAL);
}

function stopCDPRetry() {
    if (cdpRetryTimer) { clearInterval(cdpRetryTimer); cdpRetryTimer = null; }
}

async function stopCDPSession() {
    try {
        await cdpHandler.stop();
        stopCDPSync();
        stopCDPRetry();
        isCDPConnected = false;
        log('CDP session stopped');
    } catch (e) {
        log(`Failed to stop CDP session: ${e.message}`);
    }
}

function startCDPSync(context) {
    if (cdpSyncTimer) return;

    cdpSyncTimer = setInterval(async () => {
        if (!isEnabled) return;

        try {
            // Use getAndResetStats to avoid double-counting
            const stats = await cdpHandler.getAndResetStats();
            if (stats) {
                const deltaClicks = stats.clicks || 0;
                const deltaBlocked = stats.blocked || 0;

                if (deltaClicks > 0 || deltaBlocked > 0) {
                    roiStats.clicks = (roiStats.clicks || 0) + deltaClicks;
                    roiStats.clicksThisWeek = (roiStats.clicksThisWeek || 0) + deltaClicks;
                    roiStats.blocked = (roiStats.blocked || 0) + deltaBlocked;
                    roiStats.blockedThisWeek = (roiStats.blockedThisWeek || 0) + deltaBlocked;
                    saveROIStats(context);
                    log(`Stats collected: +${deltaClicks} clicks, +${deltaBlocked} blocked`);
                }
            }
        } catch (e) {
            // Stats retrieval failed, not critical
        }
    }, 5000);
}

function stopCDPSync() {
    if (cdpSyncTimer) {
        clearInterval(cdpSyncTimer);
        cdpSyncTimer = null;
    }
}

// ─── Away Mode ───────────────────────────────────────────────────────
async function getAwayActions() {
    if (!cdpHandler || !cdpHandler.isConnected()) return 0;
    try {
        const stats = await cdpHandler.getAndResetStats();
        return (stats && stats.clicks) || 0;
    } catch (e) {
        return 0;
    }
}

// ─── Status Bar Updates ──────────────────────────────────────────────
function updateStatusBar() {
    // Accept item — show CDP status
    if (isEnabled) {
        const cdpLabel = isCDPConnected ? '' : ' (Hybrid)';
        statusBarToggle.text = `$(check) Accept ON${cdpLabel}`;
        statusBarToggle.tooltip = isCDPConnected
            ? 'Auto Accept Pro: ✅ ON (CDP connected)\nClick to disable'
            : 'Auto Accept Pro: ✅ ON (Hybrid — CDP unavailable)\nUsing VS Code commands as fallback\nClick to disable';
        statusBarToggle.color = isCDPConnected ? '#4EC9B0' : '#DCDCAA';
        statusBarToggle.backgroundColor = undefined;
    } else {
        statusBarToggle.text = '$(circle-slash) Accept OFF';
        statusBarToggle.tooltip = 'Auto Accept Pro: ❌ OFF\nClick to enable';
        statusBarToggle.color = '#F44747';
        statusBarToggle.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }
    statusBarToggle.show();

    // Scroll item
    if (isScrollEnabled) {
        statusBarScroll.text = '$(check) Scroll ON';
        statusBarScroll.tooltip = 'Auto Scroll: ✅ ON\nClick to toggle';
        statusBarScroll.color = '#4EC9B0';
        statusBarScroll.backgroundColor = undefined;
    } else {
        statusBarScroll.text = '$(circle-slash) Scroll OFF';
        statusBarScroll.tooltip = 'Auto Scroll: ❌ OFF\nClick to toggle';
        statusBarScroll.color = '#F44747';
        statusBarScroll.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }
    statusBarScroll.show();

    // BG Mode item (only when enabled)
    if (isEnabled) {
        if (isBackgroundMode) {
            statusBarBackground.text = '$(pass-filled) BG';
            statusBarBackground.color = '#4EC9B0';
            statusBarBackground.backgroundColor = undefined;
        } else {
            statusBarBackground.text = '$(circle-slash) BG';
            statusBarBackground.color = undefined;
            statusBarBackground.backgroundColor = undefined;
        }
        statusBarBackground.show();
    } else {
        statusBarBackground.hide();
    }

    statusBarSettings.show();
}

// ─── Settings Panel ──────────────────────────────────────────────────
function openSettings(context) {
    try {
        const { SettingsPanel } = require('./settings-panel');
        const extensionUri = context.extensionUri;
        SettingsPanel.createOrShow(extensionUri, context);
    } catch (e) {
        log(`Failed to open settings: ${e.message}`);
        vscode.window.showErrorMessage('Auto Accept Pro: Failed to open settings panel.');
    }
}

// ─── ROI Stats ───────────────────────────────────────────────────────
function loadROIStats(context) {
    const saved = context.globalState.get('auto-accept-roi-stats');
    if (saved) {
        roiStats = { ...roiStats, ...saved };
    }
    // Check if we need to reset weekly stats
    const now = new Date();
    const weekStart = getWeekStart(now);
    if (!roiStats.weekStart || roiStats.weekStart !== weekStart.toISOString()) {
        roiStats.weekStart = weekStart.toISOString();
        roiStats.clicksThisWeek = 0;
        roiStats.blockedThisWeek = 0;
        roiStats.sessionsThisWeek = 0;
    }
}

function saveROIStats(context) {
    context.globalState.update('auto-accept-roi-stats', roiStats);
}

function getFormattedROIStats() {
    const timeSavedSeconds = (roiStats.clicksThisWeek || 0) * SECONDS_PER_CLICK;
    let timeSavedFormatted;
    if (timeSavedSeconds < 60) {
        timeSavedFormatted = `${timeSavedSeconds}s`;
    } else if (timeSavedSeconds < 3600) {
        timeSavedFormatted = `${Math.round(timeSavedSeconds / 60)}m`;
    } else {
        timeSavedFormatted = `${(timeSavedSeconds / 3600).toFixed(1)}h`;
    }

    return {
        clicks: roiStats.clicks || 0,
        blocked: roiStats.blocked || 0,
        sessions: roiStats.sessions || 0,
        clicksThisWeek: roiStats.clicksThisWeek || 0,
        blockedThisWeek: roiStats.blockedThisWeek || 0,
        sessionsThisWeek: roiStats.sessionsThisWeek || 0,
        timeSavedFormatted
    };
}

function getWeekStart(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday start
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d;
}

function scheduleWeeklyROI(context) {
    // Check every hour for weekly summary
    weeklyROITimer = setInterval(() => {
        const now = new Date();
        if (now.getDay() === 1 && now.getHours() === 9 && now.getMinutes() < 5) {
            if (roiStats.clicksThisWeek > 0) {
                const stats = getFormattedROIStats();
                vscode.window.showInformationMessage(
                    `Auto Accept Pro Weekly: ${stats.clicksThisWeek} accepts, ${stats.sessionsThisWeek} sessions, ${stats.blockedThisWeek} blocked, ~${stats.timeSavedFormatted} saved`
                );
            }
        }
    }, 60 * 60 * 1000); // Every hour
}

// ─── Deactivation ────────────────────────────────────────────────────
async function deactivate() {
    log('Deactivating extension...');
    releaseBGLock(); // Release BG lock before shutdown
    stopActivityTracking();
    stopScheduleTimer();
    stopHttpServer();
    if (weeklyROITimer) { clearInterval(weeklyROITimer); weeklyROITimer = null; }
    await stopPolling(); // stopPolling already calls cdpHandler.stop()
    if (statusBarToggle) statusBarToggle.dispose();
    if (statusBarScroll) statusBarScroll.dispose();
    if (statusBarBackground) statusBarBackground.dispose();
    if (statusBarSettings) statusBarSettings.dispose();
    if (outputChannel) outputChannel.dispose();
}

module.exports = { activate, deactivate };
