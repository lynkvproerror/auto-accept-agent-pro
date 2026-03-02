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
// CDP port is configured in cdp-handler.js (BASE_PORT = 9222)
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
const DEFAULT_CLICK_PATTERNS = ['Run', 'Allow', 'Always Allow', 'Keep Waiting', 'Retry', 'Continue', 'Allow Once', 'Allow This Con', 'Accept all', 'Accept'];
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
    'antigravity.terminalCommand.run',          // ← KEY: triggers Run (Alt+Enter) button
    'antigravity.acceptCompletion',
    'antigravity.prioritized.terminalSuggestion.accept',
    'antigravity.acceptEdit',
    'editor.action.acceptInlineSuggestion'
];

const ACCEPT_COMMANDS_CURSOR = [
    'cursorai.action.acceptGenerateInTerminal',
    'cursorAcceptInlineSuggestion',
    'editor.action.acceptInlineSuggestion',
    'aipopup.action.accept'
    // NOTE: 'cursorai.action.acceptAndRunGenerateInTerminal' removed
    // — it triggers terminal execution (Docker checks, etc.)
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
let discoveredCommands = []; // Auto-discovered accept/run commands
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
let godModeEnabled = false; // God Mode: auto-accept "Always Allow" / "Allow This Conversation"

// HTTP Live Sync Server
let httpServer = null;
let httpBoundPort = null;  // actual port the server bound to

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
    let commands;
    if (ide === 'antigravity') commands = ACCEPT_COMMANDS_ANTIGRAVITY;
    else if (ide === 'cursor') commands = ACCEPT_COMMANDS_CURSOR;
    else if (ide === 'windsurf' || ide === 'trae') commands = ACCEPT_COMMANDS_WINDSURF;
    else commands = ACCEPT_COMMANDS_FALLBACK;
    // Merge discovered commands (deduplicated)
    const all = [...new Set([...commands, ...discoveredCommands])];
    return all;
}

