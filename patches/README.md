# Applied downstream patches: desktop

Only currently applied maintainer differences from the exact official baseline are included.
Содержит только текущие применённые нами отличия от указанного официального upstream.
Mainstream-only commits, rejected proposals and reverted experiments are excluded.
Коммиты самого mainstream, неприменённые предложения и отменённые эксперименты исключены.

Official baseline: `f09e8015f7ffa237f4f1b99177abf42c11cc99bc`. Downstream snapshot: `11e410186c494e44f51fba3911df418cab1796d4`.
Patches are already applied in this fork. Apply `series` only to a clean checkout of that exact baseline.
В этом форке патчи уже применены. `series` предназначен только для чистого checkout указанной базы.
Files are grouped by purpose; manifest.json records paths, hashes and the exact reconstructed tree.

Independent managed WebUI/Terminal, isolated per-connection guests, account-bound voice shortcuts, corrected Refresh binding and qualified AVX PTY reuse.

| Patch | Description | Files |
|---|---|---|
| [01-runtime.patch](01-runtime.patch) | Local runtime, integration, security, dependency and platform adaptations / Наши изменения работы, интеграций, безопасности и платформ. | 77 |
| [02-build.patch](02-build.patch) | Our reproducible build, toolchain and CI recipes / Наши сборочные рецепты, toolchain и CI. | 21 |
| [03-tests.patch](03-tests.patch) | Our regressions and adaptations of upstream fixtures / Наши регрессии и адаптации тестов. | 19 |
| [04-documentation.patch](04-documentation.patch) | Our fork documentation, notices and qualification evidence / Наши описания форка, уведомления и доказательства квалификации. | 5 |
