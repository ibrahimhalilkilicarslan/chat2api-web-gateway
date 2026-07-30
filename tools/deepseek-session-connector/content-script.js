const CHECK_INTERVAL_MS = 1500
let checkTimer

async function requestSessionCheck() {
  window.clearTimeout(checkTimer)
  const response = await chrome.runtime
    .sendMessage({ type: 'CHECK_DEEPSEEK_SESSION' })
    .catch(() => ({ active: false }))
  if (response?.active) {
    checkTimer = window.setTimeout(() => void requestSessionCheck(), CHECK_INTERVAL_MS)
  }
}

void requestSessionCheck()
window.addEventListener('storage', () => void requestSessionCheck())
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void requestSessionCheck()
})
window.addEventListener('pagehide', () => window.clearTimeout(checkTimer), { once: true })
