/**
 * cdp-handler.js — Chrome DevTools Protocol Handler (Pro)
 *
 * Manages WebSocket connections to browser pages via CDP.
 * Injects and controls accept/scroll/background scripts.
 *
 * Pro extensions vs base:
 *   - scanForDebugPort() with port range scanning
 *   - isConnected() connection status check
 *   - getAndResetStats() delta-based stats (no double-counting)
 *   - updateBannedCommands() push to injected scripts
 *   - Extended config: clickPatterns, scroll, safeClick, diffProtection, initialStats
 */

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { compose } = require('./compositor');

const BASE_PORT = 9222;
const PORT_RANGE = 3; // scan 9222 ± 3
// Wider port list for permission script scanning (covers more IDE configs)
const WIDE_PORTS = [9222, 9229, ...Array.from({ length: 15 }, (_, i) => 9000 + i)];

class CdpHandler {
    constructor(logger = console.log) {
        this.logger = logger;
        this.connections = new Map(); // "port:pageId" → { ws, injected, mode }
        this.isEnabled = false;
        this.msgId = 1;
        this._activePort = null;
        this._lastConfig = null;
    }

    log(msg) {
        this.logger(`[CDP] ${msg}`);
    }

    // ─── Port Scanning ───────────────────────────────────────────────

    /**
     * Scan for active CDP debug ports in the range.
     * Returns true if any port responds with debuggable pages.
     */
    async scanForDebugPort() {
        for (let port = BASE_PORT - PORT_RANGE; port <= BASE_PORT + PORT_RANGE; port++) {
            try {
                const pages = await this._getPages(port);
                if (pages.length > 0) {
                    this._activePort = port;
                    this.log(`Found active CDP on port ${port} (${pages.length} page(s))`);
                    return true;
                }
            } catch (e) { /* port not available */ }
        }
        return false;
    }

    // ─── Connection Status ───────────────────────────────────────────

