# Open WebUI Desktop · Ivy Bridge AVX1

[English](README.md) · [Русский](README.ru.md)

One current build combines fresh official source and reviewed fork patches. Extended Russian translation covers the interface, tray and native context menus.

Download and run the **EXE installer** from the latest release. Choose an installation directory or install over the existing version. Profiles, data and models remain separate from application files. Desktop and backend installation use this owner's verified forks.

[Upstream](https://github.com/open-webui/desktop) · [Releases](https://github.com/aktalascloud/open-webui-desktop-ivybridge-avx1/releases)

## Patches

| ID | Change |
|---|---|
| DESK-001 | Direct the desktop distribution feed to this fork; retain Open WebUI branding and profile identity. |
| DESK-002 | Rebuild node-pty with MSVC O2, GL, LTCG, AVX and precise floating point. Electron remains the upstream prebuilt engine. |
| DESK-003 | Security-maintained Electron 45; modern Svelte type resolution; explicit managed backend reuse; no credential-bearing config/command logs; uv targets the selected Python. |
| DESK-004 | Fix renderer TypeScript contracts, remove undefined unused handlers, and clean up async MutationObserver ownership; type check now passes. |
| DESK-005 | Build a normal NSIS EXE installer; update Desktop through one EXE feed and install verified optimized WebUI/Terminal forks with runtime staging and owner CODE guards. |
| DESK-006 | Add complete Russian UI, tray and native context menus, status/error messages; verify locale keys and actual installed onboarding. |

No percentage gain is claimed for GUI or LLM speed. Native terminal functionality is qualified on the actual Xeon E5-2697 v2. PGO is disabled; Electron/Python retain vendor builds.

Original licenses and notices are preserved; exact corresponding source is available at each release tag. Private filter/bridge code, settings, logs and model weights are excluded.
