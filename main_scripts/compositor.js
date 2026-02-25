/**
 * Compositor — Script Selector
 *
 * Selects the appropriate injection script based on configuration.
 * Background mode → loads and caches background_mode.js
 * Simple mode → returns inline simple poll script
 */

const fs = require('fs');
const path = require('path');

let _bgScriptCache = null;
let _autoAcceptCache = null;

/**
 * Compose the injection script based on config
 * @param {Object} config - { isBackgroundMode, ide, pollInterval, bannedCommands }
 * @returns {string} JavaScript source to inject
 */
function compose(config) {
    const useBackground = config.isBackgroundMode === true;

    console.log(`[Compositor] compose: isBackgroundMode=${config.isBackgroundMode} → ${useBackground ? 'BACKGROUND' : 'SIMPLE POLL'}`);

    if (useBackground) {
        // Load the unified auto_accept.js which handles both modes
        if (!_autoAcceptCache) {
            const scriptPath = path.join(__dirname, '..', 'main_scripts', 'auto_accept.js');
            _autoAcceptCache = fs.readFileSync(scriptPath, 'utf8');
            console.log(`[Compositor] Loaded auto_accept.js (${_autoAcceptCache.length} bytes)`);
        }
        return _autoAcceptCache;
    }

    // Simple poll mode — inline script with Safe Click, Diff Protection, Auto Scroll, HTTP Live Sync
    const interval = config.pollInterval || 1000;
    const bannedJSON = JSON.stringify(config.bannedCommands || []);
    const smartRulesJSON = JSON.stringify(config.smartRules || []);
    const smartEnabled = config.smartAcceptEnabled !== false;
    const clickPatternsJSON = JSON.stringify(config.clickPatterns || ['Run', 'Allow', 'Always Allow', 'Keep Waiting', 'Retry', 'Continue', 'Allow Once', 'Accept all']);
    const scrollEnabled = config.scrollEnabled !== false;
    const scrollPause = config.scrollPauseMs || 7000;
    const scrollInterval = config.scrollIntervalMs || 500;
    const safeClick = config.safeClickEnabled !== false;
    const diffProtect = config.diffProtectionEnabled !== false;

    return `
(function() {
    'use strict';

    // --- Guard: prevent double execution ---
    if (window.__autoAcceptLoaded) return;
    window.__autoAcceptLoaded = true;

    // --- Cleanup old timers ---
    if (window.__agToolIntervals) {
        window.__agToolIntervals.forEach(clearInterval);
        if (window.__agScrollListener) window.removeEventListener('scroll', window.__agScrollListener, true);
    }
    window.__agToolIntervals = [];

    function log(msg) { console.log('[AutoAccept] ' + msg); }

    function getDocuments(root) {
        root = root || document;
        var docs = [root];
        try {
            var iframes = root.querySelectorAll('iframe, frame');
            for (var i = 0; i < iframes.length; i++) {
                try {
                    var d = iframes[i].contentDocument || (iframes[i].contentWindow && iframes[i].contentWindow.document);
                    if (d) docs = docs.concat(getDocuments(d));
                } catch(e) {}
            }
        } catch(e) {}
        return docs;
    }

    function queryAll(selector) {
        var results = [];
        getDocuments().forEach(function(doc) {
            try { results = results.concat(Array.from(doc.querySelectorAll(selector))); } catch(e) {}
        });
        return results;
    }

    // ═══════════════════════════════════════════════════
    // Config — updated live via HTTP polling
    // ═══════════════════════════════════════════════════
    var CLICK_PATTERNS = ${clickPatternsJSON};
    var CLICK_INTERVAL_MS = ${interval};
    var PAUSE_SCROLL_MS = ${scrollPause};
    var SCROLL_INTERVAL_MS = ${scrollInterval};
    window.__agAutoEnabled = true;
    window.__agScrollEnabled = ${scrollEnabled};
    var __agSafeClickEnabled = ${safeClick};
    var __agDiffProtectionEnabled = ${diffProtect};

    var bannedCommands = ${bannedJSON};
    var smartRules = ${smartRulesJSON};
    var smartAcceptEnabled = ${smartEnabled};

    // ═══════════════════════════════════════════════════
    // HTTP Live Sync — poll Extension Host every 2s
    // Scans ports 48787..48796 to find the active server
    // ═══════════════════════════════════════════════════
    var AG_HTTP_PORT_BASE = 48787;
    var AG_HTTP_PORT_RANGE = 10;
    var __agHttpPort = AG_HTTP_PORT_BASE; // cached active port
    var _pollCount = 0;

    function __agHttpPoll(port) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', 'http://127.0.0.1:' + port + '/ag-status', false);
        xhr.send();
        if (xhr.status === 200) return JSON.parse(xhr.responseText);
        return null;
    }

    var _httpPollTimer = setInterval(function() {
        _pollCount++;
        try {
            // Try cached port first
            var cfg = __agHttpPoll(__agHttpPort);
            // If cached port failed, scan the range
            if (!cfg) {
                for (var p = 0; p < AG_HTTP_PORT_RANGE; p++) {
                    var tryPort = AG_HTTP_PORT_BASE + p;
                    if (tryPort === __agHttpPort) continue;
                    cfg = __agHttpPoll(tryPort);
                    if (cfg) { __agHttpPort = tryPort; break; }
                }
            }
            if (cfg) {
                if (typeof cfg.enabled === 'boolean') {
                    if (window.__agAutoEnabled !== cfg.enabled) {
                        log(cfg.enabled ? 'ON (via HTTP)' : 'OFF (via HTTP)');
                    }
                    window.__agAutoEnabled = cfg.enabled;
                }
                if (typeof cfg.scrollEnabled === 'boolean') window.__agScrollEnabled = cfg.scrollEnabled;
                if (cfg.clickPatterns && Array.isArray(cfg.clickPatterns)) CLICK_PATTERNS = cfg.clickPatterns;
                if (cfg.pauseScrollMs) PAUSE_SCROLL_MS = cfg.pauseScrollMs;
                if (cfg.scrollIntervalMs) SCROLL_INTERVAL_MS = cfg.scrollIntervalMs;
                if (cfg.clickIntervalMs) CLICK_INTERVAL_MS = cfg.clickIntervalMs;
                if (typeof cfg.safeClickEnabled === 'boolean') __agSafeClickEnabled = cfg.safeClickEnabled;
                if (typeof cfg.diffProtectionEnabled === 'boolean') __agDiffProtectionEnabled = cfg.diffProtectionEnabled;
                if (_pollCount <= 2) log('HTTP Poll #' + _pollCount + ' OK port=' + __agHttpPort + ', enabled=' + window.__agAutoEnabled + ', patterns=' + CLICK_PATTERNS.length);
            }
        } catch(e) {
            if (_pollCount <= 3) log('HTTP Poll #' + _pollCount + ' error: ' + e.message);
        }
    }, 2000);
    window.__agToolIntervals.push(_httpPollTimer);

    // ═══════════════════════════════════════════════════
    // Diff Protection — NEVER click these editor buttons
    // ═══════════════════════════════════════════════════
    var EDITOR_SKIP_WORDS = ['Accept Changes', 'Accept All', 'Accept Incoming', 'Accept Current', 'Accept Both', 'Accept Combination'];

    // ═══════════════════════════════════════════════════
    // Safe Click — isApprovalButton (sibling Reject check)
    // ═══════════════════════════════════════════════════
    var REJECT_WORDS = ['Reject', 'Deny', 'Cancel', 'Dismiss', "Don't Allow", 'Decline'];

    function isApprovalButton(btn) {
        var parent = btn.parentElement;
        if (!parent) return false;
        for (var level = 0; level < 3; level++) {
            if (!parent) break;
            var siblingBtns = parent.querySelectorAll('button, a.action-label, [role="button"], .monaco-button, span.bg-ide-button-background');
            for (var i = 0; i < siblingBtns.length; i++) {
                var sib = siblingBtns[i];
                if (sib === btn) continue;
                var sibText = (sib.innerText || '').trim();
                for (var j = 0; j < REJECT_WORDS.length; j++) {
                    if (sibText === REJECT_WORDS[j] || sibText.indexOf(REJECT_WORDS[j]) === 0) {
                        return true;
                    }
                }
            }
            parent = parent.parentElement;
        }
        return false;
    }

    // ═══════════════════════════════════════════════════
    // Command evaluation (banned + smart rules)
    // ═══════════════════════════════════════════════════
    function findNearbyCommandText(el) {
        var commandSelectors = ['pre', 'code', 'pre code'];
        var parent = el.parentElement;
        for (var depth = 0; depth < 5 && parent; depth++) {
            for (var s = 0; s < commandSelectors.length; s++) {
                var cmds = parent.querySelectorAll(commandSelectors[s]);
                for (var c = 0; c < cmds.length; c++) {
                    var text = (cmds[c].textContent || '').trim();
                    if (text.length > 0 && text.length < 500) return text;
                }
            }
            parent = parent.parentElement;
        }
        return null;
    }

    function evaluateCommand(commandText) {
        if (!commandText) return { action: 'accept', reason: null };
        var lower = commandText.toLowerCase();
        for (var i = 0; i < bannedCommands.length; i++) {
            var pattern = bannedCommands[i];
            if (pattern.startsWith('/')) {
                try {
                    var parts = pattern.match(/^\\\\/(.+)\\\\/([gimsuy]*)$/);
                    if (parts && new RegExp(parts[1], parts[2]).test(commandText)) {
                        return { action: 'block', reason: 'Banned: ' + pattern, category: 'banned' };
                    }
                } catch(e) {}
            } else {
                if (lower.includes(pattern.toLowerCase())) {
                    return { action: 'block', reason: 'Banned: ' + pattern, category: 'banned' };
                }
            }
        }
        if (smartAcceptEnabled && smartRules.length > 0) {
            for (var j = 0; j < smartRules.length; j++) {
                var rule = smartRules[j];
                var matched = false;
                if (rule.type === 'regex') {
                    try {
                        var rParts = rule.pattern.match(/^\\\\/(.+)\\\\/([gimsuy]*)$/);
                        if (rParts && new RegExp(rParts[1], rParts[2]).test(commandText)) matched = true;
                    } catch(e) {}
                } else {
                    if (lower.includes(rule.pattern.toLowerCase())) matched = true;
                }
                if (matched) {
                    return {
                        action: rule.severity === 'block' ? 'block' : 'warn',
                        reason: '[' + (rule.category || 'smart') + '] ' + rule.pattern,
                        category: rule.category || 'smart'
                    };
                }
            }
        }
        return { action: 'accept', reason: null };
    }

    // ═══════════════════════════════════════════════════
    // Stats & History
    // ═══════════════════════════════════════════════════
    var clicks = 0;
    var blocked = 0;
    var warned = 0;
    var history = [];
    var MAX_HISTORY = 100;
    var _clicked = new WeakSet();

    function addHistory(action, detail) {
        history.unshift({ ts: new Date().toISOString(), action: action, detail: detail });
        if (history.length > MAX_HISTORY) history.pop();
    }

    window.__autoAcceptGetStats = function() { return { clicks: clicks, blocked: blocked, warned: warned }; };
    window.__autoAcceptResetStats = function() { var s = { clicks: clicks, blocked: blocked, warned: warned }; clicks = 0; blocked = 0; warned = 0; return s; };
    window.__autoAcceptGetHistory = function() { return history; };
    window.__autoAcceptSetFocusState = function(focused) {};
    window.__autoAcceptUpdateBannedCommands = function(list) { bannedCommands = list || []; };
    window.__autoAcceptUpdateSmartRules = function(rules) { smartRules = rules || []; };
    window.__autoAcceptStart = function() { log('Already running in simple mode'); };
    window.__autoAcceptStop = function() {
        window.__agToolIntervals.forEach(clearInterval);
        if (window.__agScrollListener) window.removeEventListener('scroll', window.__agScrollListener, true);
        window.__agToolIntervals = [];
        window.__autoAcceptLoaded = false;
        log('Stopped all timers');
    };

    // ═══════════════════════════════════════════════════
    // 1. AUTO CLICK — with Safe Click + Diff Protection
    // ═══════════════════════════════════════════════════
    var autoClickTimer = setInterval(function() {
        if (!window.__agAutoEnabled) return;

        var clickables = Array.from(document.querySelectorAll('button, a.action-label, [role="button"], .monaco-button, [class*="button"], [class*="anysphere"], .bg-ide-button-background'));
        document.querySelectorAll('span.cursor-pointer').forEach(function(s) { clickables.push(s); });

        for (var i = 0; i < clickables.length; i++) {
            var b = clickables[i];
            if (b.offsetParent === null) continue;
            if (_clicked.has(b)) continue;

            var text = (b.innerText || b.textContent || '').trim();
            if (!text || text.length > 40) continue;

            // ── Diff Protection: skip editor buttons by text ──
            if (__agDiffProtectionEnabled) {
                var skipEditor = false;
                for (var se = 0; se < EDITOR_SKIP_WORDS.length; se++) {
                    if (text.indexOf(EDITOR_SKIP_WORDS[se]) === 0) { skipEditor = true; break; }
                }
                if (skipEditor) continue;

                // ── Diff Protection: skip buttons inside diff/merge containers ──
                if (b.closest && (b.closest('.monaco-diff-editor') || b.closest('.merge-editor-view') || b.closest('.inline-merge-region') || b.closest('.merged-editor'))) continue;
            }

            // ── Pattern matching (configurable via HTTP) ──
            var matchesPattern = false;
            for (var p = 0; p < CLICK_PATTERNS.length; p++) {
                if (text === CLICK_PATTERNS[p] || text.indexOf(CLICK_PATTERNS[p]) === 0) {
                    matchesPattern = true;
                    break;
                }
            }
            if (!matchesPattern) continue;

            // ── Command safety check (bannedCommands + smartRules) ──
            var nearbyCmd = findNearbyCommandText(b);
            var result = evaluateCommand(nearbyCmd);

            if (result.action === 'block') {
                log('BLOCKED: ' + result.reason + ' | cmd: "' + (nearbyCmd || '').substring(0, 60) + '"');
                addHistory('block', result.reason + ' | ' + (nearbyCmd || '').substring(0, 80));
                blocked++;
                _clicked.add(b);
                continue;
            }
            if (result.action === 'warn') {
                log('WARNED: ' + result.reason + ' | cmd: "' + (nearbyCmd || '').substring(0, 60) + '"');
                addHistory('warn', result.reason + ' | ' + (nearbyCmd || '').substring(0, 80));
                warned++;
                _clicked.add(b);
                continue;
            }

            // ── Safe Click: span.cursor-pointer → click directly ──
            if (b.tagName === 'SPAN' && b.classList.contains('cursor-pointer')) {
                log('Click (span): "' + text + '"');
                addHistory('accept', 'Clicked: "' + text + '"');
                _clicked.add(b);
                b.click();
                clicks++;
                break;
            }

            // ── Safe Click: other buttons — require sibling Reject (if enabled) ──
            if (!__agSafeClickEnabled || isApprovalButton(b)) {
                log('Click: "' + text + '"' + (nearbyCmd ? ' | cmd: ' + nearbyCmd.substring(0, 40) : ''));
                addHistory('accept', 'Clicked: "' + text + '"' + (nearbyCmd ? ' | cmd: ' + nearbyCmd.substring(0, 60) : ''));
                _clicked.add(b);
                b.click();
                clicks++;
                break;
            }
        }
    }, CLICK_INTERVAL_MS);
    window.__agToolIntervals.push(autoClickTimer);

    // ═══════════════════════════════════════════════════
    // 2. MANUAL SCROLL DETECTION
    // ═══════════════════════════════════════════════════
    var lastManualScrollTime = 0;
    var isAutoScrolling = false;

    window.__agScrollListener = function(e) {
        if (!isAutoScrolling && e.isTrusted) {
            var el = e.target;
            if (el && el.nodeType === 1) {
                if (!el.closest || (!el.closest('.monaco-editor') && !el.closest('.part.editor'))) {
                    lastManualScrollTime = Date.now();
                }
            }
        }
    };
    window.addEventListener('scroll', window.__agScrollListener, true);

    // ═══════════════════════════════════════════════════
    // 3. AUTO SCROLL
    // ═══════════════════════════════════════════════════
    var autoScrollTimer = setInterval(function() {
        if (!window.__agAutoEnabled) return;
        if (!window.__agScrollEnabled) return;
        var now = Date.now();
        if (now - lastManualScrollTime < PAUSE_SCROLL_MS) return;

        var scrollables = Array.from(document.querySelectorAll('*')).filter(function(el) {
            var style = window.getComputedStyle(el);
            var hasScrollbar = el.scrollHeight > el.clientHeight &&
                (style.overflowY === 'auto' || style.overflowY === 'scroll');
            if (!hasScrollbar) return false;
            if (el.closest && (el.closest('.monaco-editor') || el.closest('.part.editor'))) return false;
            if (el.tagName === 'TEXTAREA') return false;
            return true;
        });

        if (scrollables.length > 0) {
            isAutoScrolling = true;
            scrollables.forEach(function(el) {
                if (el.scrollHeight - el.scrollTop - el.clientHeight > 5) {
                    el.scrollTop = el.scrollHeight;
                }
            });
            setTimeout(function() { isAutoScrolling = false; }, 50);
        }
    }, SCROLL_INTERVAL_MS);
    window.__agToolIntervals.push(autoScrollTimer);

    log('Started v1.4 | Click patterns: ' + CLICK_PATTERNS.length + ' | Scroll: ' + window.__agScrollEnabled + ' | Smart: ' + smartAcceptEnabled);
})();
`;
}

module.exports = { compose };
