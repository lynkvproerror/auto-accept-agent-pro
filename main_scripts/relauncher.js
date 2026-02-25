/**
 * Relauncher — Cross-platform CDP Setup
 *
 * Detects IDE installation, generates platform-specific scripts to
 * enable Chrome DevTools Protocol (--remote-debugging-port=9000),
 * and provides a webview panel guiding the user through setup.
 */

const vscode = require('vscode');
const path = require('path');
const os = require('os');

class Relauncher {
    constructor(logger = console.log) {
        this.logger = logger;
        this.platform = os.platform(); // 'win32', 'darwin', 'linux'
    }

    log(msg) {
        this.logger(`[Relauncher] ${msg}`);
    }

    /**
     * Main entry: Offer CDP setup if not already configured
     */
    async ensureCDPAndRelaunch() {
        this.log('ensureCDPAndRelaunch called');

        const answer = await vscode.window.showInformationMessage(
            'Background Mode requires Chrome DevTools Protocol (CDP). Would you like to set it up?',
            'Setup CDP', 'Not Now'
        );

        if (answer === 'Setup CDP') {
            await this.showSetupPanel();
        }
    }

    /**
     * Show setup panel with platform-specific instructions
     */
    async showSetupPanel() {
        const panel = vscode.window.createWebviewPanel(
            'autoAcceptSetup',
            'Auto Accept Pro: CDP Setup',
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        const script = this.getSetupScript();
        const platformName = this.getPlatformName();

        panel.webview.html = this.getSetupHTML(script, platformName);

        panel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'copyScript') {
                await vscode.env.clipboard.writeText(script);
                vscode.window.showInformationMessage('Setup script copied to clipboard!');
            }
        });
    }

    /**
     * Get platform display name
     */
    getPlatformName() {
        switch (this.platform) {
            case 'win32': return 'Windows';
            case 'darwin': return 'macOS';
            case 'linux': return 'Linux';
            default: return 'Unknown';
        }
    }

    /**
     * Generate platform-specific setup script
     */
    getSetupScript() {
        const ideName = this.getIDEName();

        switch (this.platform) {
            case 'win32':
                return this.getWindowsScript(ideName);
            case 'darwin':
                return this.getMacScript(ideName);
            case 'linux':
                return this.getLinuxScript(ideName);
            default:
                return '# Unsupported platform. Please manually add --remote-debugging-port=9000 to your IDE launch command.';
        }
    }

    /**
     * Detect IDE name from VS Code API
     */
    getIDEName() {
        const appName = (vscode.env.appName || '').toLowerCase();
        if (appName.includes('cursor')) return 'Cursor';
        if (appName.includes('antigravity')) return 'Antigravity';
        return 'Code';
    }

    /**
     * Windows PowerShell script
     */
    getWindowsScript(ideName) {
        return `# Auto Accept Agent Pro — CDP Setup for ${ideName} (Windows)
# Run as Administrator in PowerShell

$ErrorActionPreference = "SilentlyContinue"

$ide = "${ideName}"
$flag = "--remote-debugging-port=9000"
$locations = @(
    [System.Environment]::GetFolderPath("Desktop"),
    [System.Environment]::GetFolderPath("CommonDesktopDirectory"),
    [System.Environment]::GetFolderPath("StartMenu") + "\\Programs",
    [System.Environment]::GetFolderPath("CommonStartMenu") + "\\Programs",
    "$env:APPDATA\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar"
)

$found = 0

foreach ($loc in $locations) {
    if (-not (Test-Path $loc)) { continue }
    $shortcuts = Get-ChildItem -Path $loc -Filter "*.lnk" -Recurse -ErrorAction SilentlyContinue
    foreach ($shortcut in $shortcuts) {
        $shell = New-Object -ComObject WScript.Shell
        $lnk = $shell.CreateShortcut($shortcut.FullName)

        if ($lnk.TargetPath -like "*$ide*") {
            Write-Host "Found: $($shortcut.FullName)" -ForegroundColor Green
            if ($lnk.Arguments -notlike "*remote-debugging-port*") {
                $lnk.Arguments = ($lnk.Arguments + " " + $flag).Trim()
                $lnk.Save()
                Write-Host "  Updated with CDP flag." -ForegroundColor Yellow
                $found++
            } else {
                Write-Host "  Already has CDP flag." -ForegroundColor Cyan
                $found++
            }
        }
    }
}

if ($found -eq 0) {
    $ideExe = Get-ChildItem -Path "$env:LOCALAPPDATA" -Filter "$ide.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($ideExe) {
        $desktop = [System.Environment]::GetFolderPath("Desktop")
        $shell = New-Object -ComObject WScript.Shell
        $lnk = $shell.CreateShortcut("$desktop\\$ide (CDP).lnk")
        $lnk.TargetPath = $ideExe.FullName
        $lnk.Arguments = $flag
        $lnk.Save()
        Write-Host "Created new shortcut: $desktop\\$ide (CDP).lnk" -ForegroundColor Green
    } else {
        Write-Host "Could not find $ide. Please add $flag manually to your IDE shortcut." -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "Done! Please restart $ide using the modified shortcut." -ForegroundColor Green`;
    }

    /**
     * macOS Bash script
     */
    getMacScript(ideName) {
        return `#!/bin/bash
# Auto Accept Agent Pro — CDP Setup for ${ideName} (macOS)

IDE="${ideName}"
FLAG="--remote-debugging-port=9000"
APP_PATH="/Applications/\${IDE}.app"

echo "Setting up CDP for \${IDE}..."

if [ ! -d "\${APP_PATH}" ]; then
    echo "Error: \${APP_PATH} not found"
    echo "Please install \${IDE} first or check the application name"
    exit 1
fi

PLIST="\${APP_PATH}/Contents/Info.plist"

if [ ! -f "\${PLIST}" ]; then
    echo "Error: Info.plist not found at \${PLIST}"
    exit 1
fi

# Backup
cp "\${PLIST}" "\${PLIST}.bak"
echo "Backup created: \${PLIST}.bak"

# Check if CLI args key already exists
if /usr/libexec/PlistBuddy -c "Print :LSEnvironment" "\${PLIST}" 2>/dev/null; then
    echo "LSEnvironment already exists"
else
    /usr/libexec/PlistBuddy -c "Add :LSEnvironment dict" "\${PLIST}" 2>/dev/null
fi

# Add ELECTRON_ADDITIONAL_ARGS
/usr/libexec/PlistBuddy -c "Set :LSEnvironment:ELECTRON_ADDITIONAL_ARGS '\${FLAG}'" "\${PLIST}" 2>/dev/null || \\
/usr/libexec/PlistBuddy -c "Add :LSEnvironment:ELECTRON_ADDITIONAL_ARGS string '\${FLAG}'" "\${PLIST}"

echo ""
echo "Done! Please quit and restart \${IDE}."
echo "To undo: cp '\${PLIST}.bak' '\${PLIST}'"`;
    }

    /**
     * Linux Bash script
     */
    getLinuxScript(ideName) {
        const ideNameLower = ideName.toLowerCase();
        return `#!/bin/bash
# Auto Accept Agent Pro — CDP Setup for ${ideName} (Linux)

IDE="${ideName}"
IDE_LOWER="${ideNameLower}"
FLAG="--remote-debugging-port=9000"

DESKTOP_DIRS=(
    "\${HOME}/.local/share/applications"
    "/usr/share/applications"
    "/usr/local/share/applications"
    "/var/lib/snapd/desktop/applications"
    "/var/lib/flatpak/exports/share/applications"
)

found=0

for dir in "\${DESKTOP_DIRS[@]}"; do
    if [ ! -d "\$dir" ]; then continue; fi

    while IFS= read -r -d '' file; do
        if grep -qi "\${IDE_LOWER}" "\$file"; then
            echo "Found: \$file"

            if grep -q "remote-debugging-port" "\$file"; then
                echo "  Already has CDP flag."
                ((found++))
            else
                cp "\$file" "\$file.bak"
                sed -i "s|^Exec=\\(.*\\)|Exec=\\1 \${FLAG}|" "\$file"
                sed -i "s|^TryExec=\\(.*\\)|TryExec=\\1 \${FLAG}|" "\$file"
                echo "  Updated with CDP flag."
                ((found++))
            fi
        fi
    done < <(find "\$dir" -maxdepth 1 -name "*.desktop" -print0 2>/dev/null)
done

if [ \$found -eq 0 ]; then
    echo "No .desktop file found for \${IDE}."
    echo "Please add '\${FLAG}' to your IDE launch command manually."
fi

echo ""
echo "Done! Please restart \${IDE}."`;
    }

    /**
     * Generate setup webview HTML
     */
    getSetupHTML(script, platformName) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CDP Setup</title>
    <style>
        body {
            font-family: system-ui, -apple-system, sans-serif;
            background: #1e1e1e;
            color: #ccc;
            padding: 24px;
            line-height: 1.6;
        }
        h1 { color: #fff; font-size: 1.4em; margin-bottom: 8px; }
        h2 { color: #a855f7; font-size: 1.1em; margin-top: 24px; }
        .badge { display: inline-block; background: #a855f740; color: #a855f7; padding: 2px 8px; border-radius: 4px; font-size: 12px; margin-left: 8px; }
        pre {
            background: #2d2d2d;
            border: 1px solid #444;
            border-radius: 8px;
            padding: 16px;
            overflow-x: auto;
            font-size: 13px;
            color: #d4d4d4;
            white-space: pre-wrap;
            word-break: break-all;
        }
        .copy-btn {
            display: inline-block;
            background: #a855f7;
            color: #fff;
            padding: 10px 20px;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 600;
            margin-top: 12px;
        }
        .copy-btn:hover { background: #9333ea; }
        .steps { margin: 16px 0; padding-left: 20px; }
        .steps li { margin-bottom: 8px; }
        .success { color: #22c55e; }
        .warning { color: #f59e0b; }
    </style>
</head>
<body>
    <h1>CDP Setup <span class="badge">${platformName}</span></h1>
    <p>Background Mode requires Chrome DevTools Protocol (CDP) to communicate with the browser.</p>

    <h2>Instructions</h2>
    <ol class="steps">
        <li>Click <strong>Copy Script</strong> below</li>
        <li>${platformName === 'Windows' ? 'Open <strong>PowerShell as Administrator</strong>' : 'Open <strong>Terminal</strong>'}</li>
        <li>Paste and run the script</li>
        <li class="warning">⚠️ <strong>Completely restart your IDE</strong> after running the script</li>
    </ol>

    <h2>Setup Script</h2>
    <pre>${script.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>

    <button class="copy-btn" onclick="copyScript()">📋 Copy Script</button>

    <h2>Troubleshooting</h2>
    <ul class="steps">
        <li>Make sure the IDE is <strong>completely closed</strong> before restarting</li>
        <li>If port 9000 is in use, try editing the script to use 9001</li>
        <li>Check SETUP_GUIDE.md for detailed troubleshooting</li>
    </ul>

    <script>
        const vscode = acquireVsCodeApi();
        function copyScript() {
            vscode.postMessage({ command: 'copyScript' });
        }
    </script>
</body>
</html>`;
    }
}

module.exports = { Relauncher };
