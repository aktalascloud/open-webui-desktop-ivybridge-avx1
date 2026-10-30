import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { handleGuestSend, isGuestLoadPage, isGuestPushType, canRelayDesktopEvent } from '../src/renderer/src/lib/guest-protocol.ts'
import { secureGuestWebPreferences, isConfiguredConnectionURL, isConfiguredCertificateHost } from '../src/main/guest-webview.ts'

test('untrusted guest cannot call privileged APIs, read config, replace preload or widen TLS trust', async () => {
  const calls = []
  const api = {
    setAuthToken: async token => calls.push(token),
    getAppInfo: async () => ({version:'fixture',platform:'win32',arch:'x64',username:'private',apiKey:'private'}),
    isWindowFocused: async () => ({isFocused:true}),
    resetApp: () => { throw Error('Privileged API must never run') }
  }
  for (const type of ['resetApp','setConfig','__proto__','constructor','startServer']) {
    assert.equal(await handleGuestSend({type}, api), undefined)
  }
  assert.equal(await handleGuestSend(null, api), undefined)
  assert.equal(await handleGuestSend({type:'app:data'}, api), null)
  assert.deepEqual(await handleGuestSend({type:'app:info'}, api), {version:'fixture',platform:'win32',arch:'x64'})
  await handleGuestSend({type:'token:update',token:'valid-fixture'}, api)
  for (const token of ['',4,'x'.repeat(16385)]) await handleGuestSend({type:'token:update',token}, api)
  assert.deepEqual(calls,['valid-fixture'])
  assert.equal(isGuestLoadPage('settings'),true)
  assert.equal(isGuestLoadPage('../../private'),false)
  const preferences={nodeIntegration:true,sandbox:false,preload:'/evil/preload/content-preload.js'}
  assert.equal(secureGuestWebPreferences(preferences,'https://configured.invalid/','/owned/content-preload.js'),true)
  assert.equal(preferences.preload,'/owned/content-preload.js')
  assert.equal(preferences.nodeIntegration,false)
  assert.equal(preferences.nodeIntegrationInSubFrames,false)
  assert.equal(preferences.sandbox,true)
  assert.equal(preferences.contextIsolation,true)
  for (const url of ['file:///private','javascript:alert(1)','https://user:pass@configured.invalid']) {
    assert.equal(secureGuestWebPreferences({},url,'/owned/content-preload.js'),false)
  }
  const configured=['https://configured.invalid:8443/path']
  assert.equal(isConfiguredConnectionURL('https://configured.invalid:8443/chat',configured),true)
  for (const url of ['https://configured.invalid:443/','https://other.invalid/','file:///private']) {
    assert.equal(isConfiguredConnectionURL(url,configured),false)
  }
  assert.equal(isConfiguredCertificateHost('configured.invalid',configured),true)
  assert.equal(isConfiguredCertificateHost('other.invalid',configured),false)
  assert.equal(isConfiguredConnectionURL('http://127.0.0.1:8080/',configured),true)
})

test('actual outbound relay never broadcasts local credentials or delivers them after redirect', () => {
  const source = fs.readFileSync(new URL('../src/renderer/src/lib/components/Main/Connections.svelte', import.meta.url), 'utf8')
  const start = source.indexOf('  const sendToWebview = ')
  const end = source.indexOf('\n  // Listen for events from main process', start)
  assert.ok(start >= 0 && end > start)
  const body = stripTypeScriptTypes(source.slice(start, end))
  const sent = []
  let address = 'about:blank', partition = 'persist:connection-local', ready
  const view = {getURL:()=>address,getAttribute:()=>partition,send:(_channel,event)=>sent.push(event),
    addEventListener:(_event,callback)=>{ready=callback},removeEventListener:()=>{}}
  const document = {querySelector:()=>({querySelectorAll:()=>[view],querySelector:()=>view})}
  const send = new Function('document','localConn','isGuestPushType','canRelayDesktopEvent',body+';return sendToWebview;')(
    document,{url:'http://127.0.0.1:8080'},isGuestPushType,canRelayDesktopEvent)
  const secret = {type:'connections:terminal',data:{key:'fixture-private-key'}}
  send(secret)
  assert.equal(sent.length,0)
  address = 'https://other.invalid/'
  ready()
  assert.equal(sent.length,0)
  partition = 'persist:connection-remote'
  send(secret)
  assert.equal(sent.length,0)
  partition = 'persist:connection-local';address = 'http://127.0.0.1:8080/'
  send(secret)
  assert.deepEqual(sent,[secret])
  send({type:'error',data:{message:'private machine path'}})
  assert.equal(sent.length,1)
  assert.equal(canRelayDesktopEvent('connections:terminal','https://other.invalid','https://other.invalid',false),false)
  assert.equal(canRelayDesktopEvent('query','https://other.invalid',undefined,false),false)
  assert.equal(canRelayDesktopEvent('query','https://other.invalid',undefined,true),true)
})
