# Open WebUI Desktop for Ivy Bridge · AVX1

[Русский](#русский) · [Release / Скачать](https://github.com/aktalascloud/open-webui-desktop-ivybridge-avx1/releases/tag/daily-20261104-16b47dbc) · [Guide / Документация](patches/README.md) · [Evidence / Данные](https://github.com/aktalascloud/open-webui-desktop-ivybridge-avx1/blob/68d238235482f8d3afa2ca9ef7315dd090dbd27d/.avx1/measurements/latest.json) · [Upstream](https://github.com/open-webui/desktop)

A Windows desktop client for Open WebUI on Ivy Bridge. Connect to independent WebUI and Terminal services, with per-connection isolation, voice shortcuts and a localized interface.

**Quick start.** Run the Windows setup EXE. For source builds, use `Build.cmd status` and `Build.cmd build` with Python 3.12+, Git and GitHub CLI. [Applied patches](patches/README.md).

**Evidence.** The synthetic OutputBuffer check kept 1,024 bytes out of a 200,000-byte UTF-8 fixture without invalid replacement characters. The Windows release also documents its qualified AVX PTY binary and reconnect checks.

## Русский

Настольный Windows-клиент Open WebUI для Ivy Bridge. Подключается к отдельным сервисам WebUI и Terminal. Есть изоляция подключений, голосовые сочетания и русский интерфейс.

**Запуск.** Запустите установщик Windows. Для сборки из исходников выполните `Build.cmd status` и `Build.cmd build` с Python 3.12+, Git и GitHub CLI. [Патчи](patches/README.md).

**Проверка.** В синтетической проверке OutputBuffer из входных 200 000 байт UTF-8 сохранилось 1 024 байта без невалидных символов замены. В выпуске описаны проверенная AVX-сборка PTY и тесты повторного подключения.

[All projects / Все проекты](https://github.com/aktalascloud)
