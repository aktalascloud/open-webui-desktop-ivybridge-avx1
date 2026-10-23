import english from '../renderer/src/lib/i18n/locales/en-US/translation.json'
import russian from '../renderer/src/lib/i18n/locales/ru-RU/translation.json'

let language = 'ru-RU'
const messages = new Map<string, string>(Object.entries(english).map(([key, value]) => [value, (russian as Record<string, string>)[key] ?? value] as [string, string]))
Object.entries({
  'Show Open WebUI': 'Показать Open WebUI',
  'Quit Open WebUI': 'Выйти из Open WebUI',
  'Open WebUI (Local)': 'Open WebUI (локально)',
  'Local': 'Локально',
  'Open Link in Browser': 'Открыть ссылку в браузере',
  'Copy Link': 'Копировать ссылку',
  'Undo': 'Отменить',
  'Redo': 'Повторить',
  'Cut': 'Вырезать',
  'Copy': 'Копировать',
  'Paste': 'Вставить',
  'Select All': 'Выделить всё',
  'Voice Input': 'Голосовой ввод',
  'Call': 'Голосовой вызов',
  'Voice Input Failed': 'Ошибка голосового ввода',
  'Voice Input Error': 'Ошибка голосового ввода',
  'Screen Recording Permission Required': 'Требуется разрешение на запись экрана',
  'Application has been reset.': 'Настройки приложения сброшены.',
  'Reset failed': 'Не удалось сбросить настройки',
  'No connection configured. Set up a connection in Settings before using voice input.': 'Нет подключения. Настройте его перед использованием голосового ввода.',
  'No connection configured. Set up a connection in Settings before using the call shortcut.': 'Нет подключения. Настройте его перед использованием голосового вызова.',
  'Microphone access denied. Enable it in System Settings → Privacy & Security → Microphone, then restart the app.': 'Доступ к микрофону запрещён. Разрешите его в настройках системы: Конфиденциальность и безопасность → Микрофон. Затем перезапустите приложение.',
  'Open WebUI needs Screen Recording access to capture screenshots. Please enable it in System Settings → Privacy & Security → Screen Recording, then restart the app.': 'Для снимков экрана Open WebUI требуется разрешение на запись экрана. Разрешите его в настройках системы: Конфиденциальность и безопасность → Запись экрана. Затем перезапустите приложение.',
  'Transcription failed. Check logs for details.': 'Не удалось распознать речь. Подробности в журнале.',
  'An unknown error occurred with voice input.': 'Неизвестная ошибка голосового ввода.',
  'Downloading Python…': 'Скачивание Python…',
  'Installing Open WebUI…': 'Установка оптимизированного Open WebUI…',
  'Installing Open Terminal…': 'Установка Open Terminal из форка…',
  'Updating Open WebUI…': 'Обновление оптимизированного Open WebUI…',
  'Starting server…': 'Запуск сервера…',
  'Python is not installed. Please reinstall the app or run setup again.': 'Python не установлен. Повторите настройку приложения.',
  'Python installation failed. Please check your internet connection and try again.': 'Не удалось установить Python. Проверьте подключение к сети и повторите попытку.',
  'Installing uv package manager…': 'Установка менеджера пакетов uv…',
  'Microphone access denied': 'Доступ к микрофону запрещён',
  'No connection configured. Set up a connection in Settings first.': 'Нет подключения. Сначала настройте его в параметрах.',
  'No URL provided': 'Адрес не указан',
  'Managed backend is unavailable. Start it using the project launcher.': 'Внешний сервер недоступен. Запустите его штатным средством проекта.',
  'Could not register shortcut': 'Не удалось назначить сочетание клавиш',
  'Failed to register shortcut': 'Не удалось назначить сочетание клавиш',
  'It may be in use by another application.': 'Возможно, оно занято другим приложением.',
  'It may conflict with another application.': 'Возможно, оно конфликтует с другим приложением.'
}).forEach(([key, value]) => messages.set(key, value))

export const setNativeLanguage = (value?: string): void => { language = value || 'ru-RU' }
export const nativeText = (text: string): string => {
  if (!language.toLowerCase().startsWith('ru') || typeof text !== 'string') return text
  const exact = messages.get(text)
  if (exact) return exact
  const colon = text.indexOf(':')
  if (colon > 0 && messages.has(text.slice(0, colon))) return messages.get(text.slice(0, colon)) + text.slice(colon)
  return text
}
