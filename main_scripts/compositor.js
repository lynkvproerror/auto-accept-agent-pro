/**
 * compositor.js — Script Selector
 *
 * Returns the appropriate injection script based on config:
 *   - Background mode: full background loop with overlay (background_mode.js)
 *   - Otherwise: simple accept-button polling loop (inline)
 *
 * Usage:
 *   const { compose } = require('./compositor');
 *   const script = compose(config);
 */

const fs = require('fs');
const path = require('path');

let _bgCache = null;
let _bgCacheMtime = null;

/**
 * Find the background_mode.js script file.
 * Searches multiple candidate paths to handle both dev and bundled contexts.
 */
function _findBgScript() {
    const candidates = [
        // Same directory as compositor.js (dev: main_scripts/)
        path.join(__dirname, 'background_mode.js'),
        // Up from dist/ into main_scripts/ (bundled context)
        path.join(__dirname, '..', 'main_scripts', 'background_mode.js'),
        // Up two levels (legacy)
        path.join(__dirname, '..', '..', 'main_scripts', 'background_mode.js'),
    ];

    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }

    throw new Error(`Could not find background_mode.js. __dirname=${__dirname}, tried: ${candidates.join(', ')}`);
}

/**
 * Load and cache the background mode script, re-reading if file changed.
 */
function _getBgScript() {
    const scriptPath = _findBgScript();
    const mtime = fs.statSync(scriptPath).mtimeMs;
    if (_bgCache && _bgCacheMtime === mtime) return _bgCache;
    _bgCache = fs.readFileSync(scriptPath, 'utf8');
    _bgCacheMtime = mtime;
    return _bgCache;
}

/**
 * Generate the simple poll script (inline, no external file).
 * Used when background mode is off — polls for accept buttons.
 */
