# BDSM - Browser Dynamic State Manager

Chrome Extension (Manifest V3) for managing tab groups as workspaces with a single active (expanded) group.

## Features

- Treats each Chrome tab group as a workspace
- Keeps only one group expanded at a time
- Switches workspaces with keyboard shortcuts:
  - `Alt+Shift+Up` -> previous group
  - `Alt+Shift+Down` -> next group
- Switches tabs inside the active workspace group:
  - `Alt+Shift+Left` -> previous tab in group
  - `Alt+Shift+Right` -> next tab in group
- On workspace switch:
  - collapses all groups except target
  - focuses the first tab in the target group
- Persists last active group per window using `chrome.storage.local`
- Restores workspace state on browser startup/extension startup
- **Settings page** (`options.html`): inspect groups for the **current window**, move tabs between groups, edit group titles/colors, and manage **Auto group rules** (URL regex → target tab group).

## Settings (options page)

The options page opens in a normal Chrome tab (`options.html`).

**Ways to open it:**

1. **`chrome://extensions`** → Find **“BDSM - Browser Dynamic State Manager”** → click **Details** → open **Extension options** (wording varies slightly; link is usually near the bottom of the Details view).
2. **Toolbar**: Right‑click the extension’s toolbar icon (**puzzle-piece** overflow menu → pin **BDSM** if needed) → choose **Extension options**, **Options**, or **Manage extension** depending on Chromium version; from **Manage extension**, use **Extension options**.

There is still **no toolbar popup**; shortcuts are handled only in the background service worker.

## Install (Unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this project folder (`BDSM`)

## Usage

- Create tab groups in a Chrome window.
- Expand any group manually to make it active; other groups collapse automatically.
- Use `Alt+Shift+Up` and `Alt+Shift+Down` to cycle workspaces.
- Use `Alt+Shift+Left` and `Alt+Shift+Right` to cycle tabs within the current group.

## Notes

- Keyboard shortcuts still run entirely in the **background service worker** (no toolbar popup required).
- Shortcuts can be customized in Chrome via:
  - `chrome://extensions/shortcuts`
