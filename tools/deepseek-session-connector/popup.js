const PREFIX = 'c2a-ds-link-v1.'
const codeInput = document.querySelector('#connector-code')
const readClipboardButton = document.querySelector('#read-clipboard')
const startButton = document.querySelector('#start-connection')
const preview = document.querySelector('#gateway-preview')
const gatewayHost = document.querySelector('#gateway-host')
const gatewayExpiry = document.querySelector('#gateway-expiry')
const statusCard = document.querySelector('#status-card')
const statusTitle = document.querySelector('#status-title')
const statusMessage = document.querySelector('#status-message')
const activeActions = document.querySelector('#active-actions')
const openDeepSeekButton = document.querySelector('#open-deepseek')
const cancelButton = document.querySelector('#cancel-connection')
let candidate = null

function decodeConnectorCode(value) {
  const normalized = value.trim()
  if (!normalized.startsWith(PREFIX)) throw new Error('Bağlantı kodu biçimi geçersiz.')
  const encoded = normalized.slice(PREFIX.length).replace(/-/g, '+').replace(/_/g, '/')
  const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
  const payload = JSON.parse(new TextDecoder().decode(bytes))
  if (
    payload?.v !== 1
    || typeof payload.endpoint !== 'string'
    || typeof payload.sessionId !== 'string'
    || typeof payload.secret !== 'string'
    || typeof payload.expiresAt !== 'number'
  ) {
    throw new Error('Bağlantı kodu eksik veya geçersiz.')
  }
  const endpoint = new URL(payload.endpoint)
  const localDevelopment = endpoint.protocol === 'http:'
    && ['localhost', '127.0.0.1'].includes(endpoint.hostname)
  if (
    (!localDevelopment && endpoint.protocol !== 'https:')
    || endpoint.username
    || endpoint.password
    || endpoint.pathname !== '/admin/api/deepseek-link/complete'
    || endpoint.search
    || endpoint.hash
    || !/^[0-9a-f-]{36}$/i.test(payload.sessionId)
    || payload.secret.length < 32
    || payload.expiresAt <= Date.now()
    || payload.expiresAt > Date.now() + 10 * 60_000
  ) {
    throw new Error('Bağlantı kodu güvenlik doğrulamasından geçmedi.')
  }
  return payload
}

function updateCandidate() {
  candidate = null
  preview.hidden = true
  startButton.disabled = true
  const value = codeInput.value.trim()
  if (!value) return
  try {
    candidate = decodeConnectorCode(value)
    const endpoint = new URL(candidate.endpoint)
    gatewayHost.textContent = endpoint.host
    gatewayExpiry.textContent = `Kod ${new Date(candidate.expiresAt).toLocaleTimeString('tr-TR', {
      hour: '2-digit',
      minute: '2-digit',
    })} saatine kadar geçerli.`
    preview.hidden = false
    startButton.disabled = false
    setStatus('ready', 'Gateway’i doğrulayın', 'Bağlantı yalnız yukarıdaki sunucuya gönderilecek.')
  } catch (error) {
    setStatus('error', 'Kod doğrulanamadı', error instanceof Error ? error.message : 'Kod geçersiz.')
  }
}

function setStatus(state, title, message) {
  statusCard.dataset.state = state
  statusTitle.textContent = title
  statusMessage.textContent = message
}

async function refreshStatus() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_STATUS' })
  const status = response?.status
  activeActions.hidden = !response?.pending
  if (!status) return
  if (status.state === 'complete') {
    setStatus('complete', 'Hesap bağlandı', status.message)
    document.querySelector('#code-step').hidden = true
    preview.hidden = true
    startButton.hidden = true
    return
  }
  if (status.state === 'waiting') {
    setStatus('waiting', 'DeepSeek girişi bekleniyor', status.message)
    return
  }
  if (status.state === 'error' || status.state === 'expired') {
    setStatus('error', status.state === 'expired' ? 'Kodun süresi doldu' : 'Bağlantı kurulamadı', status.message)
  }
}

readClipboardButton.addEventListener('click', async () => {
  try {
    codeInput.value = await navigator.clipboard.readText()
    updateCandidate()
  } catch {
    setStatus('error', 'Pano okunamadı', 'Kodu alana yapıştırıp tekrar deneyin.')
    codeInput.focus()
  }
})

codeInput.addEventListener('input', updateCandidate)

startButton.addEventListener('click', async () => {
  if (!candidate) return
  const response = await chrome.runtime.sendMessage({
    type: 'START_PAIRING',
    payload: candidate,
  })
  if (!response?.ok) {
    setStatus('error', 'Bağlantı başlatılamadı', response?.message || 'Tekrar deneyin.')
    return
  }
  setStatus('waiting', 'DeepSeek girişi bekleniyor', 'Giriş tamamlandığında oturum otomatik doğrulanacak.')
  activeActions.hidden = false
})

openDeepSeekButton.addEventListener('click', () => {
  void chrome.tabs.create({ url: 'https://chat.deepseek.com/', active: true })
})

cancelButton.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CANCEL_PAIRING' })
  activeActions.hidden = true
  setStatus('idle', 'Bağlantı iptal edildi', 'Admin panelinden yeni bir kod oluşturabilirsiniz.')
})

void refreshStatus()
window.setInterval(() => void refreshStatus(), 1000)
