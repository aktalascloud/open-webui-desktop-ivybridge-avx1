# Applied downstream patches: desktop

Only currently applied maintainer differences from the exact official baseline are included.
Содержит только текущие применённые нами отличия от указанного официального upstream.
Mainstream-only commits, rejected proposals and reverted experiments are excluded.
Коммиты самого mainstream, неприменённые предложения и отменённые эксперименты исключены.

Official baseline: `f09e8015f7ffa237f4f1b99177abf42c11cc99bc`. Downstream snapshot: `fe629d1ee2e3239b79fe9ecc8e7851dac474dee6`.
Patches are already applied in this fork. Apply `series` only to a clean checkout of that exact baseline.
В этом форке патчи уже применены. `series` предназначен только для чистого checkout указанной базы.
Apply the numbered patches in the order listed in `series`. Each row describes one topic.
Накладывайте патчи в порядке файла `series`. Изменения в общих файлах остаются вместе.
The manifest records each patch’s exact file list and SHA256.

Independent managed WebUI/Terminal, isolated per-connection guests, account-bound voice shortcuts, corrected Refresh binding and qualified AVX PTY reuse.

| Order | Patch | Description | Files |
|---:|---|---|---:|
| 1 | [01-connection-isolation.patch](01-connection-isolation.patch) | Isolate WebView guests by connection and scope navigation and permissions / Изолирует WebView по подключениям и ограничивает навигацию и разрешения. | 7 |
| 2 | [02-voice-shortcuts.patch](02-voice-shortcuts.patch) | Bind microphone shortcuts to account sessions and add recorder UI and cues / Привязывает голосовые команды к сессии аккаунта, добавляет интерфейс записи и сигналы. | 11 |
| 3 | [03-managed-services.patch](03-managed-services.patch) | Track independently launched WebUI and Terminal, showing readiness and logs in Desktop / Отслеживает независимо запущенные WebUI и Terminal, показывает готовность и логи в Desktop. | 13 |
| 4 | [04-localization.patch](04-localization.patch) | Translate Desktop menus and connection settings / Переводит меню Desktop и настройки подключений. | 14 |
| 5 | [05-desktop-shell.patch](05-desktop-shell.patch) | Wire connection and setup screens, IPC and the Refresh binding into the Desktop shell / Связывает окна подключения и настройки, IPC и кнопку обновления. | 30 |
| 6 | [06-updates.patch](06-updates.patch) | Point updates to the fork’s installer and verify update policy / Направляет обновления на установщик форка и проверяет политику обновлений. | 4 |
| 7 | [07-avx-pty.patch](07-avx-pty.patch) | Build and verify the Windows PTY payload for AVX and LTCG / Собирает и проверяет Windows PTY с AVX и LTCG. | 4 |
| 8 | [08-electron-packaging.patch](08-electron-packaging.patch) | Set Electron dependencies, installer metadata, entitlements and packaged launch checks / Настраивает зависимости Electron, метаданные установщика, права и проверки запуска. | 19 |
| 9 | [09-portable-install.patch](09-portable-install.patch) | Provide portable build commands and the fork installer / Добавляет команды переносимой сборки и установщик. | 4 |
| 10 | [10-ci-build.patch](10-ci-build.patch) | Pin toolchains and package inputs, and run the fork build and publication checks / Закрепляет инструменты и входы сборки, запускает проверки пакетов и публикации. | 9 |
| 11 | [11-project-docs.patch](11-project-docs.patch) | Document fork setup, support and license terms / Описывает установку, поддержку и условия лицензирования форка. | 5 |
| 12 | [12-fork-records.patch](12-fork-records.patch) | Record fork changes, upstream reviews and qualification measurements / Хранит журнал изменений, разбор upstream и результаты проверок. | 2 |