// ─── Auto-Discover Accept Commands ───────────────────────────────────
async function discoverCommands() {
    try {
        const allCommands = await vscode.commands.getCommands(true);
        const ide = currentIDE;

        // Patterns to match per IDE
        const searchPatterns = {
            antigravity: ['antigravity'],
            cursor: ['cursor', 'aipopup'],
            windsurf: ['cascade'],
            trae: ['trae'],
            code: []
        };
        const prefixes = searchPatterns[ide] || [];

        // Log ALL commands matching IDE prefix for diagnostic
        const allIdeCommands = allCommands.filter(cmd => {
            const lower = cmd.toLowerCase();
            return prefixes.some(p => lower.includes(p));
        });
        if (allIdeCommands.length > 0) {
            log(`[Diagnostic] ALL ${ide} commands found (${allIdeCommands.length}):`);
            allIdeCommands.forEach(cmd => log(`  → ${cmd}`));
        }

        // Action keywords that indicate SAFE accept commands (can fire repeatedly)
        // NOTE: 'run' and 'execute' are EXCLUDED — they trigger side effects
        const actionKeywords = ['accept', 'apply', 'confirm'];

        const found = allCommands.filter(cmd => {
            const lower = cmd.toLowerCase();
            // Must match IDE prefix
            if (!prefixes.some(p => lower.includes(p))) return false;
            // Must contain an action keyword
            if (!actionKeywords.some(k => lower.includes(k))) return false;
            // Skip if already in hardcoded list
            if (getAcceptCommandsForIDE().includes(cmd)) return false;
            return true;
        });

        if (found.length > 0) {
            discoveredCommands = found;
            log(`Discovered ${found.length} additional commands: ${found.join(', ')}`);
        } else {
            log('No additional commands discovered');
        }

    } catch (e) {
        log(`Command discovery failed: ${e.message}`);
    }
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

    // Discover additional accept/run commands available in this IDE
    discoverCommands().then(() => {
        const total = getAcceptCommandsForIDE().length;
        log(`Total accept/run commands: ${total}`);
    });
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
    godModeEnabled = context.globalState.get('auto-accept-god-mode', false);
    loadROIStats(context);
    sessionHistory = context.workspaceState.get('auto-accept-session-history', []);

    // Initialize CDP handler and Relauncher
    cdpHandler = new CdpHandler(msg => log(msg));
    relauncher = new Relauncher(msg => log(msg));

    // ─── Status Bar — right-aligned, grouped together ─────────────
    statusBarToggle = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -100);
    statusBarToggle.command = 'auto-accept.toggle';
    statusBarToggle.tooltip = 'Click to toggle Auto Accept Pro';
    context.subscriptions.push(statusBarToggle);



    statusBarBackground = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -102);
    statusBarBackground.command = 'auto-accept.toggleBackground';
    statusBarBackground.tooltip = 'Click to toggle Background Mode';
    context.subscriptions.push(statusBarBackground);

    statusBarSettings = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -103);
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
        vscode.commands.registerCommand('auto-accept.toggleDiffProtection', () => handleDiffProtectionToggle(context)),
        vscode.commands.registerCommand('auto-accept.toggleGodMode', () => handleGodModeToggle(context)),
        vscode.commands.registerCommand('auto-accept.autoFixCDP', () => autoFixCDPShortcut())
    );

    // ─── Per-Window State ─────────────────────────────────────────
    log(`Window state: enabled=${isEnabled}, bg=${isBackgroundMode}`);

    // Start polling if was enabled previously (with delay on restart to prevent error loops)
    if (isEnabled) {
        sessionClicksAtStart = roiStats.clicks;
        sessionBlockedAtStart = roiStats.blocked;
        log('Auto-resuming in 5s (was enabled before restart)...');
        setTimeout(() => {
            if (isEnabled) {
                startPolling(context);
                log('Auto-resumed after startup delay');
            }
        }, 5000);
    }

    // ─── Smart Frequency: Activity Tracking ─────────────────────
    if (smartFrequencyEnabled) startActivityTracking(context);

    // ─── Auto-Schedule ──────────────────────────────────────────
    if (scheduleEnabled) startScheduleTimer(context);

    // ─── HTTP Live Sync Server ──────────────────────────────────
    startHttpServer();

    // Weekly ROI notifications
    scheduleWeeklyROI(context);

    // ─── IDE Version Change Detection — Auto-Fix CDP Shortcut ─────
    // After IDE update, shortcuts may lose --remote-debugging-port=9222
    checkIDEVersionAndFixShortcut(context);

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

    // Re-inject with updated config
    if (isEnabled) { await stopCDPSession(); await startCDPSession(context); }
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

    // Toggle native scroll — note: scroll only works with CDP (DOM-level).
    // Native VS Code commands cannot safely target only the chat panel.

    // Re-inject with updated config
    if (isEnabled) { await stopCDPSession(); await startCDPSession(context); }
}

// ─── Click Patterns Update ───────────────────────────────────────────
async function handleClickPatternsUpdate(context, data) {
    if (data.patterns) clickPatterns = data.patterns;
    if (data.disabled) disabledClickPatterns = data.disabled;
    await context.globalState.update('auto-accept-click-patterns', clickPatterns);
    await context.globalState.update('auto-accept-disabled-patterns', disabledClickPatterns);
    log(`Click patterns: ${clickPatterns.length} active, ${disabledClickPatterns.length} disabled`);

    // Re-inject with updated config
    if (isEnabled) { await stopCDPSession(); await startCDPSession(context); }
}

// ─── Scroll Config Update ────────────────────────────────────────────
async function handleScrollConfigUpdate(context, cfg) {
    if (cfg.pauseMs !== undefined) { scrollPauseMs = cfg.pauseMs; await context.globalState.update('auto-accept-scroll-pause', scrollPauseMs); }
    if (cfg.intervalMs !== undefined) { scrollIntervalMs = cfg.intervalMs; await context.globalState.update('auto-accept-scroll-interval', scrollIntervalMs); }
    log(`Scroll config: pause=${scrollPauseMs}ms, interval=${scrollIntervalMs}ms`);

    // Re-inject with updated config
    if (isEnabled) { await stopCDPSession(); await startCDPSession(context); }
}

