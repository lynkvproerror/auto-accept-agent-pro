/**
 * CDP Handler — Chrome DevTools Protocol Connection Manager
 *
 * Manages WebSocket connections to IDE browser instances via CDP.
 * Scans ports 8997–9003, discovers pages, injects auto-accept scripts,
 * retrieves stats, and manages focus state.
 */

const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { compose } = require('./compositor');

const SCAN_PORTS = [9000, 8997, 8998, 8999, 9001, 9002, 9003];
const DEVTOOLS_FILTER = /^devtools:\/\//;

class CdpHandler {
    constructor(logger = console.log) {
        this.logger = logger;
        this.connections = new Map(); // pageId -> { ws, injected, mode }
        this.activePort = null;
        this._scriptCache = null;
        this._lastConfig = null;
        this._reconnectTimers = new Map();
        this._stopping = false;
    }

    log(msg) {
        this.logger(`[CDP] ${msg}`);
    }

    /**
     * Scan for an active debug port
     */
    async scanForDebugPort() {
        for (const port of SCAN_PORTS) {
            try {
                const pages = await this._fetchPages(port);
                if (pages && pages.length > 0) {
                    this.activePort = port;
                    this.log(`Found active debug port: ${port} (${pages.length} pages)`);
                    return true;
                }
            } catch (e) {
                // Port not active, continue scanning
            }
        }
        this.log('No active debug port found');
        return false;
    }

    /**
     * Fetch page list from debug server
     */
    _fetchPages(port) {
        return new Promise((resolve, reject) => {
            const req = http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const pages = JSON.parse(data);
                        // Filter out devtools pages
                        const filtered = pages.filter(p =>
                            p.webSocketDebuggerUrl &&
                            !DEVTOOLS_FILTER.test(p.url || '')
                        );
                        resolve(filtered);
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            req.on('error', reject);
            req.setTimeout(2000, () => {
                req.destroy();
                reject(new Error('Timeout'));
            });
        });
    }

    /**
     * Check if any connection is active
     */
    isConnected() {
        return this.connections.size > 0;
    }

    /**
     * Start CDP session — connect to all pages and inject scripts
     */
    async start(config) {
        this.log(`Starting CDP session (ide=${config.ide}, bg=${config.isBackgroundMode})...`);
        this._lastConfig = config;
        this._stopping = false;

        if (!this.activePort) {
            const found = await this.scanForDebugPort();
            if (!found) {
                throw new Error('No debug port available. Please restart your IDE with --remote-debugging-port=9000');
            }
        }

        const pages = await this._fetchPages(this.activePort);
        this.log(`Discovered ${pages.length} injectable pages`);

        for (const page of pages) {
            const pageId = page.id;
            if (this.connections.has(pageId)) {
                this.log(`Page ${pageId} already connected, re-injecting...`);
                await this._inject(pageId, config);
                continue;
            }

            try {
                await this._connectPage(page, config);
            } catch (e) {
                this.log(`Failed to connect to page ${pageId}: ${e.message}`);
            }
        }
    }

    /**
     * Connect to a single page via WebSocket
     */
    async _connectPage(page, config) {
        const pageId = page.id;
        const wsUrl = page.webSocketDebuggerUrl;

        return new Promise((resolve, reject) => {
            const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
            let msgId = 1;

            const conn = {
                ws,
                injected: false,
                mode: config.isBackgroundMode ? 'background' : 'simple',
                sendCommand: (method, params = {}) => {
                    return new Promise((res, rej) => {
                        const id = msgId++;
                        const timeout = setTimeout(() => rej(new Error('CDP timeout')), 5000);

                        const handler = (raw) => {
                            try {
                                const msg = JSON.parse(raw.toString());
                                if (msg.id === id) {
                                    ws.removeListener('message', handler);
                                    clearTimeout(timeout);
                                    if (msg.error) rej(new Error(msg.error.message));
                                    else res(msg.result);
                                }
                            } catch (e) { }
                        };

                        ws.on('message', handler);
                        ws.send(JSON.stringify({ id, method, params }));
                    });
                }
            };

            ws.on('open', async () => {
                this.log(`Connected to page ${pageId}`);
                this.connections.set(pageId, conn);

                try {
                    await this._inject(pageId, config);
                    resolve();
                } catch (e) {
                    this.log(`Injection failed for ${pageId}: ${e.message}`);
                    resolve(); // Don't fail the whole start
                }
            });

            ws.on('close', () => {
                this.log(`Disconnected from page ${pageId}`);
                this.connections.delete(pageId);
                // Auto-reconnect if not stopping
                if (!this._stopping && this._lastConfig) {
                    this._scheduleReconnect(page, pageId);
                }
            });

            ws.on('error', (err) => {
                this.log(`WebSocket error for ${pageId}: ${err.message}`);
                this.connections.delete(pageId);
                reject(err);
            });

            setTimeout(() => {
                if (!this.connections.has(pageId)) {
                    ws.terminate();
                    reject(new Error('Connection timeout'));
                }
            }, 5000);
        });
    }