function _getSimplePollScript(config) {
    const interval = config.pollInterval || 2000;
    const ide = (config.ide || 'cursor').toLowerCase();
    const clickPatterns = JSON.stringify(config.clickPatterns || ['Run', 'Allow', 'Always Allow', 'Keep Waiting', 'Retry', 'Continue', 'Allow Once']);
    const scrollEnabled = config.scrollEnabled !== false;
    const scrollPauseMs = config.scrollPauseMs || 7000;
    const scrollIntervalMs = config.scrollIntervalMs || 500;
    const safeClickEnabled = config.safeClickEnabled !== false;
    const diffProtectionEnabled = config.diffProtectionEnabled !== false;
    const httpPort = config.httpPort || 48787;

    const selectors = ide === 'antigravity'
        ? `['.bg-ide-button-background']`
        : `['button', '[class*="button"]', '[class*="anysphere"]']`;

    return `(function() {
    'use strict';
    if (typeof window === 'undefined') return;

    var _spLog = function(m) { console.log('[SimplePoll] ' + m); };

    if (window.__simplePollRunning) {
        _spLog('Already running, skipping re-inject');
        return;
    }

    // --- Config ---
    var config = {
        clickPatterns: ${clickPatterns},
        scrollEnabled: ${scrollEnabled},
        scrollPauseMs: ${scrollPauseMs},
        scrollIntervalMs: ${scrollIntervalMs},
        safeClickEnabled: ${safeClickEnabled},
        diffProtectionEnabled: ${diffProtectionEnabled},
        httpPort: ${httpPort},
        bannedCommands: [],
        godMode: false
    };

    // --- DOM Helpers ---
    var getDocuments = function(root) {
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
    };

    var queryAll = function(selector) {
        var results = [];
        var docs = getDocuments();
        for (var i = 0; i < docs.length; i++) {
            try {
                var els = docs[i].querySelectorAll(selector);
                for (var j = 0; j < els.length; j++) results.push(els[j]);
            } catch(e) {}
        }
        // Shadow DOM piercing
        try {
            var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
            var node;
            while ((node = walker.nextNode())) {
                if (node.shadowRoot) {
                    try {
                        var shadowEls = node.shadowRoot.querySelectorAll(selector);
                        for (var k = 0; k < shadowEls.length; k++) {
                            if (results.indexOf(shadowEls[k]) === -1) results.push(shadowEls[k]);
                        }
                    } catch(e) {}
                }
            }
        } catch(e) {}
        return results;
    };

    // --- Reject patterns (expanded from reference) ---
    // When God Mode is ON, 'always allow/run/proceed/auto' are REMOVED from reject
    var baseRejectPatterns = ['skip', 'reject', 'cancel', 'close', 'refine', 'deny', 'no', 'dismiss', 'abort', 'ask every time'];
    var godModeOnlyPatterns = ['always run', 'always allow', 'always proceed', 'always auto'];
    var rejectPatterns = config.godMode ? baseRejectPatterns : baseRejectPatterns.concat(godModeOnlyPatterns);

    // --- Diff/merge editor labels (NO 'accept all' — it blocks agent Accept All button) ---
    var diffLabels = ['accept changes', 'accept incoming', 'accept current',
                      'accept both', 'use theirs', 'use ours', 'use mine'];

    // --- Conversation Area Guard (from reference: excludes sidebar, editor, toolbar) ---
    // Detect if running inside vscode-webview:// (OOPIF agent panel)
    var _isWebviewContext = (window.location.protocol === 'vscode-webview:') ||
                            !!document.querySelector('.react-app-container') ||
                            !!document.querySelector('[data-vscode-context]');

    function isInConversationArea(el) {
        // In webview context, the ENTIRE page IS the agent panel — always allow
        if (_isWebviewContext) return true;
        // When Conversation Guard is OFF, skip area check (click anywhere)
        if (!config.safeClickEnabled) return true;
        var excludedSelectors = [
            '#workbench\\\\.parts\\\\.sidebar',
            '#workbench\\\\.parts\\\\.activitybar',
            '#workbench\\\\.parts\\\\.titlebar',
            '#workbench\\\\.parts\\\\.statusbar',
            '#workbench\\\\.parts\\\\.editor',
            '.menubar-menu-button',
            '.title-actions',
            '[class*="explorer"]',
            '.tabs-container',
            '.composite.viewlet',
            '.sidebar',
            '.activity-bar-container'
        ];
        for (var i = 0; i < excludedSelectors.length; i++) {
            try { if (el.closest(excludedSelectors[i])) return false; } catch(e) {}
        }
        var includedSelectors = [
            '#antigravity\\\\.agentPanel',
            '#workbench\\\\.parts\\\\.auxiliarybar',
            '[class*="agent"]',
            '[class*="chat"]',
            '[class*="conversation"]',
            '[class*="agentic"]'
        ];
        for (var i = 0; i < includedSelectors.length; i++) {
            try { if (el.closest(includedSelectors[i])) return true; } catch(e) {}
        }
        return true; // Default accept if passed exclusion
    }

    // --- Get button own text (avoids checkbox/label text bleed) ---
    function getButtonOwnText(el) {
        var ownText = '';
        for (var i = 0; i < el.childNodes.length; i++) {
            var node = el.childNodes[i];
            if (node.nodeType === 3) { // TEXT_NODE
                ownText += node.textContent;
            } else if (node.nodeType === 1) { // ELEMENT_NODE
                var tag = (node.tagName || '').toLowerCase();
                if (tag === 'input' || tag === 'label' || tag === 'checkbox') continue;
                var childText = (node.textContent || '').trim();
                if (childText.length <= 30 && childText.toLowerCase().indexOf('always') === -1) {
                    ownText += ' ' + childText;
                }
            }
        }
        ownText = ownText.trim();
        if (!ownText) ownText = (el.textContent || '').trim();
        return ownText.toLowerCase();
    }

    // --- Diff Protection ---
    function isInDiffEditor(el) {
        if (!config.diffProtectionEnabled) return false;
        var text = getButtonOwnText(el);
        for (var i = 0; i < diffLabels.length; i++) {
            if (text.indexOf(diffLabels[i]) !== -1) return true;
        }
        var parent = el;
        for (var d = 0; d < 5 && parent; d++) {
            var cls = (parent.className || '').toLowerCase();
            if (cls.indexOf('monaco-diff-editor') !== -1 ||
                cls.indexOf('merge-editor') !== -1) return true;
            parent = parent.parentElement;
        }
        return false;
    }

    // --- Banned Command Detection (from MunKhin) ---
    function findNearbyCommandText(el) {
        var commandText = '';
        var container = el.parentElement;
        var depth = 0;
        while (container && depth < 10) {
            var sibling = container.previousElementSibling;
            var siblingCount = 0;
            while (sibling && siblingCount < 5) {
                if (sibling.tagName === 'PRE' || sibling.tagName === 'CODE') {
                    var t = (sibling.textContent || '').trim();
                    if (t.length > 0) commandText += ' ' + t;
                }
                var codeEls = sibling.querySelectorAll ? sibling.querySelectorAll('pre, code, pre code') : [];
                for (var c = 0; c < codeEls.length; c++) {
                    var ct = (codeEls[c].textContent || '').trim();
                    if (ct.length > 0 && ct.length < 5000) commandText += ' ' + ct;
                }
                sibling = sibling.previousElementSibling;
                siblingCount++;
            }
            if (commandText.length > 10) break;
            container = container.parentElement;
            depth++;
        }
        if (el.getAttribute('aria-label')) commandText += ' ' + el.getAttribute('aria-label');
        if (el.getAttribute('title')) commandText += ' ' + el.getAttribute('title');
        return commandText.trim().toLowerCase();
    }

    function isCommandBanned(commandText) {
        var bannedList = config.bannedCommands || [];
        if (bannedList.length === 0 || !commandText) return false;
        var lowerText = commandText.toLowerCase();
        for (var b = 0; b < bannedList.length; b++) {
            var pattern = (bannedList[b] || '').trim();
            if (!pattern) continue;
            try {
                if (pattern.charAt(0) === '/' && pattern.lastIndexOf('/') > 0) {
                    var lastSlash = pattern.lastIndexOf('/');
                    var regex = new RegExp(pattern.substring(1, lastSlash), pattern.substring(lastSlash + 1) || 'i');
                    if (regex.test(commandText)) {
                        _spLog('[BANNED] Blocked by regex: ' + pattern);
                        stats.blocked++;
                        return true;
                    }
                } else {
                    if (lowerText.indexOf(pattern.toLowerCase()) !== -1) {
                        _spLog('[BANNED] Blocked by pattern: ' + pattern);
                        stats.blocked++;
                        return true;
                    }
                }
            } catch(e) {
                if (lowerText.indexOf(pattern.toLowerCase()) !== -1) {
                    stats.blocked++;
                    return true;
                }
            }
        }
        return false;
    }

    // --- Click Verification ---
    function isElementVisible(el) {
        if (!el || !el.isConnected) return false;
        var style = window.getComputedStyle(el);
        var rect = el.getBoundingClientRect();
        return style.display !== 'none' && rect.width > 0 && style.visibility !== 'hidden';
    }

    function waitForDisappear(el, timeout) {
        timeout = timeout || 500;
        return new Promise(function(resolve) {
            var startTime = Date.now();
            var check = function() {
                if (!isElementVisible(el)) { resolve(true); }
                else if (Date.now() - startTime >= timeout) { resolve(false); }
                else { requestAnimationFrame(check); }
            };
            setTimeout(check, 50);
        });
    }

    function isAcceptButton(el) {
        // Guard: only click inside conversation/agent area
        if (!isInConversationArea(el)) return false;

        var text = getButtonOwnText(el);
        if (text.length === 0 || text.length > 100) return false;

        // Reject patterns
        for (var i = 0; i < rejectPatterns.length; i++) {
            if (text.indexOf(rejectPatterns[i]) !== -1) return false;
        }
        // Match click patterns
        var matched = false;
        for (var i = 0; i < config.clickPatterns.length; i++) {
            if (text.indexOf(config.clickPatterns[i].toLowerCase()) !== -1) {
                matched = true; break;
            }
        }
        if (!matched) return false;

        var style = window.getComputedStyle(el);
        var rect = el.getBoundingClientRect();
        if (style.display === 'none' || rect.width === 0 || style.pointerEvents === 'none' || el.disabled) return false;
        if (isInDiffEditor(el)) { stats.blocked++; return false; }

        // Check banned commands for run/execute buttons
        if (text.indexOf('run') !== -1 || text.indexOf('execute') !== -1) {
            var nearbyText = findNearbyCommandText(el);
            if (isCommandBanned(nearbyText)) return false;
        }

        return true;
    }

    // --- "Always run" dropdown handler ---
    var _alwaysRunClicked = false;
    function clickAlwaysRunDropdown() {
        if (_alwaysRunClicked) return false;
        var dropdownSelectors = ['[role="menuitem"]', '[role="option"]', '.dropdown-item', '.menu-item', 'li'];
        for (var s = 0; s < dropdownSelectors.length; s++) {
            var items = queryAll(dropdownSelectors[s]);
            for (var i = 0; i < items.length; i++) {
                var text = (items[i].textContent || '').trim().toLowerCase();
                if (text === 'always run' || text === 'always allow' ||
                    (text.indexOf('always') !== -1 && (text.indexOf('run') !== -1 || text.indexOf('allow') !== -1))) {
                    var st = window.getComputedStyle(items[i]);
                    var rc = items[i].getBoundingClientRect();
                    if (st.display !== 'none' && st.visibility !== 'hidden' && rc.width > 0 && rc.height > 0) {
                        _spLog('Clicking "Always run" dropdown option');
                        items[i].dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
                        _alwaysRunClicked = true;
                        return true;
                    }
                }
            }
        }
        return false;
    }

    // --- Stats ---
    var stats = { clicks: 0, blocked: 0, cycles: 0 };
    window.__autoAcceptGetStats = function() { return stats; };
    window.__autoAcceptResetStats = function() { stats = { clicks: 0, blocked: 0, cycles: 0 }; };

    // --- HTTP Live Sync ---
    function syncConfig() {
        try {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', 'http://127.0.0.1:' + config.httpPort, true);
            xhr.timeout = 1000;
            xhr.onload = function() {
                if (xhr.status === 200) {
                    try {
                        var c = JSON.parse(xhr.responseText);
                        if (c.clickPatterns) config.clickPatterns = c.clickPatterns;
                        if (c.scrollEnabled !== undefined) config.scrollEnabled = c.scrollEnabled;
                        if (c.pauseScrollMs !== undefined) config.scrollPauseMs = c.pauseScrollMs;
                        if (c.scrollIntervalMs !== undefined) config.scrollIntervalMs = c.scrollIntervalMs;
                        if (c.safeClickEnabled !== undefined) config.safeClickEnabled = c.safeClickEnabled;
                        if (c.diffProtectionEnabled !== undefined) config.diffProtectionEnabled = c.diffProtectionEnabled;
                        if (c.bannedCommands) config.bannedCommands = c.bannedCommands;
                        if (c.godMode !== undefined) {
                            config.godMode = c.godMode;
                            rejectPatterns = config.godMode ? baseRejectPatterns : baseRejectPatterns.concat(godModeOnlyPatterns);
                        }
                    } catch(e) {}
                }
            };
            xhr.send();
        } catch(e) {}
    }
    setInterval(syncConfig, 2000);

    // --- Auto Scroll (smart: only deepest scrollable inside agent panel) ---
    var lastUserScroll = 0;
    document.addEventListener('wheel', function() { lastUserScroll = Date.now(); }, { passive: true });

    function findAgentPanel() {
        // Try specific agent panel selectors first
        var panelIds = [
            'antigravity.agentPanel',  // Antigravity agent panel
        ];
        for (var i = 0; i < panelIds.length; i++) {
            try {
                var el = document.getElementById(panelIds[i]);
                if (el && el.offsetHeight > 50) return el;
            } catch(e) {}
        }
        // Try CSS selectors
        var panelSelectors = ['.chat-widget', '.inline-chat'];
        for (var i = 0; i < panelSelectors.length; i++) {
            try {
                var el = document.querySelector(panelSelectors[i]);
                if (el && el.offsetHeight > 50) return el;
            } catch(e) {}
        }
        return null;
    }

    function findDeepestScrollable(root) {
        var best = null;
        var bestDepth = -1;
        try {
            var all = root.querySelectorAll('*');
            for (var i = 0; i < all.length; i++) {
                var el = all[i];
                if (el.scrollHeight <= el.clientHeight + 30) continue;
                if (el.offsetHeight < 50 || el.offsetWidth < 50) continue;
                var style = window.getComputedStyle(el);
                var ov = style.overflowY;
                if (ov !== 'auto' && ov !== 'scroll') continue;
                var depth = 0;
                var p = el;
                while (p && p !== root) { depth++; p = p.parentElement; }
                if (depth > bestDepth) {
                    bestDepth = depth;
                    best = el;
                }
            }
        } catch(e) {}
        return best;
    }

    function autoScroll() {
        if (!config.scrollEnabled) return;
        if (Date.now() - lastUserScroll < config.scrollPauseMs) return;

        var panel = findAgentPanel();
        // In webview context, fall back to document.body if no specific panel found
        if (!panel && _isWebviewContext) panel = document.body;
        if (!panel) return;

        var target = findDeepestScrollable(panel);
        if (target) {
            target.scrollTop = target.scrollHeight;
        }
    }

    setInterval(autoScroll, config.scrollIntervalMs);

    // --- Main Poll Loop ---
    var selectors = ${selectors};
    var interval = ${interval};

    var poll = async function() {
        window.__simplePollRunning = true;
        _spLog('Started (ide=${ide}, interval=' + interval + 'ms)');

        while (window.__simplePollRunning) {
            stats.cycles++;
            var clicked = 0;

            // Try "Always run" dropdown first
            clickAlwaysRunDropdown();

            var verified = 0;
            for (var s = 0; s < selectors.length; s++) {
                var els = queryAll(selectors[s]);
                for (var e = 0; e < els.length; e++) {
                    if (isAcceptButton(els[e])) {
                        var btnText = getButtonOwnText(els[e]);
                        _spLog('Clicking: "' + btnText + '"');
                        els[e].dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
                        clicked++;
                        stats.clicks++;
                        var disappeared = await waitForDisappear(els[e]);
                        if (disappeared) {
                            verified++;
                            _spLog('[Verified] "' + btnText + '" disappeared');
                        }
                    }
                }
            }
            if (clicked > 0) _spLog('Cycle ' + stats.cycles + ': clicked ' + clicked + ', verified ' + verified);
            await new Promise(function(r) { setTimeout(r, interval); });
        }
        _spLog('Stopped');
    };

    window.stopSimplePoll = function() {
        window.__simplePollRunning = false;
        _spLog('Stop requested');
    };

    poll();
})();`;
}

/**
 * Main entry point: returns the appropriate injection script.
 */
function compose(config) {
    config = config || {};

    const useBackground = config.isBackgroundMode;
    console.log(`[Compositor] compose: isBackgroundMode=${config.isBackgroundMode} → ${useBackground ? 'BACKGROUND' : 'SIMPLE POLL'}`);

    if (useBackground) {
        const script = _getBgScript();
        console.log(`[Compositor] Background script loaded (${(script.length / 1024).toFixed(1)}KB)`);
        return script;
    }

    console.log(`[Compositor] Simple poll (ide=${config.ide}, interval=${config.pollInterval})`);
    return _getSimplePollScript(config);
}

module.exports = { compose };