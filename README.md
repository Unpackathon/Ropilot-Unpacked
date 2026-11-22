# Ropilot-Unpacked

Ropilot Studio is an AI-assisted development app for Roblox creators. It pairs a desktop chat interface with a plugin inside Roblox Studio. A creator can describe a feature in plain English, and the assistant can inspect the open project, edit Luau scripts and UI, and run a playtest to check the result. For example, it can add a shop menu and then test whether a purchase updates the player's balance. [Ropilot product overview](https://ropilot.ai/)

***THIS IS SAFE TO USE - IGNORE ROPILOT STAFF. YOU MAY CHECK THE SRC YOURSELF.***

The app also integrates with Blender to create 3D models and animations and import them into Roblox Studio. [Ropilot Blender integration](https://ropilot.ai/#:~:text=Models%20and%20animations%2C%20not%20just%20scripts.)

## What's in this repository

This repository contains the extracted `resources/app.asar` from **Ropilot Studio 1.3.2 for Windows**. The archive contains the Electron desktop client, including its JavaScript, HTML, assets, and bundled JavaScript dependencies. The Windows install ships the compiled Go backend separately at `resources/bin/ropilot-infra.exe`.

## How the desktop app fits together

- **Electron main process.** [bootstrap.js](bootstrap.js) loads [main.min.js](main.min.js). The main process handles desktop operations, including starting the local backend and installing the Roblox Studio plugin.
- **Renderer.** The chat and project UI starts at [src/index.html](src/index.html). [preload.js](preload.js) exposes desktop operations over Electron IPC, and [src/js/websocket.js](src/js/websocket.js) forwards incoming WebSocket messages to the app's message handler.
- **Roblox Studio integration.** [lib/plugin.js](lib/plugin.js) downloads the plugin and writes it to the Studio plugins folder. The installed plugin gives Ropilot access to the open Roblox project. [Ropilot support](https://ropilot.ai/support)

## Files to start with

| File | Role |
| --- | --- |
| [package.json](package.json) | Package version, dependencies, and Electron entry point. |
| [lib/go-server.js](lib/go-server.js) | Manages the separate `ropilot-infra.exe` backend shipped alongside the archive. |
| [src/js/setup-flow.js](src/js/setup-flow.js) | Desktop onboarding and setup screens. |
| [src/js/message-sender.js](src/js/message-sender.js) and [message-handler.js](src/js/message-handler.js) | Outgoing chat requests and incoming events. |
| [src/js/playtest-panel.js](src/js/playtest-panel.js) | Playtest UI and screenshot previews. |
| [src/js/blender-preview.js](src/js/blender-preview.js) | In-app previews for Blender models and animations. |
| [src/js/rojo-manager.js](src/js/rojo-manager.js) | Rojo controls and status in the desktop UI. |

## Archive verification

All 220 extracted files matched the SHA-256 hashes in the ASAR index. The file map above comes from static inspection of this package. Separate inspection of the backend's embedded build metadata identified a 64-bit Windows executable built with Go 1.26.2.

```text
app.asar SHA-256
9084bf73ecb9c828854ccb9da3e12791ac873960b7c5b985dc5ca319961e255f
```

Ropilot Studio and its bundled dependencies retain their respective copyright and license terms.