    /**
     * Inject auto-accept script into a page
     * Handles mode switching: stops old script + removes overlay before re-injection
     */
    async _inject(pageId, config) {
        const conn = this.connections.get(pageId);
        if (!conn) return;

        const newMode = config.isBackgroundMode ? 'background' : 'simple';

        try {
            // If already injected with a DIFFERENT mode, stop old script + clean overlay
            if (conn.injected && conn.mode !== newMode) {
                this.log(`Mode change detected on ${pageId}: ${conn.mode} → ${newMode}. Stopping old script...`);

                // Stop old script
                await conn.sendCommand('Runtime.evaluate', {
                    expression: 'if (typeof __autoAcceptStop === "function") __autoAcceptStop();',
                    silent: true, returnByValue: false
                }).catch(() => { });

                // Remove overlay if switching away from background
                if (conn.mode === 'background') {
                    await conn.sendCommand('Runtime.evaluate', {
                        expression: `(function() {
                            var el = document.getElementById('__autoAcceptBgOverlay');
                            if (el) { if (el._resizeObserver) el._resizeObserver.disconnect(); el.remove(); }
                        })()`,
                        silent: true, returnByValue: false
                    }).catch(() => { });
                }

                conn.injected = false; // Force re-injection
                await new Promise(r => setTimeout(r, 100)); // Let cleanup settle
            }

            // Skip if already injected with the same mode
            if (conn.injected && conn.mode === newMode) {
                return;
            }

            // Get the script to inject
            const script = compose({
                isBackgroundMode: config.isBackgroundMode,
                ide: config.ide,
                pollInterval: config.pollInterval || 1000,
                bannedCommands: config.bannedCommands || []
            });

            // Inject via Runtime.evaluate
            await conn.sendCommand('Runtime.evaluate', {
                expression: script,
                allowUnsafeEvalBlockedByCSP: true,
                silent: true,
                returnByValue: false
            });

            // Start the agent
            const startConfig = JSON.stringify({
                ide: config.ide,
                isBackgroundMode: config.isBackgroundMode,
                pollInterval: config.pollInterval || 1000,
                bannedCommands: config.bannedCommands || []
            });

            await conn.sendCommand('Runtime.evaluate', {
                expression: `if (typeof __autoAcceptStart === 'function') __autoAcceptStart(${startConfig});`,
                silent: true,
                returnByValue: false
            });

            conn.injected = true;
            conn.mode = newMode;
            this.log(`Injected ${conn.mode} mode into page ${pageId}`);
        } catch (e) {
            this.log(`Injection error for ${pageId}: ${e.message}`);
        }
    }

    /**
     * Stop all CDP connections — kills injected scripts + overlay before closing
     */
    async stop() {
        this.log('Stopping all CDP connections...');
        this._stopping = true;

        // Clear all reconnect timers
        for (const [pageId, timer] of this._reconnectTimers) {
            clearTimeout(timer.timeout);
        }
        this._reconnectTimers.clear();

        for (const [pageId, conn] of this.connections) {
            try {
                // Stop injected script + kill SimplePoll timer + remove overlay
                await conn.sendCommand('Runtime.evaluate', {
                    expression: `(function() {
                        if (typeof __autoAcceptStop === "function") __autoAcceptStop();
                        if (window.__simplePollTimer) { clearInterval(window.__simplePollTimer); window.__simplePollTimer = null; }
                        var el = document.getElementById('__autoAcceptBgOverlay');
                        if (el) { if (el._resizeObserver) el._resizeObserver.disconnect(); el.remove(); }
                    })()`,
                    silent: true,
                    returnByValue: false
                });
            } catch (e) {
                this.log(`Stop script failed for ${pageId}: ${e.message}`);
            }

            try {
                conn.ws.close();
            } catch (e) { }
        }

        this.connections.clear();
        this.log('All connections closed');
    }

