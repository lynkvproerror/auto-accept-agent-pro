/**
 * auto_accept.js — Unified Injected Script
 *
 * Self-contained script injected into IDE browser pages via CDP.
 * Handles both simple polling and background mode with tab cycling.
 *
 * Features:
 *   - DOM traversal across iframes
 *   - Button detection (accept/run/retry/apply/execute/confirm)
 *   - Reject filtering (skip/reject/cancel/close/refine)
 *   - Banned command detection
 *   - Background mode overlay with progress UI
 *   - Tab cycling for Cursor and Antigravity
 *   - Completion detection (Good/Bad badges, compilation errors)
 *   - Public API: __autoAcceptStart, __autoAcceptStop, __autoAcceptGetStats
 */

(function () {
    'use strict';

    // ─── Logging ─────────────────────────────────────────────────
    function log(msg) {
        console.log('[AutoAccept] ' + msg);
    }

    log('Script loaded');

    // Unique ID for this injection instance (used for BG loop dedup)
    const WINDOW_ID = 'bg-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);

    // ─── Selectors ───────────────────────────────────────────────
    const SELECTORS = {
        panels: [
            '#antigravity\\.agentPanel',
            '#workbench\\.parts\\.auxiliarybar',
            '.auxiliary-bar-container',
            '#workbench\\.parts\\.sidebar'
        ],
        cursorTabs: [
            '#workbench\\.parts\\.auxiliarybar ul[role="tablist"] li[role="tab"]',
            '.monaco-pane-view .monaco-list-row[role="listitem"]',
            'div[role="tablist"] div[role="tab"]',
            '.chat-session-item'
        ],
        antigravityTabs: 'button.grow',
        cursorButtons: ['button', '[class*="button"]', '[class*="anysphere"]'],
        antigravityButtons: ['.bg-ide-button-background'],
        newConversation: "[data-tooltip-id='new-conversation-tooltip']",
        overlayId: '__autoAcceptBgOverlay',
        overlayContainerId: '__autoAcceptBgOverlay-c',
        overlayStyleId: '__autoAcceptBgStyles',
        badgeTag: 'span',
        badgeTexts: ['Good', 'Bad'],
        errorBadges: '.codicon-error, .codicon-warning, [class*="marker-count"]',
        errorSquiggles: '.squiggly-error, .monaco-editor .squiggly-error',
        errorSpanTexts: ['error', 'failed', 'compilation error'],
        commandElements: ['pre', 'code', 'pre code'],
        acceptPatterns: ['accept', 'run', 'retry', 'apply', 'execute', 'confirm', 'allow once', 'allow'],
        rejectPatterns: ['skip', 'reject', 'cancel', 'close', 'refine']
    };

    // ─── DOM Utilities ───────────────────────────────────────────
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

    // ─── Overlay System ──────────────────────────────────────────
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

    function mountOverlay() {
        if (document.getElementById(SELECTORS.overlayId)) {
            log('[Overlay] Already mounted');
            return;
        }

        log('[Overlay] Mounting...');

        if (!document.getElementById(SELECTORS.overlayStyleId)) {
            const style = document.createElement('style');
            style.id = SELECTORS.overlayStyleId;
            style.textContent = OVERLAY_STYLES;
            document.head.appendChild(style);
        }

        const overlay = document.createElement('div');
        overlay.id = SELECTORS.overlayId;

        const container = document.createElement('div');
        container.className = 'aab-container';
        container.id = SELECTORS.overlayContainerId;

        overlay.appendChild(container);
        document.body.appendChild(overlay);

        // Find AI panel
        let panel = null;
        for (const selector of SELECTORS.panels) {
            const found = queryAll(selector).find(p => p.offsetWidth > 50);
            if (found) {
                panel = found;
                log(`[Overlay] Anchored to panel: ${selector}`);
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
        log('[Overlay] Mounted');
    }

    function dismountOverlay() {
        const overlay = document.getElementById(SELECTORS.overlayId);
        if (!overlay) return;

        log('[Overlay] Dismounting...');
        if (overlay._resizeObserver) {
            overlay._resizeObserver.disconnect();
        }
        overlay.classList.remove('visible');
        setTimeout(() => overlay.remove(), 300);
    }

    function loadTabsOntoOverlay(tabNames) {
        const container = document.getElementById(SELECTORS.overlayContainerId);
        if (!container || !tabNames || tabNames.length === 0) return;

        log(`[Overlay] Loading ${tabNames.length} tabs`);

        // Clear safely
        while (container.firstChild) {
            container.removeChild(container.firstChild);
        }

        const completionStatus = window.__autoAcceptState?.completionStatus || {};

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
        const container = document.getElementById(SELECTORS.overlayContainerId);
        if (!container) return;

        const slots = container.querySelectorAll('.aab-slot');
        for (const slot of slots) {
            if (slot.getAttribute('data-name') === tabName) {
                if (!slot.classList.contains('completed')) {
                    log(`[Overlay] Marking "${tabName}" as COMPLETED`);
                    slot.classList.remove('in-progress');
                    slot.classList.add('completed');
                    const statusSpan = slot.querySelector('.aab-status');
                    if (statusSpan) statusSpan.textContent = 'COMPLETED';
                }
                break;
            }
        }
    }

    // ─── Tab Name Management ─────────────────────────────────────
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

        if (tabNames.length === 0 && window.__autoAcceptState?.tabNames?.length > 0) {
            return; // Keep previous state during DOM refresh
        }

        const tabNamesChanged = JSON.stringify(window.__autoAcceptState?.tabNames) !== JSON.stringify(tabNames);

        if (tabNamesChanged) {
            log(`[Tabs] Detected ${tabNames.length} tabs: ${tabNames.join(', ')}`);
            if (window.__autoAcceptState) {
                window.__autoAcceptState.tabNames = tabNames;
            }
        }

        if (tabNames.length >= 3) {
            const container = document.getElementById(SELECTORS.overlayContainerId);
            const needsLoad = tabNamesChanged || (container && container.children.length === 0);
            if (needsLoad) {
                loadTabsOntoOverlay(tabNames);
            }
        }
    };

    // ─── Banned Command Detection ────────────────────────────────
    function findNearbyCommandText(el) {
        let commandText = '';

        let container = el.parentElement;
        let depth = 0;
        while (container && depth < 10) {
            let sibling = container.previousElementSibling;
            let siblingCount = 0;
            while (sibling && siblingCount < 5) {
                if (sibling.tagName === 'PRE' || sibling.tagName === 'CODE') {
                    const text = sibling.textContent.trim();
                    if (text.length > 0) commandText += ' ' + text;
                }
                for (const selector of SELECTORS.commandElements) {
                    const codeElements = sibling.querySelectorAll(selector);
                    for (const codeEl of codeElements) {
                        if (codeEl?.textContent) {
                            const text = codeEl.textContent.trim();
                            if (text.length > 0 && text.length < 5000) commandText += ' ' + text;
                        }
                    }
                }
                sibling = sibling.previousElementSibling;
                siblingCount++;
            }
            if (commandText.length > 10) break;
            container = container.parentElement;
            depth++;
        }

        if (commandText.length === 0) {
            let btnSibling = el.previousElementSibling;
            let count = 0;
            while (btnSibling && count < 3) {
                for (const selector of SELECTORS.commandElements) {
                    const codeElements = btnSibling.querySelectorAll ? btnSibling.querySelectorAll(selector) : [];
                    for (const codeEl of codeElements) {
                        if (codeEl?.textContent) commandText += ' ' + codeEl.textContent.trim();
                    }
                }
                btnSibling = btnSibling.previousElementSibling;
                count++;
            }
        }

        if (el.getAttribute('aria-label')) commandText += ' ' + el.getAttribute('aria-label');
        if (el.getAttribute('title')) commandText += ' ' + el.getAttribute('title');

        return commandText.trim().toLowerCase();
    }

    function isCommandBanned(commandText) {
        const bannedList = window.__autoAcceptState?.bannedCommands || [];
        if (bannedList.length === 0 || !commandText) return false;

        const lowerText = commandText.toLowerCase();

        for (const banned of bannedList) {
            const pattern = banned.trim();
            if (!pattern) continue;

            try {
                if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
                    const lastSlash = pattern.lastIndexOf('/');
                    const regex = new RegExp(pattern.substring(1, lastSlash), pattern.substring(lastSlash + 1) || 'i');
                    if (regex.test(commandText)) {
                        log(`[BANNED] Blocked by regex: ${pattern}`);
                        window.__autoAcceptState.blocked++;
                        return true;
                    }
                } else {
                    if (lowerText.includes(pattern.toLowerCase())) {
                        log(`[BANNED] Blocked by pattern: "${pattern}"`);
                        window.__autoAcceptState.blocked++;
                        return true;
                    }
                }
            } catch (e) {
                if (lowerText.includes(pattern.toLowerCase())) {
                    log(`[BANNED] Blocked (fallback): "${pattern}"`);
                    window.__autoAcceptState.blocked++;
                    return true;
                }
            }
        }
        return false;
    }

    // ─── Button Detection & Clicking ─────────────────────────────
    function isAcceptButton(el) {
        const text = (el.textContent || "").trim().toLowerCase();
        if (text.length === 0 || text.length > 50) return false;

        if (SELECTORS.rejectPatterns.some(r => text.includes(r))) return false;
        if (!SELECTORS.acceptPatterns.some(p => text.includes(p))) return false;

        // Check banned commands for run/execute buttons
        if (text.includes('run command') || text.includes('execute') || text.includes('run')) {
            const nearbyText = findNearbyCommandText(el);
            if (isCommandBanned(nearbyText)) return false;
        }

        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && rect.width > 0 && style.pointerEvents !== 'none' && !el.disabled;
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
                if (!isElementVisible(el)) resolve(true);
                else if (Date.now() - startTime >= timeout) resolve(false);
                else requestAnimationFrame(check);
            };
            setTimeout(check, 50);
        });
    }

    async function performClick(selectors) {
        const found = [];
        selectors.forEach(s => queryAll(s).forEach(el => found.push(el)));
        const uniqueFound = [...new Set(found)];
        let clicked = 0;

        for (const el of uniqueFound) {
            if (isAcceptButton(el)) {
                const buttonText = (el.textContent || "").trim();
                log(`[Click] "${buttonText}"`);
                el.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
                clicked++;

                const disappeared = await waitForDisappear(el);
                if (disappeared) {
                    window.__autoAcceptState.clicks++;
                }
            }
        }
        return clicked;
    }

    // ─── Compilation Error Detection ─────────────────────────────
    function hasCompilationErrors() {
        const errorBadges = queryAll(SELECTORS.errorBadges);
        for (const badge of errorBadges) {
            const text = (badge.textContent || '').trim();
            const num = parseInt(text, 10);
            if (!isNaN(num) && num > 0) return true;
        }

        const errorDecorations = queryAll(SELECTORS.errorSquiggles);
        if (errorDecorations.length > 0) return true;

        const errorSpans = queryAll('span').filter(s => {
            const t = s.textContent.trim().toLowerCase();
            return SELECTORS.errorSpanTexts.includes(t);
        });
        if (errorSpans.length > 0) return true;

        return false;
    }

    // ─── Completion State ────────────────────────────────────────
    const updateConversationCompletionState = (deduplicatedName, status) => {
        const current = window.__autoAcceptState?.completionStatus?.[deduplicatedName];
        if (current !== status) {
            log(`[State] ${deduplicatedName}: ${current} → ${status}`);
            if (window.__autoAcceptState) {
                window.__autoAcceptState.completionStatus[deduplicatedName] = status;
                markTabCompleted(deduplicatedName);
            }
        }
    };

    // ─── Cursor Background Loop ──────────────────────────────────
    async function cursorLoop(sid) {
        log('[Loop] cursorLoop STARTED');
        let index = 0;
        let cycle = 0;
        const state = window.__autoAcceptState;
        state._noTabCycles = 0;

        while (state.isRunning && state.sessionID === sid) {
            cycle++;

            const clicked = await performClick(SELECTORS.cursorButtons);
            if (clicked > 0) log(`[Loop ${cycle}] Clicked ${clicked} buttons`);

            await new Promise(r => setTimeout(r, 800));

            let tabs = [];
            for (const selector of SELECTORS.cursorTabs) {
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
                const tabLabel = targetTab.getAttribute('aria-label') || targetTab.textContent?.trim() || '?';
                log(`[Loop ${cycle}] Rotating to tab "${stripTimeSuffix(tabLabel)}"`);
                targetTab.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
                index++;
            }

            await new Promise(r => setTimeout(r, 3000));
        }
        log('[Loop] cursorLoop STOPPED');
    }

    // ─── Antigravity Background Loop ─────────────────────────────
    async function antigravityLoop(sid) {
        log('[Loop] antigravityLoop STARTED');
        let index = 0;
        let cycle = 0;
        const state = window.__autoAcceptState;
        state._noTabCycles = 0;

        while (state.isRunning && state.sessionID === sid) {
            cycle++;

            // Check for completion badges BEFORE clicking
            const feedbackBadges = queryAll(SELECTORS.badgeTag).filter(s => {
                const t = s.textContent.trim();
                return SELECTORS.badgeTexts.includes(t);
            });
            const hasBadge = feedbackBadges.length > 0;

            if (!hasBadge) {
                const clicked = await performClick(SELECTORS.antigravityButtons);
                if (clicked > 0) log(`[Loop ${cycle}] Clicked ${clicked} accept buttons`);
            } else {
                log(`[Loop ${cycle}] Conversation DONE (badge found), skipping clicks`);
            }

            await new Promise(r => setTimeout(r, 800));

            // Click tab panel button to show conversations
            const nt = queryAll(SELECTORS.newConversation)[0];
            if (nt) nt.click();

            // Poll for tabs with timeout
            let tabsAfter = [];
            const panelWaitStart = Date.now();
            while (Date.now() - panelWaitStart < 5000) {
                await new Promise(r => setTimeout(r, 300));
                tabsAfter = queryAll(SELECTORS.antigravityTabs);
                if (tabsAfter.length > 0) break;
            }

            if (tabsAfter.length === 0) {
                state._noTabCycles++;
            } else {
                state._noTabCycles = 0;
            }

            updateTabNames(tabsAfter);

            // Click next tab in rotation
            let targetIdx = -1;
            if (tabsAfter.length > 0) {
                targetIdx = index % tabsAfter.length;
                const targetTab = tabsAfter[targetIdx];
                const clickedTabName = stripTimeSuffix(targetTab.textContent);
                log(`[Loop ${cycle}] Rotating to tab "${clickedTabName}"`);
                targetTab.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
                index++;
            }

            await new Promise(r => setTimeout(r, 1500));

            // Check for completion badges after tab switch
            const badgesAfter = queryAll(SELECTORS.badgeTag).filter(s => {
                const t = s.textContent.trim();
                return SELECTORS.badgeTexts.includes(t);
            });

            if (badgesAfter.length > 0 && targetIdx >= 0) {
                const deduplicatedNames = state.tabNames || [];
                const deduplicatedName = deduplicatedNames[targetIdx];
                if (deduplicatedName) {
                    const hasErrors = hasCompilationErrors();
                    const finalStatus = hasErrors ? 'done-errors' : 'done';
                    updateConversationCompletionState(deduplicatedName, finalStatus);
                }
            }

            await new Promise(r => setTimeout(r, 3000));
        }
        log('[Loop] antigravityLoop STOPPED');
    }

    // ─── State Initialization ────────────────────────────────────
    if (!window.__autoAcceptState) {
        window.__autoAcceptState = {
            isRunning: false,
            tabNames: [],
            completionStatus: {},
            sessionID: 0,
            currentMode: null,
            isBackgroundMode: false,
            bannedCommands: [],
            _noTabCycles: 0,
            clicks: 0,
            blocked: 0
        };
        log('State initialized (fresh)');
    } else {
        log('State already exists (re-injection)');
    }

    // ─── Public API ──────────────────────────────────────────────
    window.__autoAcceptUpdateBannedCommands = function (bannedList) {
        window.__autoAcceptState.bannedCommands = Array.isArray(bannedList) ? bannedList : [];
        log(`[Config] Banned commands: ${window.__autoAcceptState.bannedCommands.length} patterns`);
    };

    window.__autoAcceptGetStats = function () {
        const s = window.__autoAcceptState;
        return { clicks: s.clicks || 0, blocked: s.blocked || 0 };
    };

    window.__autoAcceptResetStats = function () {
        window.__autoAcceptState.clicks = 0;
        window.__autoAcceptState.blocked = 0;
        log('[Stats] Reset');
    };

    window.__autoAcceptSetFocusState = function (focused) {
        window.__autoAcceptState._windowFocused = focused;
        if (!focused) {
            window.__autoAcceptState._awayStart = Date.now();
        }
        log(`[Focus] Window ${focused ? 'focused' : 'unfocused'}`);
    };

    window.__autoAcceptStart = function (config) {
        try {
            const ide = (config.ide || 'cursor').toLowerCase();
            const isBG = config.isBackgroundMode === true;

            if (config.bannedCommands) {
                window.__autoAcceptUpdateBannedCommands(config.bannedCommands);
            }

            const state = window.__autoAcceptState;

            log(`__autoAcceptStart: ide=${ide}, bg=${isBG}`);

            // Same config → skip
            if (state.isRunning && state.currentMode === ide && state.isBackgroundMode === isBG) {
                log('Already running with same config, skipping');
                return;
            }

            // ── Dedup guard: only ONE BG loop per page ──
            if (isBG && window.__agBGLoopOwner && window.__agBGLoopOwner !== WINDOW_ID) {
                log(`BG loop already claimed by ${window.__agBGLoopOwner}, refusing`);
                return;
            }

            // Dismount overlay when switching away from background mode
            if (state.isBackgroundMode && !isBG) {
                dismountOverlay();
                if (window.__agBGLoopOwner === WINDOW_ID) {
                    window.__agBGLoopOwner = null;
                }
            }

            // Stop previous session
            if (state.isRunning) {
                state.isRunning = false;
            }

            state.isRunning = true;
            state.currentMode = ide;
            state.isBackgroundMode = isBG;
            state.sessionID++;
            const sid = state.sessionID;

            if (isBG) {
                window.__agBGLoopOwner = WINDOW_ID;
                log(`Starting BACKGROUND mode (${ide}, sid=${sid}, owner=${WINDOW_ID})`);
                mountOverlay();

                if (ide === 'cursor') cursorLoop(sid);
                else antigravityLoop(sid);
            } else {
                log(`Starting SIMPLE mode (${ide}, sid=${sid})`);
                (async function staticLoop() {
                    const allButtons = [...SELECTORS.cursorButtons, ...SELECTORS.antigravityButtons];
                    while (state.isRunning && state.sessionID === sid) {
                        await performClick(allButtons);
                        await new Promise(r => setTimeout(r, config.pollInterval || 1000));
                    }
                    log('staticLoop STOPPED');
                })();
            }
        } catch (e) {
            log(`[Error] __autoAcceptStart: ${e.message}`);
            console.error('[AutoAccept] Start error:', e);
        }
    };

    window.__autoAcceptStop = function () {
        log('__autoAcceptStop called');
        window.__autoAcceptState.isRunning = false;
        window.__autoAcceptState._noTabCycles = 0;
        if (window.__agBGLoopOwner === WINDOW_ID) {
            window.__agBGLoopOwner = null;
        }
        dismountOverlay();
        log('Stopped');
    };

    log('Ready');
})();
