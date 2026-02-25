# CDP Setup Guide — Auto Accept Agent Pro

## Overview

Auto Accept Agent Pro uses **Chrome DevTools Protocol (CDP)** for Background Mode.
Each IDE window must be launched with its own unique CDP port for full isolation.

---

## Quick Start

Use the **Smart Launcher** (recommended):

1. Open the Command Palette → `Auto Accept: Setup CDP`
2. Copy the generated smart launcher script
3. Save it as `launch-ide.ps1` (Windows) or `launch-ide.sh` (Mac/Linux)
4. **Always use this script to launch your IDE** — it auto-assigns a unique port

> ⚠️ **IMPORTANT**: Do NOT use "File > New Window" (Ctrl+Shift+N).
> It creates a window in the same process, sharing the CDP port.
> Always launch from the script for full isolation.

---

## Port Range

| Item             | Value           |
|------------------|-----------------|
| Default range    | `19222 – 19242` |
| Total ports      | 20              |
| Conflict risk    | Very low — far above common service ports |

Each launch automatically picks the next available port in this range.

---

## Manual Setup (per Platform)

### Windows

**Option 1 — PowerShell (recommended):**

```powershell
# Find free port and launch
for ($p = 19222; $p -le 19242; $p++) {
    if (-not (Get-NetTCPConnection -LocalPort $p -EA 0)) {
        Start-Process "Antigravity.exe" "--remote-debugging-port=$p"
        break
    }
}
```

**Option 2 — Shortcut (single instance only):**

1. Right-click your IDE shortcut
2. Select "Properties"
3. In the "Target" field, add at the end: ` --remote-debugging-port=19222`
4. Click OK

---

### Mac

```bash
# Auto-assign port
for p in $(seq 19222 19242); do
    if ! lsof -i :$p > /dev/null 2>&1; then
        open -n -a "Antigravity" --args --remote-debugging-port=$p
        break
    fi
done
```

---

### Linux

```bash
# Auto-assign port
for p in $(seq 19222 19242); do
    if ! ss -tlnp | grep -q ":$p "; then
        antigravity --remote-debugging-port=$p &
        break
    fi
done
```

---

## Multiple IDE Instances

The smart launcher handles this automatically:

| Instance   | Port    | Status            |
|------------|---------|-------------------|
| Instance 1 | `19222` | Fully isolated    |
| Instance 2 | `19223` | Fully isolated    |
| Instance 3 | `19224` | Fully isolated    |
| ...        | ...     | Up to 20 total    |

Each instance has its own CDP connection and BG mode — no sharing.

---

## Troubleshooting

### CDP Not Connecting

1. Check if CDP port is in use:
   ```powershell
   Get-NetTCPConnection -LocalPort 19222
   ```
2. Try the next port: `--remote-debugging-port=19223`
3. Make sure you launched the IDE **from the script** — not via "File > New Window"

### All Ports In Use

Close some IDE instances. The range supports up to 20 simultaneous instances.

### IDE Won't Start

1. Verify the port flag format: `--remote-debugging-port=19222`
2. Try a different port number within the range (19222–19242)

---

## Security Note

CDP provides access to the IDE's internal browser for automation only.
The debug port is bound to `127.0.0.1` (localhost) and cannot be accessed remotely.
