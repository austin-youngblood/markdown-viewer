# Markdown Viewer

A live-preview Markdown editor for Windows with GitHub-flavored Markdown, syntax highlighting, math, and Mermaid diagrams. Built on Electron.

## Features

- Live split-pane preview that updates as you type
- **GitHub-flavored Markdown**: tables, task lists, strikethrough, autolinks
- **Syntax-highlighted code blocks** via highlight.js (recognized languages get colored automatically)
- **Math** with KaTeX — `$inline$` and `$$display$$`, plus `\(...\)` / `\[...\]`
- **Mermaid diagrams** in ` ```mermaid ` code fences
- **Find & Replace** with case-sensitive, whole-word, regex, and in-selection toggles; live highlight overlay of every match in the editor
- **Click-to-edit blocks in the preview** — double-click any heading, paragraph, list, or table to edit just that block's source in a popover
- **Insert toolbar** with one-click block templates (headings, lists, tables with a size picker, code blocks with a language picker, math, Mermaid, image picker)
- **Tabs**: open multiple documents in one window, drag to reorder, drag a tab out to detach as a new window, or drop on another window's tab bar to combine
- **Multiple windows** via `File → New Window`
- **File associations** for `.md`, `.markdown`, `.mdown`, `.mdx` (optional during install)
- **Task-list checkbox sync** — clicking a checkbox in the preview updates the source `- [ ]` / `- [x]`
- **In-app updates** via GitHub Releases; the Windows taskbar pin survives upgrades

## Download

Get the latest release from the [Releases page](https://github.com/austin-youngblood/markdown-viewer/releases/latest). Two flavors:

- **`Markdown Viewer-X.Y.Z-setup.exe`** — NSIS installer with Start Menu shortcut and optional desktop shortcut + `.md` file association.
- **`Markdown Viewer-X.Y.Z-portable.exe`** — single self-contained `.exe`. Runs from anywhere; no install, no shortcuts.

Both are unsigned, so Windows SmartScreen will warn on first run. Click **More info → Run anyway**.

After the first install, the app polls GitHub for new versions on launch and every four hours. When one is ready, the status bar shows an **Install & Restart** button.

## Keyboard shortcuts

| Action                         | Shortcut             |
|:-------------------------------|:---------------------|
| New tab                        | `Ctrl+T`             |
| Close tab                      | `Ctrl+W`             |
| Next / previous tab            | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| New window                     | `Ctrl+Shift+N`       |
| Open file                      | `Ctrl+O`             |
| Save                           | `Ctrl+S`             |
| Save As                        | `Ctrl+Shift+S`       |
| Find                           | `Ctrl+F`             |
| Find & Replace                 | `Ctrl+H`             |
| Toggle editor pane             | `Ctrl+E`             |
| Edit a block in the preview    | Double-click         |
| Check for updates              | `View → Check for Updates...` |

## Building from source

Requires Node.js 20 or newer (which bundles `npm`).

```cmd
git clone https://github.com/austin-youngblood/markdown-viewer.git
cd markdown-viewer
npm install
npm start
```

Build the Windows installer + portable `.exe`:

```cmd
npm run dist
```

Artifacts land in `dist/`.

### Troubleshooting the first build

On Windows without Developer Mode, electron-builder's first build will fail extracting `winCodeSign-2.6.0.7z` because the archive contains macOS symlinks that can't be created without elevated privileges. Pre-extract it once, excluding the `darwin/` directory:

```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign" -ErrorAction SilentlyContinue
$dest = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0"
$tmp = Join-Path $env:TEMP "winCodeSign-2.6.0.7z"
New-Item -ItemType Directory -Path $dest -Force | Out-Null
Invoke-WebRequest -Uri "https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z" -OutFile $tmp -UseBasicParsing
& "$PWD\node_modules\7zip-bin\win\x64\7za.exe" x $tmp "-o$dest" -xr!darwin -y
```

Or enable Developer Mode in **Settings → Privacy & Security → For developers** as the long-term fix.

## Publishing a release

Requires a GitHub Personal Access Token with `public_repo` scope, set as `GH_TOKEN`:

```cmd
setx GH_TOKEN ghp_yourtoken
```

(Open a fresh `cmd` window after `setx` — it doesn't affect the current session.)

Then, for each release:

1. Bump `"version"` in `package.json`.
1. Run `npm run release` — builds and uploads installer, portable, blockmap, and `latest.yml` to a draft release on GitHub.
1. Open the [Releases page](https://github.com/austin-youngblood/markdown-viewer/releases), edit the draft, add release notes, and click **Publish release**.

Installed clients pick up the new version within ~4 hours or immediately via `View → Check for Updates...`.

## Tech stack

[Electron 33](https://www.electronjs.org/) · [markdown-it](https://github.com/markdown-it/markdown-it) · [highlight.js](https://highlightjs.org/) · [KaTeX](https://katex.org/) · [Mermaid](https://mermaid.js.org/) · [electron-builder](https://www.electron.build/) · [electron-updater](https://www.electron.build/auto-update)

## License

MIT
