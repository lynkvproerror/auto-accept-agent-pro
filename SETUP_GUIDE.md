# Auto Accept Agent Pro — Setup Guide

This guide helps you enable Chrome DevTools Protocol (CDP) for Auto Accept Agent Pro to work properly.

## Why is CDP needed?

Auto Accept Agent Pro uses **two modes**:

| Mode | CDP Required? | Features |
|------|--------------|----------|
| **Native** (Auto Accept only) | ❌ No | Fires VS Code accept commands every poll cycle |
| **Full CDP** (Background Mode + Auto Scroll) | ✅ Yes | DOM-level button clicking, chat-only scroll, multi-tab cycling |

Without CDP, the extension can still auto-accept via native commands, but **Background Mode** and **smart Auto Scroll** (chat-panel-only) require CDP.

## CDP Port

The extension uses **port 9222** (Chrome default debug port).

**Injection scripts** scan range **9219–9225** (7 ports).
**Permission scripts** scan **9222, 9229, 9000–9014** (17 ports) for broader coverage.

Launch your IDE with:
```
--remote-debugging-port=9222
```

> **Tip:** Use **Auto-Fix CDP** from the Settings panel to automatically patch your Windows shortcut with the CDP flag.

## Setup Instructions by Platform

### Windows

1. **Copy the setup script** from the Auto Accept setup panel (click `$(gear)` → "Show Setup Guide")
2. **Open PowerShell as Administrator**
   - Press Windows key → type "PowerShell" → right-click → "Run as Administrator"
3. **Paste and run the script**
4. **Restart your IDE completely**

The script will:
- Search for IDE shortcuts (Desktop, Start Menu, Taskbar)
- Add `--remote-debugging-port=9222` to all shortcuts found
- Or create a new shortcut if none exist

### macOS

1. **Copy the setup script** from the Auto Accept setup panel
2. **Open Terminal** (Cmd+Space → "Terminal")
3. **Paste and run the script**
4. **Quit and restart your IDE completely**

Alternative — launch from Terminal directly:
```bash
open -n -a "Antigravity" --args --remote-debugging-port=9222
```

### Linux

1. **Copy the setup script** from the Auto Accept setup panel
2. **Open Terminal** (Ctrl+Alt+T)
3. **Paste and run the script**
4. **Restart your IDE completely**

The script will:
- Search for `.desktop` files in standard locations
- Add CDP flag to Exec lines
- Support Snap, Flatpak, and native installations

## Troubleshooting

### Windows: Script execution blocked

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### Mac/Linux: Permission denied

```bash
chmod +x script.sh
```

### Changes not taking effect

1. **Completely quit the IDE** (not just close windows)
2. Kill all IDE processes:
   - Windows: Task Manager → End Task
   - Mac: `killall Antigravity` (or Cursor)
   - Linux: `pkill -f antigravity`
3. **Restart the IDE** using the modified shortcut

### IDE not launching / Port conflict

1. Check if port 9222 is in use: `netstat -an | findstr 9222`
2. The extension scans ports 9219–9225, so close any conflicting process
3. Restore from backup (`.bak` files next to modified shortcuts)

### Manual Setup

**Windows:**
1. Right-click IDE shortcut → Properties
2. In "Target" field, add at the end: ` --remote-debugging-port=9222`
3. Click OK

**macOS:**
```bash
open -n -a "Antigravity" --args --remote-debugging-port=9222
```

**Linux:**
Edit your `.desktop` file and add `--remote-debugging-port=9222` to the `Exec` line.

## Security Note

The CDP port is only accessible from **localhost (127.0.0.1)** by default, so it's safe on your local machine. Avoid exposing it on shared or public networks.

## Supported IDEs

- **Antigravity** (primary)
- **Cursor**
- **Windsurf**
- **Trae**
- **VS Code** (partial — no Background Mode)
- Any Electron-based IDE supporting Chrome DevTools Protocol
