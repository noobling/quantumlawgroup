# Installing DeepSolve Legal (Windows)

DeepSolve Legal is a self-contained desktop app. **No administrator rights are required** — it installs into your user profile.

## Option 1 — Easy install (recommended)

1. Unzip `DeepSolve-Legal-<version>-win-arm64.zip` anywhere (e.g. your Downloads folder).
2. Open the unzipped `DeepSolve-Legal` folder.
3. Double-click **`Install DeepSolve Legal.bat`**.
   - If Windows SmartScreen warns you, click **More info → Run anyway** (the app is unsigned).
4. When it finishes, launch **DeepSolve Legal** from the Start Menu or the Desktop shortcut.

This copies the app to `%LOCALAPPDATA%\Programs\DeepSolve Legal` and creates Start Menu + Desktop shortcuts.

## Option 2 — Command line install

If you can't run the `.bat` (e.g. locked-down policy, or you prefer a terminal):

```powershell
# from inside the unzipped DeepSolve-Legal folder
powershell -NoProfile -ExecutionPolicy Bypass -File ".\install.ps1"
```

## Option 3 — Portable (no install at all)

Just run it in place — no install step needed:

```powershell
# from inside the unzipped folder
& ".\DeepSolve Legal\DeepSolve Legal.exe"
```

You can also double-click `DeepSolve Legal\DeepSolve Legal.exe` directly.

## First run

1. Open **Settings** (left sidebar).
2. Paste your **Anthropic API key** (from <https://console.anthropic.com>) and click **Save**. It's encrypted on your machine with Windows DPAPI and never leaves your computer.
3. Pick a workflow from the launchpad and go.

Your matters, drafts, and settings live in `%APPDATA%\deepsolvelegal`.

## Uninstall

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\uninstall.ps1"
```

(or delete `%LOCALAPPDATA%\Programs\DeepSolve Legal` and the two shortcuts.)

## Notes

- This build targets **Windows on ARM (arm64)**. For Intel/AMD machines, rebuild with `--arch=x64`.
- The app is **not code-signed**, so SmartScreen will prompt on first run — this is expected for an in-house build.
