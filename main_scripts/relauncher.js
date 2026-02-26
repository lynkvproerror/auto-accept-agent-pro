/**
 * relauncher.js — CDP Setup & Relaunch Manager (Pro)
 *
 * Manages IDE shortcut modification for enabling Chrome DevTools Protocol.
 * Pro extension: showSetupPanel() creates a WebView with setup instructions.
 *
 * Supports: Windows, macOS, Linux
 * IDEs: Cursor, Antigravity, VS Code, Windsurf, Trae
 */

const vscode = require('vscode');
const { execSync, spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const CDP_PORT = 9222;
const CDP_FLAG = `--remote-debugging-port=${CDP_PORT}`;

class Relauncher {
    constructor(logger = console.log) {
        this.platform = os.platform();
        this.logger = logger;
    }

    log(msg) {
        this.logger(`[Relauncher] ${msg}`);
    }

    /**
     * Get human-readable IDE name.
     */
    getIdeName() {
        const appName = vscode.env.appName || '';
        if (appName.toLowerCase().includes('cursor')) return 'Cursor';
        if (appName.toLowerCase().includes('antigravity')) return 'Antigravity';
        if (appName.toLowerCase().includes('windsurf')) return 'Windsurf';
        if (appName.toLowerCase().includes('trae')) return 'Trae';
        return 'Code';
    }

    /**
     * Show a WebView panel with CDP setup instructions.
     * This is the primary Pro entry point — called from extension.js and setup-panel.js.
     */
    showSetupPanel() {
        const ideName = this.getIdeName();
        const { script, instructions } = this.getPlatformScriptAndInstructions();

        if (!script) {
            vscode.window.showErrorMessage(
                `Auto Accept Pro: Unsupported platform. Please add --remote-debugging-port=9000 to your ${ideName} shortcut manually, then restart.`,
                'View Help'
            ).then(selection => {
                if (selection === 'View Help') {
                    vscode.env.openExternal(vscode.Uri.parse('https://github.com/lynkvproerror/auto-accept-agent-pro#background-mode-setup'));
                }
            });
            return;
        }

        // Create WebView panel
        const panel = vscode.window.createWebviewPanel(
            'autoAcceptSetup',
            `${ideName} CDP Setup`,
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        panel.webview.html = this._getSetupHtml(ideName, script, instructions);

        panel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'copyScript') {
                await vscode.env.clipboard.writeText(script);
                vscode.window.showInformationMessage('Setup script copied to clipboard!');
            } else if (message.command === 'openHelp') {
                vscode.env.openExternal(vscode.Uri.parse('https://github.com/lynkvproerror/auto-accept-agent-pro#background-mode-setup'));
            } else if (message.command === 'reloadWindow') {
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        });
    }

    /**
     * Check if current process was launched with CDP flag.
     */
    checkShortcutFlag() {
        const args = process.argv.join(' ');
        return args.includes('--remote-debugging-port=');
    }

    /**
     * Get platform-specific setup script and instructions.
     */
    getPlatformScriptAndInstructions() {
        const ideName = this.getIdeName();

        if (this.platform === 'win32') {
            return this._getWindowsScript(ideName);
        } else if (this.platform === 'darwin') {
            return this._getMacScript(ideName);
        } else if (this.platform === 'linux') {
            return this._getLinuxScript(ideName);
        }

        return { script: '', instructions: 'Unsupported platform.' };
    }

    // ─── Platform Scripts ────────────────────────────────────────────

    _getWindowsScript(ideName) {
        const script = `# ${ideName} CDP Setup Script (Windows)
Write-Host "=== ${ideName} CDP Setup ===" -ForegroundColor Cyan
Write-Host "Searching for ${ideName} shortcuts..." -ForegroundColor Yellow

$searchLocations = @(
    [Environment]::GetFolderPath('Desktop'),
    "$env:USERPROFILE\\Desktop",
    "$env:USERPROFILE\\OneDrive\\Desktop",
    "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs",
    "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",
    "$env:USERPROFILE\\AppData\\Roaming\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar"
)

$WshShell = New-Object -ComObject WScript.Shell
$foundShortcuts = @()

foreach ($location in $searchLocations) {
    if (Test-Path $location) {
        Write-Host "Searching: $location"
        $shortcuts = Get-ChildItem -Path $location -Recurse -Filter "*.lnk" -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like "*${ideName}*" }
        $foundShortcuts += $shortcuts
    }
}

if ($foundShortcuts.Count -eq 0) {
    Write-Host "No shortcuts found. Searching for ${ideName} installation..." -ForegroundColor Yellow
    $exePath = "$env:LOCALAPPDATA\\Programs\\${ideName}\\${ideName}.exe"

    if (Test-Path $exePath) {
        $desktopPath = [Environment]::GetFolderPath('Desktop')
        $shortcutPath = "$desktopPath\\${ideName}.lnk"
        $shortcut = $WshShell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $exePath
        $shortcut.Arguments = "--remote-debugging-port=9222"
        $shortcut.Save()
        Write-Host "Created new shortcut: $shortcutPath" -ForegroundColor Green
    } else {
        Write-Host "ERROR: ${ideName}.exe not found." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "Found $($foundShortcuts.Count) shortcut(s)" -ForegroundColor Green
    foreach ($shortcutFile in $foundShortcuts) {
        $shortcut = $WshShell.CreateShortcut($shortcutFile.FullName)
        $originalArgs = $shortcut.Arguments

        if ($originalArgs -match "--remote-debugging-port=\\d+") {
            $shortcut.Arguments = $originalArgs -replace "--remote-debugging-port=\\d+", "--remote-debugging-port=9222"
        } else {
            $shortcut.Arguments = "--remote-debugging-port=9222 " + $originalArgs
        }
        $shortcut.Save()
        Write-Host "Updated: $($shortcutFile.Name)" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "=== Setup Complete ===" -ForegroundColor Cyan
Write-Host "Please restart ${ideName} completely." -ForegroundColor Yellow`;

        return {
            script,
            instructions: `1. Open PowerShell as Administrator\n2. Paste the script and press Enter\n3. After completion, close and restart ${ideName} completely.`
        };
    }

    _getMacScript(ideName) {
        const script = `#!/bin/bash
# ${ideName} CDP Setup Script (macOS)
echo "=== ${ideName} CDP Setup ==="

APP_LOCATIONS=("/Applications" "$HOME/Applications")
app_path=""

for location in "\${APP_LOCATIONS[@]}"; do
    if [ -d "$location" ]; then
        found=$(find "$location" -maxdepth 2 -name "*${ideName}*.app" -type d 2>/dev/null | head -n1)
        if [ -n "$found" ]; then
            app_path="$found"
            echo "Found: $app_path"
            break
        fi
    fi
done

if [ -z "$app_path" ]; then
    echo "ERROR: ${ideName}.app not found."
    exit 1
fi

echo ""
echo "To launch with CDP temporarily:"
echo "  open -n -a \\"${ideName}\\" --args --remote-debugging-port=9000"
echo ""
echo "=== Setup Complete ==="`;

        return {
            script,
            instructions: `1. Open Terminal\n2. Paste the script and press Enter\n3. Quit and restart ${ideName} completely.`
        };
    }

    _getLinuxScript(ideName) {
        const script = `#!/bin/bash
# ${ideName} CDP Setup Script (Linux)
echo "=== ${ideName} CDP Setup ==="

IDE_NAME_LOWER=$(echo "${ideName}" | tr '[:upper:]' '[:lower:]')

SEARCH_LOCATIONS=(
    "$HOME/.local/share/applications"
    "$HOME/Desktop"
    "/usr/share/applications"
    "/usr/local/share/applications"
)

found_count=0
for dir in "\${SEARCH_LOCATIONS[@]}"; do
    if [ -d "$dir" ]; then
        for file in "$dir"/*.desktop; do
            if [ -f "$file" ] && grep -qi "$IDE_NAME_LOWER" "$file" 2>/dev/null; then
                echo "Found: $(basename "$file")"
                if ! grep -q "remote-debugging-port" "$file"; then
                    cp "$file" "\${file}.bak"
                    sed -i 's|^Exec=\\(.*\\)$|Exec=\\1 --remote-debugging-port=9000|' "$file"
                    echo "  CDP port added"
                else
                    echo "  Already configured"
                fi
                found_count=$((found_count + 1))
            fi
        done
    fi
done

echo ""
echo "=== Setup Complete ==="
echo "Total shortcuts found: $found_count"
echo "Please restart ${ideName} completely."`;

        return {
            script,
            instructions: `1. Open Terminal\n2. Paste the script and press Enter\n3. Close and restart ${ideName} completely.`
        };
    }

    // ─── Setup WebView HTML ──────────────────────────────────────────

    _getSetupHtml(ideName, script, instructions) {
        const platform = this.platform === 'win32' ? 'Windows' :
            this.platform === 'darwin' ? 'macOS' : 'Linux';

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${ideName} CDP Setup</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: system-ui, -apple-system, sans-serif;
            background: #1a1a2e;
            color: #e0e0e0;
            padding: 24px;
            line-height: 1.6;
        }
        h1 { color: #fff; margin-bottom: 8px; }
        .subtitle { color: #888; margin-bottom: 24px; }
        .card {
            background: rgba(255,255,255,0.04);
            border: 1px solid rgba(255,255,255,0.08);
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 16px;
        }
        .card h2 { color: #ccc; margin-bottom: 12px; font-size: 1.1em; }
        .steps { list-style: none; counter-reset: step; }
        .steps li {
            counter-increment: step;
            padding: 8px 0 8px 36px;
            position: relative;
        }
        .steps li::before {
            content: counter(step);
            position: absolute;
            left: 0;
            width: 24px;
            height: 24px;
            background: #a855f7;
            border-radius: 50%;
            text-align: center;
            line-height: 24px;
            font-size: 0.8em;
            font-weight: 700;
        }
        pre {
            background: rgba(0,0,0,0.4);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 8px;
            padding: 16px;
            overflow-x: auto;
            font-family: 'Cascadia Code', 'Fira Code', monospace;
            font-size: 12px;
            color: #a0ffa0;
            max-height: 300px;
            overflow-y: auto;
            margin: 12px 0;
        }
        .btn-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
        button {
            padding: 10px 20px;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 600;
            font-size: 14px;
        }
        .btn-primary { background: #a855f7; color: #fff; }
        .btn-primary:hover { background: #9333ea; }
        .btn-secondary { background: rgba(255,255,255,0.08); color: #ccc; }
        .btn-secondary:hover { background: rgba(255,255,255,0.15); }
        .info { color: #38bdf8; font-size: 0.85em; margin-top: 16px; }
    </style>
</head>
<body>
    <h1>⚡ ${ideName} CDP Setup</h1>
    <p class="subtitle">Enable Chrome DevTools Protocol for Background Mode (${platform})</p>

    <div class="card">
        <h2>📋 Instructions</h2>
        <ol class="steps">
            ${instructions.split('\n').map(line => `<li>${line.replace(/^\d+\.\s*/, '')}</li>`).join('\n            ')}
        </ol>
    </div>

    <div class="card">
        <h2>📝 Setup Script</h2>
        <pre>${script.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
        <div class="btn-row">
            <button class="btn-primary" onclick="copyScript()">📋 Copy Script</button>
            <button class="btn-secondary" onclick="openHelp()">📖 View Help</button>
            <button class="btn-secondary" onclick="reloadWindow()">🔄 Reload Window</button>
        </div>
    </div>

    <p class="info">
        💡 After running the script, you must completely close and restart ${ideName} for CDP to activate.
    </p>

    <script>
        const vscode = acquireVsCodeApi();
        function copyScript() { vscode.postMessage({ command: 'copyScript' }); }
        function openHelp() { vscode.postMessage({ command: 'openHelp' }); }
        function reloadWindow() { vscode.postMessage({ command: 'reloadWindow' }); }
    </script>
</body>
</html>`;
    }
}

module.exports = { Relauncher };