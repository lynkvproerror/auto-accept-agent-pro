/**
 * Background Mode Algorithm — Pro Edition
 *
 * This script runs the background mode clicking/tab-switching algorithm
 * with full verbose logging AND creates a visual overlay showing progress.
 *
 * Pro Features (vs base):
 *   - Stats hooks: __autoAcceptGetStats / __autoAcceptResetStats
 *   - HTTP Live Sync: polls config from extension HTTP server (port 48787)
 *   - Configurable click patterns (from settings panel)
 *   - Auto Scroll: scrolls ONLY agent chat panel to bottom (smart heuristic)
 *   - Safe Click: requires sibling reject button
 *   - Diff Protection: skips diff/merge editor buttons
 *   - Focus state tracking
 *
 * Usage:
 * 1. Injected by cdp-handler.js via CDP
 * 2. Call: startBackgroundLoop('antigravity') or startBackgroundLoop('cursor')
 * 3. Call: stopBackgroundLoop() to stop
 *
 * All logs are prefixed with [BgLoop] for easy filtering.
 */

(function () {
    'use strict';

    // --- Page fingerprint for debugging ---
    const _pageUrl = (window.location && window.location.href) || 'unknown';
    const _pageTitle = (document.title || '').substring(0, 40);
    const _pageFP = `[${_pageTitle}|${_pageUrl.slice(-50)}]`;

    function log(msg) {
        console.log(`[BgLoop]${_pageFP} ${msg}`);
    }

    log('Script loaded (Pro)');

    // ─── Web Worker Timer — bypasses browser throttling in background tabs ───
    // When a browser tab loses focus, setTimeout is throttled to ≥1s and
    // requestAnimationFrame stops completely. A Web Worker runs in its own
    // thread and is NOT subject to these throttling rules.
    const _timerWorkerCode = `self.onmessage=function(e){setTimeout(function(){self.postMessage({id:e.data.id});},e.data.ms);};`;
    let _timerWorker = null;
    let _timerCallbacks = new Map();
    let _timerId = 0;

    function _getTimerWorker() {
        if (!_timerWorker && typeof Worker !== 'undefined' && typeof Blob !== 'undefined') {
            try {
                const blob = new Blob([_timerWorkerCode], { type: 'application/javascript' });
                _timerWorker = new Worker(URL.createObjectURL(blob));
                _timerWorker.onmessage = function (e) {
                    const cb = _timerCallbacks.get(e.data.id);
                    if (cb) { _timerCallbacks.delete(e.data.id); cb(); }
                };
                _timerWorker.onerror = function () {
                    log('[Timer] Web Worker error, falling back to setTimeout');
                    _timerWorker = null;
                };
                log('[Timer] Web Worker initialized for background operation');
            } catch (e) {
                log('[Timer] Web Worker not available, using setTimeout fallback');
            }
        }
        return _timerWorker;
    }

    function workerDelay(ms) {
        return new Promise(function (resolve) {
            const worker = _getTimerWorker();
            if (worker) {
                const id = ++_timerId;
                _timerCallbacks.set(id, resolve);
                worker.postMessage({ id, ms });
            } else {
                setTimeout(resolve, ms);
            }
        });
    }

    // ─── PRO: Stats ──────────────────────────────────────────────────
    var _stats = { clicks: 0, blocked: 0, fileEdits: 0, terminalCommands: 0 };
    window.__autoAcceptGetStats = function () { return _stats; };
    window.__autoAcceptResetStats = function () {
        var old = Object.assign({}, _stats);
        _stats = { clicks: 0, blocked: 0, fileEdits: 0, terminalCommands: 0 };
        return old;
    };

    // ─── PRO: Focus State ────────────────────────────────────────────
    var _isFocused = true;
    window.__autoAcceptSetFocusState = function (focused) { _isFocused = focused; };

    // ─── PRO: Banned Commands ────────────────────────────────────────
    var _bannedCommands = [];
    window.__autoAcceptUpdateBannedCommands = function (cmds) { _bannedCommands = cmds || []; };

    // ─── PRO: Configurable patterns & settings ───────────────────────
    var _config = {
        clickPatterns: ['Run', 'Allow', 'Always Allow', 'Keep Waiting', 'Retry', 'Continue', 'Allow Once', 'Allow This Con', 'Accept all'],
        scrollEnabled: true,
        scrollPauseMs: 7000,
        scrollIntervalMs: 500,
        safeClickEnabled: true,
        diffProtectionEnabled: true,
        httpPort: 48787,
        enabled: true,
        godMode: false
    };

    // ─── PRO: HTTP Live Sync ─────────────────────────────────────────
    function syncConfig() {
        try {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', 'http://127.0.0.1:' + _config.httpPort, true);
            xhr.timeout = 1000;
            xhr.onload = function () {
                if (xhr.status === 200) {
                    try {
                        var c = JSON.parse(xhr.responseText);
                        if (c.clickPatterns) _config.clickPatterns = c.clickPatterns;
                        if (c.scrollEnabled !== undefined) _config.scrollEnabled = c.scrollEnabled;
                        if (c.pauseScrollMs !== undefined) _config.scrollPauseMs = c.pauseScrollMs;
                        if (c.scrollIntervalMs !== undefined) _config.scrollIntervalMs = c.scrollIntervalMs;
                        if (c.safeClickEnabled !== undefined) _config.safeClickEnabled = c.safeClickEnabled;
                        if (c.diffProtectionEnabled !== undefined) _config.diffProtectionEnabled = c.diffProtectionEnabled;
                        if (c.enabled !== undefined) _config.enabled = c.enabled;
                        if (c.bannedCommands) _bannedCommands = c.bannedCommands;
                        if (c.godMode !== undefined) _config.godMode = c.godMode;
                    } catch (e) { }
                }
            };
            xhr.send();
        } catch (e) { }
    }
    setInterval(syncConfig, 2000);

    // ─── Webview context detection (OOPIF agent panel) ───
    var _isWebviewContext = (window.location.protocol === 'vscode-webview:') ||
        !!document.querySelector('.react-app-container') ||
        !!document.querySelector('[data-vscode-context]');

    // ─── PRO: Auto Scroll (smart: only deepest scrollable in agent panel) ───
    var _lastUserScroll = 0;
    document.addEventListener('wheel', function () { _lastUserScroll = Date.now(); }, { passive: true });

    function findAgentPanel() {
        // Try Antigravity agent panel by ID
        try {
            var el = document.getElementById('antigravity.agentPanel');
            if (el && el.offsetHeight > 50) return el;
        } catch (e) { }
        // Try CSS selectors
        var selectors = ['.chat-widget', '.inline-chat'];
        for (var i = 0; i < selectors.length; i++) {
            try {
                var el = document.querySelector(selectors[i]);
                if (el && el.offsetHeight > 50) return el;
            } catch (e) { }
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
        } catch (e) { }
        return best;
    }

    function autoScroll() {
        if (!_config.scrollEnabled) return;
        if (Date.now() - _lastUserScroll < _config.scrollPauseMs) return;

        var panel = findAgentPanel();
        // In webview context, fall back to document.body if no specific panel found
        if (!panel && _isWebviewContext) panel = document.body;
        if (!panel) return;

        var target = findDeepestScrollable(panel);
        if (target) {
            target.scrollTop = target.scrollHeight;
        }
    }
    setInterval(autoScroll, 500);

    // --- OVERLAY CONSTANTS ---
    const OVERLAY_ID = '__autoAcceptBgOverlay';
    const STYLE_ID = '__autoAcceptBgStyles';

    const OVERLAY_STYLES = `
        #__autoAcceptBgOverlay {
            position: fixed;
            background: rgba(0, 0, 0, 0.97);
            z-index: 2147483647;
            font-family: system-ui, -apple-system, sans-serif;
            color: #fff;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.3s ease;
            overflow: hidden;
        }
        #__autoAcceptBgOverlay.visible { opacity: 1; }

        .aab-container {
            width: 90%;
            max-width: 420px;
            padding: 24px;
        }

        .aab-slot {
            margin-bottom: 16px;
            padding: 12px 16px;
            background: rgba(255, 255, 255, 0.03);
            border-radius: 8px;
            border: 1px solid rgba(255, 255, 255, 0.08);
        }

        .aab-header {
            display: flex;
            align-items: center;
            margin-bottom: 8px;
            gap: 10px;
        }

        .aab-name {
            flex: 1;
            font-size: 13px;
            font-weight: 500;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            color: #e0e0e0;
        }

        .aab-status {
            font-size: 10px;
            font-weight: 600;
            letter-spacing: 0.5px;
            text-transform: uppercase;
            padding: 3px 8px;
            border-radius: 4px;
        }

        .aab-slot.in-progress .aab-status {
            color: #a855f7;
            background: rgba(168, 85, 247, 0.15);
        }

        .aab-slot.completed .aab-status {
            color: #22c55e;
            background: rgba(34, 197, 94, 0.15);
        }

        .aab-progress-track {
            height: 4px;
            background: rgba(255, 255, 255, 0.08);
            border-radius: 2px;
            overflow: hidden;
        }

        .aab-progress-fill {
            height: 100%;
            border-radius: 2px;
            transition: width 0.4s ease, background 0.3s ease;
        }

        .aab-slot.in-progress .aab-progress-fill {
            width: 60%;
            background: linear-gradient(90deg, #a855f7, #8b5cf6);
            animation: pulse-progress 1.5s ease-in-out infinite;
        }

        .aab-slot.completed .aab-progress-fill {
            width: 100%;
            background: linear-gradient(90deg, #22c55e, #16a34a);
        }

        @keyframes pulse-progress {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.6; }
        }
    `;

    // --- UTILS ---
    const getDocuments = (root = document) => {
        let docs = [root];
        try {
            const iframes = root.querySelectorAll('iframe, frame');
            for (const iframe of iframes) {
                try {
                    const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
                    if (iframeDoc) docs.push(...getDocuments(iframeDoc));
                } catch (e) { }
            }
        } catch (e) { }
        return docs;
    };

    const queryAll = (selector) => {
        const results = [];
        getDocuments().forEach(doc => {
            try { results.push(...Array.from(doc.querySelectorAll(selector))); } catch (e) { }
        });
        // Shadow DOM piercing
        try {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
            let node;
            while ((node = walker.nextNode())) {
                if (node.shadowRoot) {
                    try {
                        const shadowEls = node.shadowRoot.querySelectorAll(selector);
                        for (const el of shadowEls) {
                            if (!results.includes(el)) results.push(el);
                        }
                    } catch (e) { }
                }
            }
        } catch (e) { }
        return results;
    };

    const stripTimeSuffix = (text) => {
        return (text || '').trim().replace(/\s*\d+[smh]$/, '').trim();
    };

    const deduplicateNames = (names) => {
        const counts = {};
        return names.map(name => {
            if (counts[name] === undefined) {
                counts[name] = 1;
                return name;
            } else {
                counts[name]++;
                return `${name} (${counts[name]})`;
            }
        });
    };

    const updateTabNames = (tabs) => {
        const rawNames = Array.from(tabs).map((tab, idx) => {
            const fullText = tab.textContent.trim();
            const lines = fullText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

            if (lines.length > 0) {
                const lastLine = lines[lines.length - 1];
                if (lastLine.length > 0 && lastLine.length < 100) {
                    return stripTimeSuffix(lastLine);
                }

                for (let i = lines.length - 1; i >= 0; i--) {
                    const line = lines[i];
                    if (line.length > 0 && line.length < 100 && !line.startsWith('//') && !line.startsWith('/*') && !line.includes('{')) {
                        return stripTimeSuffix(line);
                    }
                }
            }

            return stripTimeSuffix(fullText.substring(0, 50));
        });
        const tabNames = deduplicateNames(rawNames);

        if (tabNames.length === 0 && window.__bgLoopState?.tabNames?.length > 0) {
            return;
        }

        const tabNamesChanged = JSON.stringify(window.__bgLoopState?.tabNames) !== JSON.stringify(tabNames);

        if (tabNamesChanged) {
            log(`updateTabNames: Detected ${tabNames.length} tabs: ${tabNames.join(', ')}`);
            if (window.__bgLoopState) {
                window.__bgLoopState.tabNames = tabNames;
            }
        }

        if (tabNames.length >= 3) {
            const container = document.getElementById(OVERLAY_ID + '-c');
            const needsLoad = tabNamesChanged || (container && container.children.length === 0);
            if (needsLoad) {
                loadTabsOntoOverlay(tabNames);
            }
        }
    };

    // --- OVERLAY FUNCTIONS ---
    function mountOverlay() {
        if (document.getElementById(OVERLAY_ID)) {
            log('[Overlay] Already mounted');
            return;
        }

        log('[Overlay] Mounting overlay...');

        if (!document.getElementById(STYLE_ID)) {
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = OVERLAY_STYLES;
            document.head.appendChild(style);
        }

        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;

        const container = document.createElement('div');
        container.className = 'aab-container';
        container.id = OVERLAY_ID + '-c';

        overlay.appendChild(container);
        document.body.appendChild(overlay);

        const panelSelectors = [
            '#antigravity\\.agentPanel',
            '#workbench\\.parts\\.auxiliarybar',
            '.auxiliary-bar-container',
            '#workbench\\.parts\\.sidebar'
        ];

        let panel = null;
        for (const selector of panelSelectors) {
            const found = queryAll(selector).find(p => p.offsetWidth > 50);
            if (found) {
                panel = found;
                log(`[Overlay] Found AI panel: ${selector}`);
                break;
            }
        }

        const syncPosition = () => {
            if (panel) {
                const rect = panel.getBoundingClientRect();
                overlay.style.top = rect.top + 'px';
                overlay.style.left = rect.left + 'px';
                overlay.style.width = rect.width + 'px';
                overlay.style.height = rect.height + 'px';
            } else {
                overlay.style.top = '0';
                overlay.style.left = '0';
                overlay.style.width = '100%';
                overlay.style.height = '100%';
            }
        };

        syncPosition();

        if (panel) {
            const resizeObserver = new ResizeObserver(syncPosition);
            resizeObserver.observe(panel);
            overlay._resizeObserver = resizeObserver;
        }

        requestAnimationFrame(() => overlay.classList.add('visible'));
        log('[Overlay] Overlay mounted');
    }

    function dismountOverlay() {
        const overlay = document.getElementById(OVERLAY_ID);
        if (!overlay) return;

        log('[Overlay] Dismounting overlay...');
        if (overlay._resizeObserver) {
            overlay._resizeObserver.disconnect();
        }
        overlay.classList.remove('visible');
        setTimeout(() => overlay.remove(), 300);
    }

    function loadTabsOntoOverlay(tabNames) {
        const container = document.getElementById(OVERLAY_ID + '-c');
        if (!container) return;
        if (!tabNames || tabNames.length === 0) return;

        log(`[Overlay] Loading ${tabNames.length} tabs onto overlay`);

        while (container.firstChild) {
            container.removeChild(container.firstChild);
        }

        const completionStatus = window.__bgLoopState?.completionStatus || {};

        tabNames.forEach(name => {
            const isCompleted = completionStatus[name] === 'done' || completionStatus[name] === 'done-errors';
            const stateClass = isCompleted ? 'completed' : 'in-progress';
            const statusText = isCompleted ? 'COMPLETED' : 'IN PROGRESS';

            const slot = document.createElement('div');
            slot.className = `aab-slot ${stateClass}`;
            slot.setAttribute('data-name', name);

            const header = document.createElement('div');
            header.className = 'aab-header';

            const nameSpan = document.createElement('span');
            nameSpan.className = 'aab-name';
            nameSpan.textContent = name;
            header.appendChild(nameSpan);

            const statusSpan = document.createElement('span');
            statusSpan.className = 'aab-status';
            statusSpan.textContent = statusText;
            header.appendChild(statusSpan);

            slot.appendChild(header);

            const track = document.createElement('div');
            track.className = 'aab-progress-track';
            const fill = document.createElement('div');
            fill.className = 'aab-progress-fill';
            track.appendChild(fill);
            slot.appendChild(track);

            container.appendChild(slot);
        });
    }

    function markTabCompleted(tabName) {
        const container = document.getElementById(OVERLAY_ID + '-c');
        if (!container) return;

        const slots = container.querySelectorAll('.aab-slot');
        for (const slot of slots) {
            if (slot.getAttribute('data-name') === tabName) {
                if (!slot.classList.contains('completed')) {
                    log(`[Overlay] Marking "${tabName}" as completed`);
                    slot.classList.remove('in-progress');
                    slot.classList.add('completed');
                    const statusSpan = slot.querySelector('.aab-status');
                    if (statusSpan) statusSpan.textContent = 'COMPLETED';
                }
                break;
            }
        }
    }

    // --- PRO: BUTTON CLICKING (with conversation area guard, diff protection) ---
    // When God Mode is ON, 'always allow/run/proceed/auto' are REMOVED from reject
    const baseRejectPatterns = ['skip', 'reject', 'cancel', 'close', 'refine', 'deny', 'no', 'dismiss', 'abort', 'ask every time'];
    const godModeOnlyPatterns = ['always run', 'always allow', 'always proceed', 'always auto'];
    function getRejectPatterns() {
        return _config.godMode ? baseRejectPatterns : baseRejectPatterns.concat(godModeOnlyPatterns);
    }
    const diffLabels = ['accept changes', 'accept incoming', 'accept current',
        'accept both', 'use theirs', 'use ours', 'use mine'];

    // --- Conversation Area Guard (excludes sidebar, editor, toolbar) ---
    function isInConversationArea(el) {
        // In webview context, the ENTIRE page IS the agent panel — always allow
        if (_isWebviewContext) return true;
        // When Conversation Guard is OFF, skip area check
        if (!_config.safeClickEnabled) return true;
        const excludedSelectors = [
            '#workbench\\.parts\\.sidebar',
            '#workbench\\.parts\\.activitybar',
            '#workbench\\.parts\\.titlebar',
            '#workbench\\.parts\\.statusbar',
            '#workbench\\.parts\\.editor',
            '.menubar-menu-button',
            '.title-actions',
            '[class*="explorer"]',
            '.tabs-container',
            '.composite.viewlet',
            '.sidebar',
            '.activity-bar-container'
        ];
        for (const selector of excludedSelectors) {
            try { if (el.closest(selector)) return false; } catch (e) { }
        }
        const includedSelectors = [
            '#antigravity\\.agentPanel',
            '#workbench\\.parts\\.auxiliarybar',
            '[class*="agent"]',
            '[class*="chat"]',
            '[class*="conversation"]',
            '[class*="agentic"]'
        ];
        for (const selector of includedSelectors) {
            try { if (el.closest(selector)) return true; } catch (e) { }
        }
        return true;
    }

    // --- Get button own text (avoids checkbox/label text bleed) ---
    function getButtonOwnText(el) {
        let ownText = '';
        for (const node of el.childNodes) {
            if (node.nodeType === 3) {
                ownText += node.textContent;
            } else if (node.nodeType === 1) {
                const tag = (node.tagName || '').toLowerCase();
                if (tag === 'input' || tag === 'label' || tag === 'checkbox') continue;
                const childText = (node.textContent || '').trim();
                if (childText.length <= 30 && !childText.toLowerCase().includes('always')) {
                    ownText += ' ' + childText;
                }
            }
        }
        ownText = ownText.trim();
        if (!ownText) ownText = (el.textContent || '').trim();
        return ownText.toLowerCase();
    }

    function isInDiffEditor(el) {
        if (!_config.diffProtectionEnabled) return false;
        const text = getButtonOwnText(el);
        for (const label of diffLabels) {
            if (text.includes(label)) return true;
        }
        let parent = el;
        for (let d = 0; d < 5 && parent; d++) {
            const cls = (parent.className || '').toLowerCase();
            if (cls.includes('monaco-diff-editor') || cls.includes('merge-editor')) return true;
            parent = parent.parentElement;
        }
        return false;
    }

    function isAcceptButton(el) {
        if (!isInConversationArea(el)) return false;

        const text = getButtonOwnText(el);
        if (text.length === 0 || text.length > 100) return false;

        if (getRejectPatterns().some(r => text.includes(r))) return false;

        const patterns = _config.clickPatterns.map(p => p.toLowerCase());
        if (!patterns.some(p => text.includes(p))) return false;

        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (style.display === 'none' || rect.width === 0 || style.pointerEvents === 'none' || el.disabled) return false;

        if (isInDiffEditor(el)) {
            _stats.blocked++;
            return false;
        }

        // Check banned commands for run/execute buttons
        if (text.includes('run') || text.includes('execute')) {
            const nearbyText = findNearbyCommandText(el);
            if (isCommandBanned(nearbyText)) return false;
        }

        return true;
    }

    // --- Banned Command Detection (from MunKhin) ---
    function findNearbyCommandText(el) {
        let commandText = '';
        let container = el.parentElement;
        let depth = 0;
        while (container && depth < 10) {
            let sibling = container.previousElementSibling;
            let siblingCount = 0;
            while (sibling && siblingCount < 5) {
                if (sibling.tagName === 'PRE' || sibling.tagName === 'CODE') {
                    const t = (sibling.textContent || '').trim();
                    if (t.length > 0) commandText += ' ' + t;
                }
                const codeEls = sibling.querySelectorAll ? sibling.querySelectorAll('pre, code, pre code') : [];
                for (const codeEl of codeEls) {
                    const ct = (codeEl.textContent || '').trim();
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
        if (_bannedCommands.length === 0 || !commandText) return false;
        const lowerText = commandText.toLowerCase();
        for (const banned of _bannedCommands) {
            const pattern = (banned || '').trim();
            if (!pattern) continue;
            try {
                if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
                    const lastSlash = pattern.lastIndexOf('/');
                    const regex = new RegExp(pattern.substring(1, lastSlash), pattern.substring(lastSlash + 1) || 'i');
                    if (regex.test(commandText)) {
                        log(`[BANNED] Blocked by regex: ${pattern}`);
                        _stats.blocked++;
                        return true;
                    }
                } else {
                    if (lowerText.includes(pattern.toLowerCase())) {
                        log(`[BANNED] Blocked by pattern: "${pattern}"`);
                        _stats.blocked++;
                        return true;
                    }
                }
            } catch (e) {
                if (lowerText.includes(pattern.toLowerCase())) {
                    _stats.blocked++;
                    return true;
                }
            }
        }
        return false;
    }

    // --- "Always run" dropdown handler ---
    let _alwaysRunClicked = false;
    function clickAlwaysRunDropdown() {
        if (_alwaysRunClicked) return false;
        const dropdownSelectors = ['[role="menuitem"]', '[role="option"]', '.dropdown-item', '.menu-item', 'li'];
        for (const selector of dropdownSelectors) {
            const items = queryAll(selector);
            for (const item of items) {
                const text = (item.textContent || '').trim().toLowerCase();
                if (text === 'always run' || text === 'always allow' ||
                    (text.includes('always') && (text.includes('run') || text.includes('allow')))) {
                    const st = window.getComputedStyle(item);
                    const rc = item.getBoundingClientRect();
                    if (st.display !== 'none' && st.visibility !== 'hidden' && rc.width > 0 && rc.height > 0) {
                        log('Clicking "Always run" dropdown option');
                        item.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
                        _alwaysRunClicked = true;
                        return true;
                    }
                }
            }
        }
        return false;
    }

    function isElementVisible(el) {
        if (!el || !el.isConnected) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && rect.width > 0 && style.visibility !== 'hidden';
    }

    function waitForDisappear(el, timeout = 500) {
        return new Promise(resolve => {
            const startTime = Date.now();
            const check = () => {
                if (!isElementVisible(el)) {
                    resolve(true);
                } else if (Date.now() - startTime >= timeout) {
                    resolve(false);
                } else {
                    setTimeout(check, 50);  // Use setTimeout instead of rAF — rAF stops when window loses focus
                }
            };
            setTimeout(check, 50);
        });
    }

    async function performClick(selectors) {
        // Try "Always run" dropdown first
        clickAlwaysRunDropdown();

        const found = [];
        selectors.forEach(s => queryAll(s).forEach(el => found.push(el)));
        let clicked = 0;
        let verified = 0;
        const uniqueFound = [...new Set(found)];

        for (const el of uniqueFound) {
            if (isAcceptButton(el)) {
                const buttonText = getButtonOwnText(el);
                log(`Clicking: "${buttonText}"`);

                el.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
                clicked++;
                _stats.clicks++;

                const disappeared = await waitForDisappear(el);

                if (disappeared) {
                    verified++;
                    log(`[Stats] Click verified: "${buttonText}"`);
                } else {
                    log(`[Stats] Click not verified: "${buttonText}"`);
                }
            }
        }

        if (clicked > 0) {
            log(`[Click] Attempted: ${clicked}, Verified: ${verified}`);
        }
        return verified;
    }

    // --- COMPILATION ERROR DETECTION ---
    function hasCompilationErrors() {
        const errorBadges = queryAll('.codicon-error, .codicon-warning, [class*="marker-count"]');
        for (const badge of errorBadges) {
            const text = (badge.textContent || '').trim();
            const num = parseInt(text, 10);
            if (!isNaN(num) && num > 0) return true;
        }

        const errorDecorations = queryAll('.squiggly-error, .monaco-editor .squiggly-error');
        if (errorDecorations.length > 0) return true;

        return false;
    }

    // --- COMPLETION STATE ---
    const updateConversationCompletionState = (rawTabName, status) => {
        const tabName = stripTimeSuffix(rawTabName);
        const current = window.__bgLoopState?.completionStatus?.[tabName];
        if (current !== status) {
            log(`[State] ${tabName}: ${current} → ${status}`);
            if (window.__bgLoopState) {
                window.__bgLoopState.completionStatus[tabName] = status;
            }
        }
    };

    // --- CURSOR LOOP ---
    async function cursorLoop(sid) {
        log('[Loop] cursorLoop STARTED');
        let index = 0;
        let cycle = 0;
        const state = window.__bgLoopState;
        state._noTabCycles = 0;

        while (state.isRunning && state.sessionID === sid) {
            cycle++;

            const clicked = await performClick(['button', '[class*="button"]', '[class*="anysphere"]']);
            log(`[Loop] Cycle ${cycle}: Clicked ${clicked} buttons`);

            await workerDelay(800);

            const tabSelectors = [
                '#workbench\\.parts\\.auxiliarybar ul[role="tablist"] li[role="tab"]',
                '.monaco-pane-view .monaco-list-row[role="listitem"]',
                'div[role="tablist"] div[role="tab"]',
                '.chat-session-item'
            ];

            let tabs = [];
            for (const selector of tabSelectors) {
                tabs = queryAll(selector);
                if (tabs.length > 0) break;
            }

            if (tabs.length === 0) {
                state._noTabCycles++;
            } else {
                state._noTabCycles = 0;
            }

            updateTabNames(tabs);

            if (tabs.length > 0) {
                const targetTab = tabs[index % tabs.length];
                const tabLabel = targetTab.getAttribute('aria-label') || targetTab.textContent?.trim() || 'unnamed tab';
                log(`[Loop] Cycle ${cycle}: Tab "${tabLabel}"`);
                targetTab.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
                index++;
            }

            await workerDelay(3000);
        }
        log('[Loop] cursorLoop STOPPED');
    }

    // --- ANTIGRAVITY LOOP ---
    async function antigravityLoop(sid) {
        log('[Loop] antigravityLoop STARTED');
        let index = 0;
        let cycle = 0;
        const state = window.__bgLoopState;
        state._noTabCycles = 0;

        while (state.isRunning && state.sessionID === sid) {
            cycle++;

            const allSpans = queryAll('span');
            const feedbackBadges = allSpans.filter(s => {
                const t = s.textContent.trim();
                return t === 'Good' || t === 'Bad';
            });
            const hasBadge = feedbackBadges.length > 0;

            let clicked = 0;
            if (!hasBadge) {
                clicked = await performClick(['.bg-ide-button-background']);
                log(`[Loop] Cycle ${cycle}: Clicked ${clicked} accept buttons`);
            } else {
                log(`[Loop] Cycle ${cycle}: Skipping clicks - conversation DONE (has badge)`);
            }

            await workerDelay(800);

            const nt = queryAll("[data-tooltip-id='new-conversation-tooltip']")[0];
            if (nt) {
                nt.click();
            }
            await workerDelay(1500);

            const tabsAfter = queryAll('button.grow');

            if (tabsAfter.length === 0) {
                state._noTabCycles++;
            } else {
                state._noTabCycles = 0;
            }

            updateTabNames(tabsAfter);

            let clickedTabName = null;
            if (tabsAfter.length > 0) {
                const targetTab = tabsAfter[index % tabsAfter.length];
                clickedTabName = stripTimeSuffix(targetTab.textContent);
                log(`[Loop] Cycle ${cycle}: Tab "${clickedTabName}"`);
                targetTab.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
                index++;
            }

            await workerDelay(1500);

            const allSpansAfter = queryAll('span');
            const feedbackTexts = allSpansAfter
                .filter(s => {
                    const t = s.textContent.trim();
                    return t === 'Good' || t === 'Bad';
                })
                .map(s => s.textContent.trim());

            if (clickedTabName && feedbackTexts.length > 0) {
                const hasErrors = hasCompilationErrors();
                const finalStatus = hasErrors ? 'done-errors' : 'done';
                updateConversationCompletionState(clickedTabName, finalStatus);

                const deduplicatedNames = state.tabNames || [];
                const currentIndex = (index - 1) % deduplicatedNames.length;
                const deduplicatedName = deduplicatedNames[currentIndex];
                if (deduplicatedName) {
                    markTabCompleted(deduplicatedName);
                }
            }

            await workerDelay(3000);
        }
        log('[Loop] antigravityLoop STOPPED');
    }

    // --- PUBLIC API ---
    window.startBackgroundLoop = function (ide = 'antigravity') {
        log(`startBackgroundLoop called: ide=${ide}`);

        if (!window.__bgLoopState) {
            window.__bgLoopState = {
                isRunning: false,
                tabNames: [],
                completionStatus: {},
                sessionID: 0,
                _noTabCycles: 0
            };
        }

        const state = window.__bgLoopState;

        if (state.isRunning) {
            log('Already running, stopping previous session...');
            state.isRunning = false;
        }

        state.isRunning = true;
        state.sessionID++;
        const sid = state.sessionID;

        mountOverlay();

        log(`Starting ${ide} loop (session ID: ${sid})...`);

        if (ide.toLowerCase() === 'cursor') {
            cursorLoop(sid);
        } else {
            antigravityLoop(sid);
        }

        log('✅ Background loop started!');
    };

    window.stopBackgroundLoop = function () {
        if (window.__bgLoopState) {
            window.__bgLoopState.isRunning = false;
            window.__bgLoopState._noTabCycles = 0;
            dismountOverlay();
            log('Background loop stopped.');
        } else {
            log('No loop running.');
        }
    };

    log('✅ Script initialized (Pro). Ready to start.');
})();
