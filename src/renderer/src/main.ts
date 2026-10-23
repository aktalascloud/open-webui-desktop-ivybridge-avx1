import { mount } from 'svelte'

import './app.css'
import { initI18n } from './lib/i18n'

import App from './App.svelte'

const start = async () => {
  const config: { language?: string } = await window.electronAPI.getConfig().catch(() => ({}))
  initI18n(config?.language || 'ru-RU')
  mount(App, { target: document.getElementById('app')! })
}
start()
