# Open WebUI Desktop · Ivy Bridge AVX1

[English](README.md) · [Русский](README.ru.md) · [Upstream](https://github.com/open-webui/desktop) · [Releases](https://github.com/aktalascloud/open-webui-desktop-ivybridge-avx1/releases/latest)

Windows installer with extended Russian interface, dialogs and context menus.

Run the latest EXE installer. It uses the optimized WebUI fork and preserves the existing profile.

## Changes

- Independent backend and a verified fork update feed.
- Compatible WebUI/Terminal packages are staged together.
- `node-pty`: MSVC `/O2 /GL /arch:AVX` and `/LTCG`. [Full patch list](.avx1/PATCHES.json).

## Evidence

Native terminal startup passed on Xeon E5-2697 v2. GUI/LLM speed percentages have not been measured. Electron and Python retain vendor binaries; PGO is disabled.

Original licenses/notices and source history are preserved. Exact corresponding source is linked from each release. Credentials, logs, models and private filter/bridge code stay outside the public packages.
