# Ropilot-Unpacked

This repository contains the extracted contents of `resources/app.asar` from the Windows release of Ropilot Studio **1.3.2**. The package contains the Electron desktop client and its bundled resources.

## Files to start with

| File | Role |
| --- | --- |
| [package.json](package.json) | Package metadata and Electron entry point. |
| [bootstrap.js](bootstrap.js) | Initializes Electron and loads the [production main-process bundle](main.min.js). |
| [preload.js](preload.js) | Exposes desktop operations to the renderer through Electron IPC. |
| [src/index.html](src/index.html) | Renderer entry page. The interface code is in [src/](src/). |
| [lib/plugin.js](lib/plugin.js) | Downloads and installs the Roblox Studio plugin. |
| [lib/go-server.js](lib/go-server.js) | Manages the separate `ropilot-infra.exe` backend shipped alongside the archive. |

## Archive verification

All 220 extracted files matched the SHA-256 hashes in the ASAR index.

```text
app.asar SHA-256
9084bf73ecb9c828854ccb9da3e12791ac873960b7c5b985dc5ca319961e255f
```

Ropilot Studio and its bundled dependencies retain their respective copyright and license terms.