// ─── Safe Click Toggle ───────────────────────────────────────────────
async function handleSafeClickToggle(context) {
    safeClickEnabled = !safeClickEnabled;
    await context.globalState.update('auto-accept-safe-click', safeClickEnabled);
    log(`Conversation Guard: ${safeClickEnabled ? 'ON' : 'OFF'}`);

    // Re-inject with updated config
    if (isEnabled) { await stopCDPSession(); await startCDPSession(context); }
}

// ─── Diff Protection Toggle ──────────────────────────────────────────
async function handleDiffProtectionToggle(context) {
    diffProtectionEnabled = !diffProtectionEnabled;
    await context.globalState.update('auto-accept-diff-protection', diffProtectionEnabled);
    log(`Diff Protection: ${diffProtectionEnabled ? 'ON' : 'OFF'}`);

    // Re-inject with updated config
    if (isEnabled) { await stopCDPSession(); await startCDPSession(context); }
}

// ─── God Mode Toggle ─────────────────────────────────────────────────
async function handleGodModeToggle(context) {
    godModeEnabled = !godModeEnabled;
    await context.globalState.update('auto-accept-god-mode', godModeEnabled);
    log(`God Mode: ${godModeEnabled ? 'ON ⚠️' : 'OFF'}`);

    if (godModeEnabled) {
        vscode.window.showWarningMessage(
            '⚠️ God Mode ENABLED — "Always Allow" and "Allow This Conversation" will be auto-accepted. The agent can access files outside your workspace.'
        );
    } else {
        vscode.window.showInformationMessage('🛡️ God Mode DISABLED — folder access prompts require manual approval.');
    }

    // Re-inject with updated config
    if (isEnabled) { await stopCDPSession(); await startCDPSession(context); }
}

// ─── IDE Version Change Detection ────────────────────────────────────
// On IDE update, shortcuts are overwritten and lose --remote-debugging-port=9222
// This function detects the update and prompts the user to re-apply the fix
function checkIDEVersionAndFixShortcut(context) {
    if (process.platform !== 'win32') return; // Windows only

    const currentVersion = vscode.version;
    const storedVersion = context.globalState.get('auto-accept-ide-version', '');

    // Always store current version
    context.globalState.update('auto-accept-ide-version', currentVersion);

    if (!storedVersion) {
        // First run — just store version, don't auto-fix
        log(`[CDP Check] First run, storing IDE version: ${currentVersion}`);
        return;
    }

    if (storedVersion === currentVersion) {
        // Same version — no update happened
        return;
    }

    // IDE version changed! Check if shortcuts still have the flag
    log(`[CDP Check] IDE updated: ${storedVersion} → ${currentVersion}. Checking CDP shortcuts...`);

    const ideName = getIDEDisplayName();
    const psCheck = path.join(os.tmpdir(), 'antigravity_check_cdp.ps1');
    const psContent = `
$WshShell = New-Object -comObject WScript.Shell
$paths = @(
    "$env:USERPROFILE\\Desktop",
    "$env:PUBLIC\\Desktop",
    "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs",
    "$env:ALLUSERSPROFILE\\Microsoft\\Windows\\Start Menu\\Programs",
    "$env:APPDATA\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar",
    "$env:APPDATA\\Microsoft\\Internet Explorer\\Quick Launch"
)
$ideNames = @("Antigravity", "Cursor", "Windsurf", "Trae")
$needsFix = 0
$ok = 0
foreach ($dir in $paths) {
    if (-not (Test-Path $dir)) { continue }
    Get-ChildItem -Path $dir -Filter "*.lnk" -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            $s = $WshShell.CreateShortcut($_.FullName)
            $match = $false
            foreach ($name in $ideNames) {
                if ($s.TargetPath -like "*$name*" -or $_.Name -like "*$name*") { $match = $true; break }
            }
            if ($match) {
                if ($s.Arguments -like "*remote-debugging-port=9222*") { $ok++ }
                else { $needsFix++ }
            }
        } catch {}
    }
}
if ($needsFix -gt 0) { Write-Output "NEEDS_FIX:$needsFix" }
elseif ($ok -gt 0) { Write-Output "ALL_OK:$ok" }
else { Write-Output "NO_SHORTCUT" }
`;

    try {
        fs.writeFileSync(psCheck, psContent, 'utf8');
    } catch (e) {
        log(`[CDP Check] Failed to write check script: ${e.message}`);
        return;
    }

    const cp = require('child_process');
    cp.exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psCheck}"`, (err, stdout) => {
        try { fs.unlinkSync(psCheck); } catch (e) { }

        if (err) {
            log(`[CDP Check] Error: ${err.message}`);
            return;
        }

        const output = stdout.trim();
        log(`[CDP Check] Result: ${output}`);

        if (output.includes('NEEDS_FIX')) {
            // Shortcuts lost the flag after IDE update — prompt user
            const count = (output.match(/NEEDS_FIX:(\d+)/) || [])[1] || '1';
            vscode.window.showWarningMessage(
                `⚠️ ${ideName} đã cập nhật (${storedVersion} → ${currentVersion}). ${count} shortcut(s) cần patch lại --remote-debugging-port=9222 để Background Mode hoạt động.`,
                'Fix Now',
                'Later'
            ).then(action => {
                if (action === 'Fix Now') {
                    autoFixCDPShortcut();
                }
            });
        } else if (output.includes('ALL_OK')) {
            log(`[CDP Check] All shortcuts OK after IDE update.`);
        }
        // NO_SHORTCUT → silent, don't nag
    });
}

