# Open WebUI Desktop AVX1

[Русский](README.ru.md)

Unofficial fork with reviewed agent/MCP fixes and extended Russian UI. One latest NSIS EXE.

[Upstream](https://github.com/open-webui/desktop) · [Release](https://github.com/aktalascloud/open-webui-desktop-ivybridge-avx1/releases/latest) · [Patches](.avx1/PATCHES.json)

Mainstream Ollama controls are optional and disabled by default. Independent managed WebUI/Terminal, per-connection guest isolation and the corrected Refresh binding remain; exact qualified AVX/LTCG PTY binaries are reused.

## Build

Requires Python 3.12+, Git and GitHub CLI for CI. No LLM, model weights or Codex dependency.

```cmd
Build.cmd status
Build.cmd build
```

`build` verifies the clean published commit and dispatches the pinned workflow. For a prepared local compiler/SDK environment: `Build.cmd local`. Dependencies, flags, tests and license gates are in `.avx1/`; lockfiles and source history are retained. Signing keys stay outside the repository.

## Run and verify

Use the single release package. Keep user data separate from source. Settings, endpoints and model selection are runtime configuration, not build requirements. Ivy Bridge: AVX/F16C, O3 and verified LTO, without AVX2/FMA/PGO/fast-math. Actual native flags and prebuilt components are identified in the manifest.

Current checks and measurements: [.avx1/measurements/latest.json](.avx1/measurements/latest.json). CPU microbenchmarks are not LLM tokens/s. Original licenses and notices apply.

Native voice input uses the selected signed-in connection. Changing its connection/account during recording prevents upload or delivery to a different account; uncertain audio submissions are never replayed.

Project-managed Open Terminal reconnects through authenticated health without spawning a duplicate or replacing its key. Install the matching Terminal fork before this Desktop update; an incompatible or occupied endpoint fails closed. Standalone Desktop owns only the child it launches.

Connection startup now supplies a defined refresh binding; packaged checks open an actual guest, enable Refresh, and reconnect an independently owned Terminal. Native PTY binaries are reused byte-for-byte from the qualified source/compiler/ABI/flag/hash reference in `.avx1/desktop-native-reference.json`. For a cold local cache, restore its five exact files from the last qualified package or matching installation before building; unchanged native sources do not need recompilation.
