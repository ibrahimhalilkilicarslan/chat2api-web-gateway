const PENDING_KEY = 'pendingDeepSeekLink'
const STATUS_KEY = 'deepSeekLinkStatus'
const DEEPSEEK_ORIGIN = 'https://chat.deepseek.com'
const checksInFlight = new Set()

function isValidPayload(payload) {
  if (!payload || payload.v !== 1) return false
  if (typeof payload.sessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(payload.sessionId)) return false
  if (typeof payload.secret !== 'string' || payload.secret.length < 32 || payload.secret.length > 512) return false
  if (typeof payload.expiresAt !== 'number' || payload.expiresAt <= Date.now()) return false
  if (payload.expiresAt > Date.now() + 10 * 60_000) return false
  if (typeof payload.endpoint !== 'string') return false
  try {
    const endpoint = new URL(payload.endpoint)
    const localDevelopment = endpoint.protocol === 'http:'
      && ['localhost', '127.0.0.1'].includes(endpoint.hostname)
    return (
      (endpoint.protocol === 'https:' || localDevelopment)
      && endpoint.username === ''
      && endpoint.password === ''
      && endpoint.pathname === '/admin/api/deepseek-link/complete'
      && endpoint.search === ''
      && endpoint.hash === ''
    )
  } catch {
    return false
  }
}

async function setStatus(status) {
  await chrome.storage.session.set({
    [STATUS_KEY]: {
      ...status,
      updatedAt: Date.now(),
    },
  })
}

async function completePairingInDeepSeekPage(payload) {
  const token = globalThis.localStorage?.getItem('userToken')?.trim()
  if (!token) return { state: 'waiting' }

  try {
    const response = await fetch(payload.endpoint, {
      method: 'POST',
      body: JSON.stringify({
        sessionId: payload.sessionId,
        secret: payload.secret,
        token,
      }),
      cache: 'no-store',
      credentials: 'omit',
      headers: {
        'Content-Type': 'text/plain;charset=UTF-8',
      },
      referrerPolicy: 'no-referrer',
    })
    const result = await response.json().catch(() => ({}))
    if (response.ok && result?.status === 'complete') {
      return { state: 'complete' }
    }
    return {
      state: response.status === 409 ? 'busy' : 'error',
      code: result?.error?.code || `http_${response.status}`,
      message: result?.error?.message || 'Oturum doğrulanamadı.',
    }
  } catch {
    return {
      state: 'error',
      code: 'connector_network_error',
      message: 'Gateway bağlantısı kurulamadı.',
    }
  }
}

async function runSessionCheck(tabId, tabUrl) {
  if (checksInFlight.has(tabId) || !tabUrl?.startsWith(`${DEEPSEEK_ORIGIN}/`)) return false
  const stored = await chrome.storage.session.get(PENDING_KEY)
  const pending = stored[PENDING_KEY]
  if (!isValidPayload(pending)) {
    if (pending) {
      await chrome.storage.session.remove(PENDING_KEY)
      await setStatus({
        state: 'expired',
        message: 'Bağlantı kodunun süresi doldu. Admin panelinden yenisini oluşturun.',
      })
    }
    return false
  }

  checksInFlight.add(tabId)
  try {
    const execution = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: completePairingInDeepSeekPage,
      args: [pending],
    })
    const result = execution[0]?.result
    if (!result || result.state === 'waiting' || result.state === 'busy') return true
    if (result.state === 'complete') {
      await chrome.storage.session.remove(PENDING_KEY)
      await setStatus({
        state: 'complete',
        host: new URL(pending.endpoint).host,
        message: 'DeepSeek oturumu doğrulandı ve gateway hesabı oluşturuldu.',
      })
      return false
    }

    await chrome.storage.session.remove(PENDING_KEY)
    await setStatus({
      state: 'error',
      code: result.code,
      host: new URL(pending.endpoint).host,
      message: result.message || 'DeepSeek oturumu doğrulanamadı.',
    })
    return false
  } finally {
    checksInFlight.delete(tabId)
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void (async () => {
    if (message?.type === 'START_PAIRING') {
      if (!isValidPayload(message.payload)) {
        sendResponse({ ok: false, message: 'Bağlantı kodu geçersiz veya süresi dolmuş.' })
        return
      }
      await chrome.storage.session.set({ [PENDING_KEY]: message.payload })
      await setStatus({
        state: 'waiting',
        host: new URL(message.payload.endpoint).host,
        message: 'DeepSeek girişi bekleniyor.',
      })
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
      const tab = activeTab?.url?.startsWith(`${DEEPSEEK_ORIGIN}/`)
        ? activeTab
        : await chrome.tabs.create({ url: `${DEEPSEEK_ORIGIN}/`, active: true })
      if (tab.id && tab.url?.startsWith(`${DEEPSEEK_ORIGIN}/`)) {
        void runSessionCheck(tab.id, tab.url)
      }
      sendResponse({ ok: true, tabId: tab.id })
      return
    }

    if (message?.type === 'CHECK_DEEPSEEK_SESSION') {
      const active = sender.tab?.id
        ? await runSessionCheck(sender.tab.id, sender.tab.url)
        : false
      sendResponse({ ok: true, active })
      return
    }

    if (message?.type === 'GET_STATUS') {
      const stored = await chrome.storage.session.get([PENDING_KEY, STATUS_KEY])
      sendResponse({
        ok: true,
        pending: Boolean(stored[PENDING_KEY]),
        status: stored[STATUS_KEY] || null,
      })
      return
    }

    if (message?.type === 'CANCEL_PAIRING') {
      await chrome.storage.session.remove(PENDING_KEY)
      await setStatus({ state: 'idle', message: 'Bağlantı iptal edildi.' })
      sendResponse({ ok: true })
      return
    }

    sendResponse({ ok: false, message: 'Desteklenmeyen işlem.' })
  })().catch(() => sendResponse({ ok: false, message: 'İşlem tamamlanamadı.' }))
  return true
})