// ─── Auto-Fix CDP Shortcut (Windows) ─────────────────────────────────
async function autoFixCDPShortcut() {
    if (process.platform !== 'win32') {
        vscode.window.showInformationMessage('Auto-patching is Windows-only. Please add --remote-debugging-port=9222 to your launch command manually.');
        return;
    }

    const ideName = getIDEDisplayName();
    const psFile = path.join(os.tmpdir(), 'antigravity_patch_shortcut.ps1');
    // PowerShell: scans shortcuts, patches if flag missing, reports 3 outcomes
    const psContent = `
$flag = "--remote-debugging-port=9222"
$WshShell = New-Object -comObject WScript.Shell
$paths = @(
    "$env:USERPROFILE\\Desktop",
    "$env:PUBLIC\\Desktop",
    "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs",
    "$env:ALLUSERSPROFILE\\Microsoft\\Windows\\Start Menu\\Programs",
    "$env:APPDATA\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar",
    "$env:APPDATA\\Microsoft\\Internet Explorer\\Quick Launch"
)
$ideNames = @("Antigravity", "Cursor", "Windsurf", "Trae")
$patched = 0
$alreadyOk = 0
$found = 0
foreach ($dir in $paths) {
    if (-not (Test-Path $dir)) { continue }
    $files = Get-ChildItem -Path $dir -Filter "*.lnk" -Recurse -ErrorAction SilentlyContinue
    foreach ($file in $files) {
        try {
            $shortcut = $WshShell.CreateShortcut($file.FullName)
            $isIDE = $false
            foreach ($name in $ideNames) {
                if ($shortcut.TargetPath -like "*$name*" -or $file.Name -like "*$name*") {
                    $isIDE = $true; break
                }
            }
            if (-not $isIDE) { continue }
            $found++
            if ($shortcut.Arguments -like "*remote-debugging-port*") {
                if ($shortcut.Arguments -like "*remote-debugging-port=9222*") {
                    $alreadyOk++
                    Write-Output "ALREADY_OK: $($file.FullName)"
                } else {
                    $shortcut.Arguments = ($shortcut.Arguments -replace '--remote-debugging-port=\d+', $flag)
                    $shortcut.Save()
                    $patched++
                    Write-Output "PATCHED_PORT: $($file.FullName)"
                }
            } else {
                $shortcut.Arguments = ($shortcut.Arguments + " " + $flag).Trim()
                $shortcut.Save()
                $patched++
                Write-Output "PATCHED: $($file.FullName)"
            }
        } catch {
            Write-Output "ERROR: $($file.FullName) - $($_.Exception.Message)"
        }
    }
}
if ($patched -gt 0) { Write-Output "RESULT:PATCHED:$patched" }
elseif ($alreadyOk -gt 0) { Write-Output "RESULT:ALREADY_OK:$alreadyOk" }
else { Write-Output "RESULT:NOT_FOUND:0" }
`;

    try {
        fs.writeFileSync(psFile, psContent, 'utf8');
    } catch (e) {
        log(`Auto-Fix CDP: Failed to write script: ${e.message}`);
        vscode.window.showWarningMessage('Could not create patcher script. Please add the flag manually.');
        return;
    }

    log('Auto-Fix CDP: Running shortcut patcher...');
    const cp = require('child_process');
    cp.exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`, (err, stdout, stderr) => {
        try { fs.unlinkSync(psFile); } catch (e) { }

        if (err) {
            log(`Auto-Fix CDP: Error: ${err.message}`);
            vscode.window.showWarningMessage('Shortcut patching failed. Please add --remote-debugging-port=9222 to your shortcut manually.');
            return;
        }

        const output = stdout.trim();
        log(`Auto-Fix CDP: ${output}`);

        if (output.includes('RESULT:PATCHED:')) {
            const count = (output.match(/RESULT:PATCHED:(\d+)/) || [])[1] || '1';
            log(`Auto-Fix CDP: ${count} shortcut(s) patched!`);
            vscode.window.showInformationMessage(
                `\u2705 ${count} shortcut(s) updated with --remote-debugging-port=9222! Restart ${ideName} for the fix to take effect.`,
                'Close & Restart'
            ).then(action => {
                if (action === 'Close & Restart') {
                    vscode.commands.executeCommand('workbench.action.quit');
                }
            });
        } else if (output.includes('RESULT:ALREADY_OK:')) {
            const count = (output.match(/RESULT:ALREADY_OK:(\d+)/) || [])[1] || '1';
            log(`Auto-Fix CDP: ${count} shortcut(s) already have the correct flag.`);
            vscode.window.showInformationMessage(
                `\u2705 ${count} ${ideName} shortcut(s) already have --remote-debugging-port=9222. No changes needed. If CDP still doesn\'t work, restart ${ideName}.`
            );
        } else {
            log('Auto-Fix CDP: No IDE shortcuts found.');
            vscode.window.showWarningMessage(
                `No ${ideName} shortcut found on Desktop or Start Menu. ` +
                `Please create a shortcut or add --remote-debugging-port=9222 to your launch command manually.`,
                'Copy Flag'
            ).then(action => {
                if (action === 'Copy Flag') {
                    vscode.env.clipboard.writeText('--remote-debugging-port=9222');
                    vscode.window.showInformationMessage('\ud83d\udccb Copied --remote-debugging-port=9222 to clipboard.');
                }
            });
        }
    });
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
            diffProtectionEnabled: diffProtectionEnabled,
            bannedCommands: bannedCommands,
            godMode: godModeEnabled
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
    startPermissionPolling();
    // Each window independently starts its own CDP session
    await startCDPSession(context);
    log('Polling started (commands + CDP + permission)');
}