    /**
     * Returns true if at least one WebSocket connection is active.
     */
    isConnected() {
        for (const [, conn] of this.connections) {
            if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
                return true;
            }
        }
        return false;
    }

    // ─── Start / Stop ────────────────────────────────────────────────

    /**
     * Start CDP: connect to all available pages and inject scripts.
     * Config fields:
     *   - ide, isBackgroundMode, pollInterval, bannedCommands
     *   - smartRules, smartAcceptEnabled, clickPatterns
     *   - scrollEnabled, scrollPauseMs, scrollIntervalMs
     *   - safeClickEnabled, diffProtectionEnabled, initialStats
     */
    async start(config) {
        this.isEnabled = true;
        this._lastConfig = config;
        this.log(`Scanning ports ${BASE_PORT - PORT_RANGE}..${BASE_PORT + PORT_RANGE}`);

        const mode = (config.isBackgroundMode && config.isPro !== false) ? 'background' : 'simple';
        this.log(`Mode: ${mode} (bg=${config.isBackgroundMode})`);

        for (let port = BASE_PORT - PORT_RANGE; port <= BASE_PORT + PORT_RANGE; port++) {
            try {
                const pages = await this._getPages(port);
                if (pages.length > 0) {
                    this.log(`Port ${port}: ${pages.length} page(s)`);
                    pages.forEach((p, i) => this.log(`  [${i}] type=${p.type} title="${(p.title || '').substring(0, 50)}"`));
                }
                for (const page of pages) {
                    const id = `${port}:${page.id}`;
                    if (!this.connections.has(id)) {
                        await this._connect(id, page.webSocketDebuggerUrl);
                    }
                    await this._inject(id, config, mode);
                }
            } catch (e) { /* skip port */ }
        }
    }

    /**
     * Stop all connections and injected scripts.
     */
    async stop() {
        this.isEnabled = false;
        for (const [id, conn] of this.connections) {
            try {
                if (conn.mode === 'background') {
                    await this._evaluate(id, 'if(window.stopBackgroundLoop) window.stopBackgroundLoop()');
                } else {
                    await this._evaluate(id, 'if(window.stopSimplePoll) window.stopSimplePoll()');
                }
                conn.ws.close();
            } catch (e) { /* ignore close errors */ }
        }
        this.connections.clear();
    }

    // ─── Stats (Delta-Based) ─────────────────────────────────────────

    /**
     * Get stats from injected scripts AND reset their counters.
     * Returns delta since last call — prevents double-counting.
     */
    async getAndResetStats() {
        const stats = { clicks: 0, blocked: 0, fileEdits: 0, terminalCommands: 0 };
        for (const [id] of this.connections) {
            try {
                const res = await this._evaluate(id, `
                    (function() {
                        var s = window.__autoAcceptGetStats ? window.__autoAcceptGetStats() : {};
                        if (window.__autoAcceptResetStats) window.__autoAcceptResetStats();
                        return JSON.stringify(s);
                    })()
                `);
                if (res?.result?.value) {
                    const s = JSON.parse(res.result.value);
                    stats.clicks += s.clicks || 0;
                    stats.blocked += s.blocked || 0;
                    stats.fileEdits += s.fileEdits || 0;
                    stats.terminalCommands += s.terminalCommands || 0;
                }
            } catch (e) { /* stats retrieval failed */ }
        }
        return stats;
    }

    /**
     * Get current stats without resetting (for compatibility).
     */
    async getStats() {
        const stats = { clicks: 0, blocked: 0, fileEdits: 0, terminalCommands: 0 };
        for (const [id] of this.connections) {
            try {
                const res = await this._evaluate(id,
                    'JSON.stringify(window.__autoAcceptGetStats ? window.__autoAcceptGetStats() : {})'
                );
                if (res?.result?.value) {
                    const s = JSON.parse(res.result.value);
                    stats.clicks += s.clicks || 0;
                    stats.blocked += s.blocked || 0;
                    stats.fileEdits += s.fileEdits || 0;
                    stats.terminalCommands += s.terminalCommands || 0;
                }
            } catch (e) { /* ignore */ }
        }
        return stats;
    }

    // ─── Live Config Updates ─────────────────────────────────────────

    /**
     * Push updated banned commands to all injected scripts.
     */
    async updateBannedCommands(commands) {
        const json = JSON.stringify(commands);
        for (const [id] of this.connections) {
            try {
                await this._evaluate(id,
                    `if(window.__autoAcceptUpdateBannedCommands) window.__autoAcceptUpdateBannedCommands(${json})`
                );
            } catch (e) { /* ignore */ }
        }
    }

    /**
     * Push focus state to injected scripts (for Away Mode).
     */
    async setFocusState(isFocused) {
        for (const [id] of this.connections) {
            try {
                await this._evaluate(id,
                    `if(window.__autoAcceptSetFocusState) window.__autoAcceptSetFocusState(${isFocused})`
                );
            } catch (e) { /* ignore */ }
        }
    }

    /**
     * Hide the background mode overlay on all pages.
     */
    async hideBackgroundOverlay() {
        for (const [id] of this.connections) {
            try {
                await this._evaluate(id, `
                    (function() {
                        var el = document.getElementById('__autoAcceptBgOverlay');
                        if (el) {
                            if (el._resizeObserver) el._resizeObserver.disconnect();
                            el.classList.remove('visible');
                            setTimeout(function() { el.remove(); }, 300);
                        }
                    })()
                `);
            } catch (e) { /* ignore */ }
        }
    }

    // ─── Away Mode ───────────────────────────────────────────────────

    async getAwayActions() { return 0; }

    async resetStats() {
        for (const [id] of this.connections) {
            try {
                await this._evaluate(id,
                    'if(window.__autoAcceptResetStats) window.__autoAcceptResetStats()'
                );
            } catch (e) { /* ignore */ }
        }
        return { clicks: 0, blocked: 0 };
    }

    getConnectionCount() { return this.connections.size; }

    // ─── Internal: HTTP Page Discovery ───────────────────────────────

    async _getPages(port) {
        return new Promise((resolve) => {
            const req = http.get({
                hostname: '127.0.0.1',
                port,
                path: '/json/list',
                timeout: 500
            }, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try {
                        const pages = JSON.parse(body);
                        const filtered = pages.filter(p => {
                            if (!p.webSocketDebuggerUrl) return false;
                            if (p.type !== 'page' && p.type !== 'webview') return false;
                            const url = (p.url || '').toLowerCase();
                            if (url.startsWith('devtools://') ||
                                url.startsWith('chrome-devtools://') ||
                                url.includes('devtools/devtools')) return false;
                            return true;
                        });
                        resolve(filtered);
                    } catch (e) { resolve([]); }
                });
            });
            req.on('error', () => resolve([]));
            req.on('timeout', () => { req.destroy(); resolve([]); });
        });
    }

    // ─── Internal: WebSocket Connection ──────────────────────────────

    async _connect(id, url) {
        return new Promise((resolve) => {
            const ws = new WebSocket(url);
            ws.on('open', () => {
                this.connections.set(id, { ws, injected: false, mode: null });
                this.log(`Connected to page ${id}`);
                resolve(true);
            });
            ws.on('error', () => resolve(false));
            ws.on('close', () => {
                this.connections.delete(id);
                this.log(`Disconnected from page ${id}`);
            });
        });
    }

    // ─── Internal: Script Injection ──────────────────────────────────

    async _inject(id, config, mode) {
        const conn = this.connections.get(id);
        if (!conn) return;

        try {
            // Re-inject if mode changed
            if (conn.injected && conn.mode !== mode) {
                this.log(`Mode changed ${conn.mode} → ${mode}, re-injecting ${id}`);
                if (conn.mode === 'background') {
                    await this._evaluate(id, 'if(window.stopBackgroundLoop) window.stopBackgroundLoop()');
                } else {
                    await this._evaluate(id, 'if(window.stopSimplePoll) window.stopSimplePoll()');
                }
                conn.injected = false;
            }

            if (!conn.injected) {
                const script = compose(config);
                this.log(`Injecting ${mode} script into ${id} (${(script.length / 1024).toFixed(1)}KB)`);
                await this._evaluate(id, script);
                conn.injected = true;
                conn.mode = mode;
                this.log(`Script injected into ${id}`);

                // Background mode: call startBackgroundLoop after injection
                if (mode === 'background') {
                    this.log(`Calling startBackgroundLoop on ${id} (ide=${config.ide})`);
                    await this._evaluate(id,
                        `if(window.startBackgroundLoop) window.startBackgroundLoop('${config.ide}')`
                    );
                }
                // Simple poll starts automatically on injection
            }
        } catch (e) {
            this.log(`Injection failed for ${id}: ${e.message}`);
        }
    }

    // ─── Internal: CDP Evaluate ──────────────────────────────────────

    async _evaluate(id, expression) {
        const conn = this.connections.get(id);
        if (!conn || conn.ws.readyState !== WebSocket.OPEN) return;

        return new Promise((resolve, reject) => {
            const currentId = this.msgId++;
            const timeout = setTimeout(() => reject(new Error('CDP Timeout')), 2000);

            const onMessage = (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.id === currentId) {
                        conn.ws.off('message', onMessage);
                        clearTimeout(timeout);
                        resolve(msg.result);
                    }
                } catch (e) { /* parse error, ignore */ }
            };

            conn.ws.on('message', onMessage);
            conn.ws.send(JSON.stringify({
                id: currentId,
                method: 'Runtime.evaluate',
                params: { expression, userGesture: true, awaitPromise: true }
            }));
        });
    }

    // ─── Permission Script: Evaluate on ALL Pages (Fresh WS) ────────

    /**
     * Evaluate a script on ALL CDP pages using fresh WebSocket connections.
     * Opens a new WS per page, evaluates, and immediately closes.
     * This is MarcoDeliaBot-style: ensures script runs in every context
     * including vscode-webview:// iframes (OOPIF agent panel).
     * Returns the first non-empty result string, or null.
     */
    async evaluateOnAllPages(script) {
        const allPages = await this._getAllPages();
        for (const page of allPages) {
            try {
                const result = await this._evalFresh(page.webSocketDebuggerUrl, script);
                if (result && typeof result === 'string' && result.startsWith('clicked:')) {
                    return result;
                }
            } catch (e) { /* next page */ }
        }
        return null;
    }

    /**
     * Get pages from ALL ports in WIDE_PORTS list.
     * Returns pages with webSocketDebuggerUrl.
     */
    async _getAllPages() {
        const allPages = [];
        for (const port of WIDE_PORTS) {
            try {
                const pages = await this._getPages(port);
                allPages.push(...pages);
                if (pages.length > 0) break; // found active port, use it
            } catch (e) { /* skip port */ }
        }
        return allPages;
    }

    /**
     * Evaluate script via a fresh WebSocket (open, send, receive, close).
     */
    _evalFresh(wsUrl, expression) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(wsUrl);
            const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 2000);
            ws.on('open', () => {
                ws.send(JSON.stringify({
                    id: 1,
                    method: 'Runtime.evaluate',
                    params: { expression, returnByValue: true }
                }));
            });
            ws.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.id === 1) {
                    clearTimeout(timeout);
                    ws.close();
                    resolve(msg.result?.result?.value || '');
                }
            });
            ws.on('error', () => { clearTimeout(timeout); reject(new Error('ws-error')); });
        });
    }
}

module.exports = { CdpHandler };