    /**
     * Auto-reconnect with exponential backoff (max 3 retries)
     */
    _scheduleReconnect(page, pageId) {
        const existing = this._reconnectTimers.get(pageId) || { attempt: 0 };
        existing.attempt++;

        if (existing.attempt > 3) {
            this.log(`[Reconnect] Giving up on page ${pageId} after 3 attempts`);
            this._reconnectTimers.delete(pageId);
            return;
        }

        const delay = Math.pow(2, existing.attempt) * 1000; // 2s, 4s, 8s
        this.log(`[Reconnect] Page ${pageId} — retry #${existing.attempt} in ${delay}ms`);

        existing.timeout = setTimeout(async () => {
            if (this._stopping) return;

            try {
                await this._connectPage(page, this._lastConfig);
                this.log(`[Reconnect] Page ${pageId} reconnected successfully`);
                this._reconnectTimers.delete(pageId);
            } catch (e) {
                this.log(`[Reconnect] Page ${pageId} failed: ${e.message}`);
                this._scheduleReconnect(page, pageId);
            }
        }, delay);

        this._reconnectTimers.set(pageId, existing);
    }

    /**
     * Get stats from injected scripts (cumulative, for backward compat)
     */
    async getStats() {
        for (const [pageId, conn] of this.connections) {
            if (!conn.injected) continue;

            try {
                const result = await conn.sendCommand('Runtime.evaluate', {
                    expression: 'typeof __autoAcceptGetStats === "function" ? JSON.stringify(__autoAcceptGetStats()) : "{}"',
                    returnByValue: true
                });

                if (result && result.result && result.result.value) {
                    return JSON.parse(result.result.value);
                }
            } catch (e) {
                // Stats retrieval failed for this page
            }
        }
        return null;
    }

    /**
     * Get stats AND reset browser-side counters (delta-based, no double-counting)
     */
    async getAndResetStats() {
        for (const [pageId, conn] of this.connections) {
            if (!conn.injected) continue;

            try {
                const result = await conn.sendCommand('Runtime.evaluate', {
                    expression: `(function() {
                        if (typeof __autoAcceptGetStats !== 'function') return '{}';
                        var s = __autoAcceptGetStats();
                        var snap = JSON.stringify(s);
                        if (typeof __autoAcceptResetStats === 'function') __autoAcceptResetStats();
                        return snap;
                    })()`,
                    returnByValue: true
                });

                if (result && result.result && result.result.value) {
                    return JSON.parse(result.result.value);
                }
            } catch (e) {
                // Stats retrieval failed for this page
            }
        }
        return null;
    }

    /**
     * Update banned commands on all injected pages
     */
    async updateBannedCommands(bannedList) {
        const encoded = JSON.stringify(bannedList);

        for (const [pageId, conn] of this.connections) {
            if (!conn.injected) continue;

            try {
                await conn.sendCommand('Runtime.evaluate', {
                    expression: `if (typeof __autoAcceptUpdateBannedCommands === 'function') __autoAcceptUpdateBannedCommands(${encoded});`,
                    silent: true,
                    returnByValue: false
                });
            } catch (e) {
                this.log(`Failed to update banned commands on ${pageId}: ${e.message}`);
            }
        }
    }

    /**
     * Set focus state on all injected pages
     */
    async setFocusState(focused) {
        for (const [pageId, conn] of this.connections) {
            if (!conn.injected) continue;

            try {
                await conn.sendCommand('Runtime.evaluate', {
                    expression: `if (typeof __autoAcceptSetFocusState === 'function') __autoAcceptSetFocusState(${focused});`,
                    silent: true,
                    returnByValue: false
                });
            } catch (e) { }
        }
    }
    /**
     * Hide/remove background overlay from all connected pages
     */
    async hideBackgroundOverlay() {
        for (const [pageId, conn] of this.connections) {
            if (!conn.injected) continue;
            try {
                await conn.sendCommand('Runtime.evaluate', {
                    expression: `(function() {
                        var el = document.getElementById('__autoAcceptBgOverlay');
                        if (el) {
                            if (el._resizeObserver) el._resizeObserver.disconnect();
                            el.classList.remove('visible');
                            setTimeout(function() { el.remove(); }, 300);
                        }
                    })()`,
                    silent: true,
                    returnByValue: false
                });
            } catch (e) { }
        }
    }
}

module.exports = { CdpHandler };