async function stopPolling() {
    stopCommandPolling();
    stopPermissionPolling();
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
        // BUG 5 FIX: Restart command polling with new frequency
        // Use defensive check: clear first, then verify null before restart
        if (commandPollTimer) {
            stopCommandPolling();
        }
        if (!commandPollTimer && globalContext) {
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

    // Re-inject with updated config
    if (isEnabled) { await stopCDPSession(); await startCDPSession(context); }
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

    // Native commands are safe to fire from ALL windows (no conflict)
    commandPollTimer = setInterval(() => {
        if (!isEnabled) return;
        executeAcceptCommandsForIDE();
    }, pollFrequency);
}

function stopCommandPolling() {
    if (commandPollTimer) {
        clearInterval(commandPollTimer);
        commandPollTimer = null;
    }
}

// ─── CDP Permission Script Cycle (MarcoDeliaBot-style) ──────────────
let cdpPermissionTimer = null;

function buildPermissionScript() {
    // Get active click patterns
    const activePatterns = clickPatterns
        .filter(p => !disabledClickPatterns.includes(p))
        .map(p => p.toLowerCase());

    const SAFE_TEXTS = JSON.stringify(activePatterns);
    const GOD_MODE = godModeEnabled;

    return `(function() {
    // ═══ WEBVIEW GUARD ═══
    // Only run inside the agent panel webview, not the main IDE window
    var isWebview = window.location.protocol === 'vscode-webview:' ||
                    !!document.querySelector('.react-app-container') ||
                    !!document.querySelector('[data-vscode-context]') ||
                    !!document.querySelector('[class*="agent"]');
    if (!isWebview) return 'ignored-main-window';

    var SAFE_TEXTS = ${SAFE_TEXTS};
    var GOD_MODE = ${GOD_MODE};
    var REJECT = ['skip', 'reject', 'cancel', 'close', 'refine', 'deny', 'dismiss', 'abort'];

    // ═══ ERROR LOOP GUARD (persistent across evaluations) ═══
    var ERROR_KW = ['error', 'failed', 'failure', 'exception', 'timed out', 'timeout',
        'could not', 'unable to', 'cannot', 'fatal', 'crashed', 'aborted', 'terminated'];
    var RETRY_KW = ['continue', 'retry', 'try again'];
    if (!window.__permClickCooldown) window.__permClickCooldown = {};
    if (!window.__permLoopBrakeUntil) window.__permLoopBrakeUntil = 0;

    function isRetryText(t) {
        for (var i = 0; i < RETRY_KW.length; i++) { if (t.indexOf(RETRY_KW[i]) !== -1) return true; }
        return false;
    }

    function hasNearbyError(node) {
        var container = node.parentElement;
        var depth = 0;
        while (container && depth < 6) {
            // Check PREVIOUS siblings (above)
            var sib = container.previousElementSibling;
            var sc = 0;
            while (sib && sc < 3) {
                var st = (sib.textContent || '').toLowerCase().substring(0, 500);
                for (var i = 0; i < ERROR_KW.length; i++) {
                    if (st.indexOf(ERROR_KW[i]) !== -1) return ERROR_KW[i];
                }
                sib = sib.previousElementSibling; sc++;
            }
            // Check NEXT siblings (below — error appears here in agent chat)
            sib = container.nextElementSibling;
            sc = 0;
            while (sib && sc < 3) {
                var st = (sib.textContent || '').toLowerCase().substring(0, 500);
                for (var i = 0; i < ERROR_KW.length; i++) {
                    if (st.indexOf(ERROR_KW[i]) !== -1) return ERROR_KW[i];
                }
                sib = sib.nextElementSibling; sc++;
            }
            // Check container's own text
            try {
                var ct = (container.textContent || '').toLowerCase().substring(0, 300);
                for (var i = 0; i < ERROR_KW.length; i++) {
                    if (ct.indexOf(ERROR_KW[i]) !== -1 && ct.length > 50) return ERROR_KW[i];
                }
            } catch(e) {}
            container = container.parentElement; depth++;
        }
        return null;
    }

    function checkCooldown(text) {
        var now = Date.now();
        // Loop brake active?
        if (window.__permLoopBrakeUntil > now) return 'brake';
        var cd = window.__permClickCooldown;
        if (!cd[text]) cd[text] = [];
        var recent = [];
        for (var i = 0; i < cd[text].length; i++) {
            if (now - cd[text][i] < 30000) recent.push(cd[text][i]);
        }
        cd[text] = recent;
        if (recent.length >= 3) {
            window.__permLoopBrakeUntil = now + 60000;
            return 'brake';
        }
        return null;
    }

    function recordCd(text) {
        if (!window.__permClickCooldown[text]) window.__permClickCooldown[text] = [];
        window.__permClickCooldown[text].push(Date.now());
    }

    function getDirectText(node) {
        var text = '';
        for (var i = 0; i < node.childNodes.length; i++) {
            if (node.childNodes[i].nodeType === 3) {
                text += node.childNodes[i].textContent;
            }
        }
        return text.trim().toLowerCase();
    }

    function textMatches(nodeText, target) {
        if (nodeText === target) return true;
        if (nodeText.startsWith(target + ' alt+')) return true;
        if (nodeText.startsWith(target + '\\\\t')) return true;
        if (target === 'accept' && (nodeText === 'accept all' || nodeText.startsWith('accept all'))) return true;
        if (target.length >= 6 && nodeText.startsWith(target)) return true;
        return false;
    }

    function closestClickable(node) {
        var el = node;
        var depth = 0;
        while (el && depth < 5) {
            depth++;
            var tag = (el.tagName || '').toLowerCase();
            if (tag === 'button' || el.getAttribute('role') === 'button' ||
                el.classList.contains('cursor-pointer') || el.onclick) {
                return el;
            }
            el = el.parentElement;
        }
        return node;
    }

    function findButton(root, text) {
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        var node;
        while ((node = walker.nextNode())) {
            if (node.shadowRoot) {
                var result = findButton(node.shadowRoot, text);
                if (result) return result;
            }
            if (GOD_MODE) {
                var testId = (node.getAttribute('data-testid') || node.getAttribute('data-action') || '').toLowerCase();
                if (testId.includes('alwaysallow') || testId.includes('always-allow') || testId.includes('allow')) {
                    var t1 = (node.tagName || '').toLowerCase();
                    if (t1 === 'button' || node.getAttribute('role') === 'button') return node;
                }
            }
            var directText = getDirectText(node);
            var fullText = (node.textContent || '').trim().toLowerCase().substring(0, 80);
            var checkText = text.length <= 4 ? directText : (directText || fullText);

            if (textMatches(checkText, text)) {
                // Reject check
                var isRejected = false;
                for (var r = 0; r < REJECT.length; r++) {
                    if (checkText.indexOf(REJECT[r]) !== -1) { isRejected = true; break; }
                }
                if (!GOD_MODE && (checkText.indexOf('always allow') !== -1 || checkText.indexOf('always run') !== -1)) {
                    isRejected = true;
                }
                if (isRejected) continue;

                var clickable = closestClickable(node);
                var t2 = (clickable.tagName || '').toLowerCase();
                if (t2 === 'button' || clickable.getAttribute('role') === 'button' ||
                    clickable.classList.contains('cursor-pointer') || clickable.onclick ||
                    clickable.getAttribute('tabindex') === '0') {
                    var rect = clickable.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) return clickable;
                }
            }
        }
        return null;
    }

    for (var t = 0; t < SAFE_TEXTS.length; t++) {
        var btn = findButton(document.body, SAFE_TEXTS[t]);
        if (btn) {
            var btnLabel = SAFE_TEXTS[t];
            // Error loop guard for Continue/Retry
            if (isRetryText(btnLabel)) {
                var errKw = hasNearbyError(btn);
                if (errKw) return 'error-blocked:' + btnLabel + ':' + errKw;
                var cdResult = checkCooldown(btnLabel);
                if (cdResult) return 'cooldown-blocked:' + btnLabel;
                recordCd(btnLabel);
            }
            btn.click();
            return 'clicked:' + btnLabel;
        }
    }
    return 'no-button';
})()`;
}

async function checkPermissionButtons() {
    if (!isEnabled || !cdpHandler) return;
    try {
        const script = buildPermissionScript();
        const result = await cdpHandler.evaluateOnAllPages(script);
        if (result && result.startsWith('clicked:')) {
            log(`[CDP-Perm] ${result}`);
            roiStats.clicks++;
            addHistoryEntry('accept', 'cdp-perm', result);
        } else if (result && (result.startsWith('error-blocked:') || result.startsWith('cooldown-blocked:'))) {
            log(`[CDP-Perm] 🚫 ${result}`);
            roiStats.blocked = (roiStats.blocked || 0) + 1;
        }
    } catch (e) { /* silent */ }
}

function startPermissionPolling() {
    if (cdpPermissionTimer) return;
    cdpPermissionTimer = setInterval(checkPermissionButtons, 1500);
    log('CDP Permission polling started (1500ms)');
}

function stopPermissionPolling() {
    if (cdpPermissionTimer) {
        clearInterval(cdpPermissionTimer);
        cdpPermissionTimer = null;
    }
}


// ─── Accept Commands ─────────────────────────────────────────────────
let isAccepting = false; // Async lock — prevents double-accepts
async function executeAcceptCommandsForIDE() {
    if (isAccepting) return; // Lock: previous batch still running
    // Guard: only fire when user has relevant patterns enabled
    const activePatterns = clickPatterns.filter(p => !disabledClickPatterns.includes(p));
    const wantsAction = activePatterns.some(p => {
        const lower = p.toLowerCase();
        return lower.includes('accept') || lower.includes('allow') || lower.includes('continue') || lower.includes('run');
    });
    if (!wantsAction) return;

    isAccepting = true;
    try {
        const commands = getAcceptCommandsForIDE();
        await Promise.allSettled(commands.map(cmd => vscode.commands.executeCommand(cmd)));
    } finally {
        isAccepting = false;
    }
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
            diffProtectionEnabled: diffProtectionEnabled,
            httpPort: httpBoundPort || AG_HTTP_PORT_BASE, // Use actual bound port
            // BUG 2 FIX: Preserve cumulative stats across re-injects
            initialStats: {
                clicks: roiStats.clicks || 0,
                blocked: roiStats.blocked || 0,
                fileEdits: 0,
                terminalCommands: 0
            }
        };

        await cdpHandler.start(config);
        startCDPSync(context);
        log('CDP session started');
    } catch (e) {
        log(`Failed to start CDP session: ${e.message}`);
        // Show setup panel when CDP is not available
        const choice = await vscode.window.showErrorMessage(
            `Auto Accept Pro: Failed to connect to CDP. ${e.message}`,
            'Show Setup Guide', 'Dismiss'
        );
        if (choice === 'Show Setup Guide' && relauncher) {
            relauncher.showSetupPanel();
        }
    }
}

async function stopCDPSession() {
    try {
        // BUG 1 FIX: Flush final stats BEFORE stopping CDP
        if (cdpHandler && cdpHandler.isConnected()) {
            try {
                const finalStats = await cdpHandler.getAndResetStats();
                if (finalStats && (finalStats.clicks > 0 || finalStats.blocked > 0)) {
                    roiStats.clicks = (roiStats.clicks || 0) + (finalStats.clicks || 0);
                    roiStats.clicksThisWeek = (roiStats.clicksThisWeek || 0) + (finalStats.clicks || 0);
                    roiStats.blocked = (roiStats.blocked || 0) + (finalStats.blocked || 0);
                    roiStats.blockedThisWeek = (roiStats.blockedThisWeek || 0) + (finalStats.blocked || 0);
                    if (globalContext) saveROIStats(globalContext);
                    log(`Stats flushed before stop: +${finalStats.clicks} clicks, +${finalStats.blocked} blocked`);
                }
            } catch (e) { /* stats flush failed, not critical */ }
        }
        stopCDPSync();
        await cdpHandler.stop();
        log('CDP session stopped');
    } catch (e) {
        log(`Failed to stop CDP session: ${e.message}`);
    }
}

function startCDPSync(context) {
    if (cdpSyncTimer) return;
    let _syncing = false; // BUG 3 FIX: re-entry guard for async setInterval

    cdpSyncTimer = setInterval(async () => {
        if (!isEnabled) return;
        if (_syncing) return; // BUG 3 FIX: skip if previous call still in-flight
        _syncing = true;

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
        } finally {
            _syncing = false;
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
    // Accept item
    if (isEnabled) {
        statusBarToggle.text = '$(check) Auto Accept';
        statusBarToggle.tooltip = 'Auto Accept Pro: ✅ ON\nClick to disable';
        statusBarToggle.color = '#4EC9B0';
        statusBarToggle.backgroundColor = undefined;
    } else {
        statusBarToggle.text = '$(circle-slash) Auto Accept';
        statusBarToggle.tooltip = 'Auto Accept Pro: ❌ OFF\nClick to enable';
        statusBarToggle.color = '#F44747';
        statusBarToggle.backgroundColor = undefined;
    }
    statusBarToggle.show();

    // BG Mode item (only when enabled)
    if (isEnabled) {
        if (isBackgroundMode) {
            statusBarBackground.text = '$(pass-filled) BG Mode';
            statusBarBackground.color = '#4EC9B0';
            statusBarBackground.backgroundColor = undefined;
        } else {
            statusBarBackground.text = '$(circle-slash) BG Mode';
            statusBarBackground.color = '#F44747';
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
