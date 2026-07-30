import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleGauge,
  Clock3,
  Command,
  Copy,
  DownloadCloud,
  Database,
  Download,
  Eye,
  EyeOff,
  Filter,
  Gauge,
  KeyRound,
  Layers3,
  LockKeyhole,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Trash2,
  X,
  Zap,
} from 'lucide-react'
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import {
  ApiError,
  cancelDeepSeekLink,
  createAccount,
  createApiKey,
  deleteAccount,
  deleteApiKey,
  getSession,
  getDeepSeekLink,
  loadDashboard,
  login,
  logout,
  downloadAuditCsv,
  rotateApiKey,
  startDeepSeekLink,
  testAccount,
  updateAccount,
  updateApiKey,
  updateSettings,
  validateAccountCredentials,
} from './api'
import type {
  Account,
  AccountHealthResult,
  ApiKeyRecord,
  AuditEvent,
  DashboardData,
  DeepSeekLinkSession,
  GatewaySettings,
  Provider,
  RequestActivity,
} from './types'

type View = 'overview' | 'providers' | 'keys' | 'activity' | 'security'

interface Confirmation {
  title: string
  description: string
  confirmLabel: string
  tone?: 'danger' | 'default'
  action: () => Promise<void>
}

const navigation: Array<{
  id: View
  label: string
  shortLabel: string
  description: string
  icon: typeof CircleGauge
}> = [
  {
    id: 'overview',
    label: 'Genel bakış',
    shortLabel: 'Özet',
    description: 'Sağlık ve kapasite',
    icon: CircleGauge,
  },
  {
    id: 'providers',
    label: 'DeepSeek hesapları',
    shortLabel: 'Hesaplar',
    description: 'Oturum ve kota yönetimi',
    icon: Layers3,
  },
  {
    id: 'keys',
    label: 'API anahtarları',
    shortLabel: 'Anahtarlar',
    description: 'İstemci erişim politikaları',
    icon: KeyRound,
  },
  {
    id: 'activity',
    label: 'İstek aktivitesi',
    shortLabel: 'Aktivite',
    description: 'Metadata ve performans',
    icon: Activity,
  },
  {
    id: 'security',
    label: 'Güvenlik',
    shortLabel: 'Güvenlik',
    description: 'Sınırlar ve audit kayıtları',
    icon: ShieldCheck,
  },
]

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  const [sessionExpiresAt, setSessionExpiresAt] = useState<number | undefined>()
  const [data, setData] = useState<DashboardData | null>(null)
  const [view, setView] = useState<View>(readViewFromHash)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => window.localStorage.getItem('c2a-sidebar-collapsed') === 'true',
  )
  const [autoRefresh, setAutoRefresh] = useState(
    () => window.localStorage.getItem('c2a-auto-refresh') !== 'false',
  )
  const [lastSyncedAt, setLastSyncedAt] = useState<number>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [accountProvider, setAccountProvider] = useState<Provider | null>(null)
  const [editingAccount, setEditingAccount] = useState<Account | null>(null)
  const [keyPanel, setKeyPanel] = useState(false)
  const [editingKey, setEditingKey] = useState<ApiKeyRecord | null>(null)
  const [rotatingKey, setRotatingKey] = useState<ApiKeyRecord | null>(null)
  const [revealedKey, setRevealedKey] = useState<string | null>(null)
  const [commandOpen, setCommandOpen] = useState(false)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)

  const refresh = async (silent = false) => {
    if (!silent) setBusy(true)
    try {
      setData(await loadDashboard())
      setLastSyncedAt(Date.now())
      setError(null)
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        setAuthenticated(false)
      } else if (!silent) {
        setError(cause instanceof Error ? cause.message : 'Veriler alınamadı.')
      }
    } finally {
      if (!silent) setBusy(false)
    }
  }

  useEffect(() => {
    void getSession().then((session) => {
      setAuthenticated(session.authenticated)
      setSessionExpiresAt(session.expiresAt)
      if (session.authenticated) void refresh()
    })
  }, [])

  useEffect(() => {
    const onHashChange = () => setView(readViewFromHash())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    if (!authenticated || !autoRefresh) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh(true)
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [authenticated, autoRefresh])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandOpen((current) => !current)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 4500)
    return () => window.clearTimeout(timer)
  }, [notice])

  const selectView = (nextView: View) => {
    window.location.hash = nextView
    setView(nextView)
    setSidebarOpen(false)
    setCommandOpen(false)
  }

  const setCollapsed = (collapsed: boolean) => {
    setSidebarCollapsed(collapsed)
    window.localStorage.setItem('c2a-sidebar-collapsed', String(collapsed))
  }

  const setRefreshPolicy = (enabled: boolean) => {
    setAutoRefresh(enabled)
    window.localStorage.setItem('c2a-auto-refresh', String(enabled))
  }

  const run = async (operation: () => Promise<unknown>, message: string) => {
    setBusy(true)
    setError(null)
    try {
      await operation()
      setNotice(message)
      await refresh(true)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'İşlem tamamlanamadı.')
      return false
    } finally {
      setBusy(false)
    }
  }

  const askConfirmation = (next: Confirmation) => setConfirmation(next)

  if (authenticated === null) return <LoadingScreen />
  if (!authenticated) {
    return (
      <LoginScreen
        onAuthenticated={() => {
          setAuthenticated(true)
          void getSession().then((session) => setSessionExpiresAt(session.expiresAt))
          void refresh()
        }}
      />
    )
  }

  const activeNavigation = navigation.find((item) => item.id === view) ?? navigation[0]!
  const editingProvider = editingAccount
    ? data?.providers.find((provider) => provider.id === editingAccount.providerId)
    : undefined
  const gatewayState = deriveGatewayState(data)

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-is-collapsed' : ''}`}>
      <aside className={`sidebar ${sidebarOpen ? 'is-open' : ''}`}>
        <div className="brand">
          <div className="brand-mark"><Server size={20} /></div>
          <div className="brand-copy">
            <strong>Chat2API</strong>
            <span>Web Gateway</span>
          </div>
          <button
            className="icon-button sidebar-close"
            onClick={() => setSidebarOpen(false)}
            aria-label="Menüyü kapat"
          >
            <X size={19} />
          </button>
        </div>

        <nav aria-label="Yönetim menüsü">
          {navigation.map((item) => {
            const badge = getNavigationBadge(item.id, data)
            return (
              <button
                key={item.id}
                className={view === item.id ? 'active' : ''}
                onClick={() => selectView(item.id)}
                title={sidebarCollapsed ? item.label : undefined}
              >
                <span className="nav-icon"><item.icon size={18} /></span>
                <span className="nav-copy">
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </span>
                {badge && <span className={`nav-badge ${badge.tone}`}>{badge.value}</span>}
                {view === item.id && <ChevronRight size={16} className="nav-arrow" />}
              </button>
            )
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-security">
            <LockKeyhole size={17} />
            <div>
              <strong>İzole çalışma</strong>
              <span>İçerik loglanmaz, sırlar şifrelidir.</span>
            </div>
          </div>
          <button
            className="sidebar-collapse-button"
            onClick={() => setCollapsed(!sidebarCollapsed)}
            aria-label={sidebarCollapsed ? 'Menüyü genişlet' : 'Menüyü daralt'}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
            <span>{sidebarCollapsed ? 'Genişlet' : 'Menüyü daralt'}</span>
          </button>
        </div>
      </aside>

      {sidebarOpen && (
        <button
          className="sidebar-backdrop"
          aria-label="Menüyü kapat"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <main>
        <header className="topbar">
          <button
            className="icon-button menu-button"
            onClick={() => setSidebarOpen(true)}
            aria-label="Menüyü aç"
          >
            <Menu size={20} />
          </button>
          <div className="topbar-title">
            <p className="eyebrow">Control plane / {activeNavigation.shortLabel}</p>
            <h1>{activeNavigation.label}</h1>
          </div>
          <div className="topbar-actions">
            <button className="command-trigger" onClick={() => setCommandOpen(true)}>
              <Search size={16} />
              <span>Hızlı erişim</span>
              <kbd>⌘ K</kbd>
            </button>
            <span className={`live-status ${gatewayState.tone}`}>
              <i /> {gatewayState.shortLabel}
            </span>
            <button
              className="icon-button"
              onClick={() => void refresh()}
              disabled={busy}
              aria-label="Yenile"
              title={lastSyncedAt ? `Son güncelleme ${formatRelativeTime(lastSyncedAt)}` : 'Yenile'}
            >
              <RefreshCw size={18} className={busy ? 'spin' : ''} />
            </button>
            <button
              className="icon-button"
              onClick={() => void logout().finally(() => setAuthenticated(false))}
              aria-label="Çıkış yap"
              title="Çıkış yap"
            >
              <LogOut size={18} />
            </button>
          </div>
        </header>

        <div className="content">
          <div className="sync-row">
            <span>
              {lastSyncedAt ? `Son güncelleme ${formatRelativeTime(lastSyncedAt)}` : 'Veriler hazırlanıyor'}
            </span>
            <label className="refresh-toggle">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(event) => setRefreshPolicy(event.target.checked)}
              />
              <span>30 sn otomatik yenile</span>
            </label>
          </div>

          <div className="toast-region" aria-live="polite">
            {error && <Banner tone="danger" onClose={() => setError(null)}>{error}</Banner>}
            {notice && <Banner tone="success" onClose={() => setNotice(null)}>{notice}</Banner>}
          </div>

          {!data ? <PageSkeleton /> : (
            <div className="page-enter" key={view}>
              {view === 'overview' && (
                <OverviewPage
                  data={data}
                  gatewayState={gatewayState}
                  onNavigate={selectView}
                  onAddAccount={() => setAccountProvider(data.providers[0] ?? null)}
                  onCreateKey={() => setKeyPanel(true)}
                />
              )}
              {view === 'providers' && (
                <ProvidersPage
                  providers={data.providers}
                  accounts={data.accounts}
                  onAdd={setAccountProvider}
                  onAccountToggle={(account) => run(
                    () => updateAccount(account.id, {
                      status: account.status === 'active' ? 'inactive' : 'active',
                    }),
                    'Hesap durumu güncellendi.',
                  )}
                  onAccountEdit={setEditingAccount}
                  onAccountTest={async (account) => {
                    setBusy(true)
                    setError(null)
                    try {
                      const health = await testAccount(account.id)
                      setNotice(`${account.name}: ${health.message} (${health.latencyMs} ms)`)
                      await refresh(true)
                    } catch (cause) {
                      setError(cause instanceof Error ? cause.message : 'Bağlantı testi tamamlanamadı.')
                    } finally {
                      setBusy(false)
                    }
                  }}
                  onAccountDelete={(account) => askConfirmation({
                    title: 'Hesabı sil',
                    description: `${account.name} hesabı ve şifreli oturum bilgisi kalıcı olarak silinecek.`,
                    confirmLabel: 'Hesabı sil',
                    tone: 'danger',
                    action: async () => {
                      await run(() => deleteAccount(account.id), 'Hesap silindi.')
                    },
                  })}
                />
              )}
              {view === 'keys' && (
                <ApiKeysPage
                  records={data.apiKeys}
                  onCreate={() => setKeyPanel(true)}
                  onToggle={(record) => run(
                    () => updateApiKey(record.id, { enabled: !record.enabled }),
                    'API anahtarı güncellendi.',
                  )}
                  onEdit={setEditingKey}
                  onRotate={setRotatingKey}
                  onDelete={(record) => askConfirmation({
                    title: 'API anahtarını sil',
                    description: `${record.name} anahtarını kullanan istemciler anında erişimi kaybedecek.`,
                    confirmLabel: 'Anahtarı sil',
                    tone: 'danger',
                    action: async () => {
                      await run(() => deleteApiKey(record.id), 'API anahtarı silindi.')
                    },
                  })}
                />
              )}
              {view === 'activity' && (
                <ActivityPage
                  records={data.activity}
                  accounts={data.accounts}
                  metrics={data.overview.requests}
                />
              )}
              {view === 'security' && (
                <SecurityPage
                  settings={data.settings}
                  audit={data.audit}
                  maintenance={data.maintenance}
                  sessionExpiresAt={sessionExpiresAt}
                  onSave={(settings) => run(
                    () => updateSettings(settings),
                    'Gateway ayarları kaydedildi.',
                  )}
                  onExportAudit={() => run(
                    downloadAuditCsv,
                    'Audit CSV indirildi.',
                  )}
                />
              )}
            </div>
          )}
        </div>
      </main>

      <MobileNavigation activeView={view} onSelect={selectView} />

      {accountProvider && (
        <AccountPanel
          provider={accountProvider}
          busy={busy}
          onClose={() => setAccountProvider(null)}
          onLinked={async () => {
            setNotice(`${accountProvider.name} hesabı güvenli bağlantıyla eklendi.`)
            await refresh(true)
            setAccountProvider(null)
          }}
          onSubmit={async (input) => {
            const completed = await run(
              () => createAccount({ ...input, dailyLimit: input.dailyLimit ?? undefined }),
              `${accountProvider.name} hesabı eklendi.`,
            )
            if (completed) setAccountProvider(null)
          }}
        />
      )}
      {editingAccount && editingProvider && (
        <AccountPanel
          provider={editingProvider}
          account={editingAccount}
          busy={busy}
          onClose={() => setEditingAccount(null)}
          onLinked={async () => {
            await refresh(true)
            setEditingAccount(null)
          }}
          onSubmit={async (input) => {
            const completed = await run(
              () => updateAccount(editingAccount.id, {
                name: input.name,
                email: input.email,
                dailyLimit: input.dailyLimit,
                credentials: Object.keys(input.credentials).length > 0
                  ? input.credentials
                  : undefined,
              }),
              `${editingAccount.name} hesabı güncellendi.`,
            )
            if (completed) setEditingAccount(null)
          }}
        />
      )}
      {keyPanel && (
        <ApiKeyPanel
          busy={busy}
          providers={data?.providers ?? []}
          onClose={() => setKeyPanel(false)}
          onSubmit={async (input) => {
            setBusy(true)
            setError(null)
            try {
              const created = await createApiKey(input)
              setRevealedKey(created.rawKey)
              setKeyPanel(false)
              await refresh(true)
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : 'API anahtarı oluşturulamadı.')
            } finally {
              setBusy(false)
            }
          }}
        />
      )}
      {rotatingKey && (
        <ApiKeyRotationPanel
          record={rotatingKey}
          busy={busy}
          onClose={() => setRotatingKey(null)}
          onSubmit={async (input) => {
            setBusy(true)
            setError(null)
            try {
              const created = await rotateApiKey(rotatingKey.id, input)
              setRevealedKey(created.rawKey)
              setRotatingKey(null)
              await refresh(true)
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : 'API anahtarı döndürülemedi.')
            } finally {
              setBusy(false)
            }
          }}
        />
      )}
      {editingKey && data && (
        <ApiKeyPolicyPanel
          record={editingKey}
          providers={data.providers}
          busy={busy}
          onClose={() => setEditingKey(null)}
          onSubmit={async (input) => {
            setBusy(true)
            setError(null)
            try {
              await updateApiKey(editingKey.id, input)
              setEditingKey(null)
              await refresh(true)
              setNotice('API anahtarı politikası güncellendi.')
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : 'API anahtarı güncellenemedi.')
            } finally {
              setBusy(false)
            }
          }}
        />
      )}
      {revealedKey && <OneTimeKey value={revealedKey} onClose={() => setRevealedKey(null)} />}
      {confirmation && (
        <ConfirmDialog
          confirmation={confirmation}
          busy={busy}
          onClose={() => setConfirmation(null)}
          onConfirm={async () => {
            await confirmation.action()
            setConfirmation(null)
          }}
        />
      )}
      {commandOpen && (
        <CommandPalette
          data={data}
          onClose={() => setCommandOpen(false)}
          onNavigate={selectView}
          onRefresh={() => {
            setCommandOpen(false)
            void refresh()
          }}
          onCreateKey={() => {
            setCommandOpen(false)
            setKeyPanel(true)
          }}
          onAddAccount={() => {
            setCommandOpen(false)
            setAccountProvider(data?.providers[0] ?? null)
          }}
        />
      )}
    </div>
  )
}

function LoginScreen({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await login(token)
      setToken('')
      onAuthenticated()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Giriş yapılamadı.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-grid" aria-hidden="true" />
      <div className="login-orb login-orb-one" aria-hidden="true" />
      <div className="login-orb login-orb-two" aria-hidden="true" />
      <section className="login-story">
        <div className="login-brand">
          <div className="brand-mark large"><Server size={25} /></div>
          <div><strong>Chat2API</strong><span>DeepSeek Web Gateway</span></div>
        </div>
        <p className="eyebrow">Private control plane</p>
        <h1>Yapay zekâ erişimini tek bir güvenli yüzeyden yönetin.</h1>
        <p>Hesap sağlığını, istemci anahtarlarını ve istek performansını içerik kaydetmeden izleyin.</p>
        <div className="login-assurances">
          <span><CheckCircle2 size={16} /> Credential şifreleme</span>
          <span><CheckCircle2 size={16} /> Metadata-only audit</span>
          <span><CheckCircle2 size={16} /> Fail-closed erişim</span>
        </div>
      </section>
      <section className="login-card">
        <div className="login-card-header">
          <div className="login-icon"><ShieldCheck size={25} /></div>
          <div>
            <p className="eyebrow">Yönetici oturumu</p>
            <h2>Kontrol paneline giriş</h2>
          </div>
        </div>
        <p>Kurulum sırasında üretilen yönetici anahtarını girin.</p>
        <form onSubmit={submit}>
          <Field label="Yönetici erişim anahtarı" error={error || undefined}>
            <div className="input-with-action">
              <input
                id="admin-token"
                type={showToken ? 'text' : 'password'}
                value={token}
                onChange={(event) => setToken(event.target.value)}
                autoComplete="current-password"
                required
                minLength={32}
                placeholder="En az 32 karakter"
                aria-invalid={Boolean(error)}
              />
              <button
                type="button"
                className="input-action"
                onClick={() => setShowToken(!showToken)}
                aria-label={showToken ? 'Anahtarı gizle' : 'Anahtarı göster'}
              >
                {showToken ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
          </Field>
          <button className="primary-button large-button" disabled={busy}>
            {busy ? (
              <><RefreshCw size={17} className="spin" /> Doğrulanıyor</>
            ) : (
              <>Güvenli oturumu aç <ArrowRight size={17} /></>
            )}
          </button>
        </form>
        <div className="login-footnote">
          <LockKeyhole size={14} />
          Oturum çerezi HttpOnly ve SameSite Strict olarak saklanır.
        </div>
      </section>
    </div>
  )
}

function OverviewPage({
  data,
  gatewayState,
  onNavigate,
  onAddAccount,
  onCreateKey,
}: {
  data: DashboardData
  gatewayState: ReturnType<typeof deriveGatewayState>
  onNavigate: (view: View) => void
  onAddAccount: () => void
  onCreateKey: () => void
}) {
  const recent = data.activity.slice(0, 7)
  const readiness = [
    {
      label: 'DeepSeek hesabı',
      detail: 'En az bir aktif web oturumu',
      complete: data.accounts.some((account) => account.status === 'active'),
      action: onAddAccount,
      actionLabel: 'Hesap ekle',
    },
    {
      label: 'Bağlantı kontrolü',
      detail: 'Aktif hesabın credential testi',
      complete: data.accounts.some((account) => account.health?.healthy),
      action: () => onNavigate('providers'),
      actionLabel: 'Kontrol et',
    },
    {
      label: 'İstemci anahtarı',
      detail: 'OpenAI uyumlu erişim anahtarı',
      complete: data.apiKeys.some((record) => record.enabled),
      action: onCreateKey,
      actionLabel: 'Anahtar oluştur',
    },
    {
      label: 'Trafik doğrulaması',
      detail: data.overview.gateway.readiness.status === 'operational'
        ? `Son başarılı istek ${formatRelativeTime(data.overview.gateway.readiness.latestSuccessAt)}`
        : readinessReasonLabel(data.overview.gateway.readiness.reasonCode),
      complete: data.overview.gateway.readiness.status === 'operational',
      action: () => onNavigate('activity'),
      actionLabel: 'Durumu incele',
    },
  ]
  const readinessCount = readiness.filter((item) => item.complete).length
  const endpoint = `${window.location.origin}/v1`

  const metrics = [
    {
      label: 'Aktif hesap',
      value: `${data.overview.accounts.active}/${data.overview.accounts.total}`,
      detail: data.overview.accounts.total === 0
        ? 'Henüz hesap eklenmedi'
        : data.overview.accounts.attention > 0
        ? `${data.overview.accounts.attention} hesap dikkat istiyor`
        : 'Hesap durumu normal',
      icon: Layers3,
      tone: data.overview.accounts.attention > 0 ? 'warning' : 'success',
    },
    {
      label: 'Bugünkü istek',
      value: formatNumber(data.overview.requests.today),
      detail: data.overview.requests.total === 0
        ? 'Henüz trafik yok'
        : `%${Math.round(data.overview.requests.successRate * 100)} başarı oranı`,
      icon: Activity,
      tone: data.overview.requests.successRate >= 0.95 ? 'success' : 'warning',
    },
    {
      label: 'Ortalama gecikme',
      value: formatDuration(data.overview.requests.averageLatency),
      detail: `${formatNumber(data.overview.requests.total)} toplam istek`,
      icon: Gauge,
      tone: 'neutral',
    },
    {
      label: 'Anlık kapasite',
      value: `${data.overview.gateway.active}/${data.overview.gateway.limit}`,
      detail: data.overview.gateway.openCircuits.length > 0
        ? `${data.overview.gateway.openCircuits.length} açık devre`
        : 'Devre kesici normal',
      icon: Server,
      tone: data.overview.gateway.openCircuits.length > 0 ? 'danger' : 'neutral',
    },
  ]

  return (
    <>
      <section className={`hero-panel ${gatewayState.tone}`}>
        <div className="hero-copy">
          <span className={`hero-status ${gatewayState.tone}`}><i /> {gatewayState.label}</span>
          <h2>{gatewayState.headline}</h2>
          <p>{gatewayState.description}</p>
          <div className="hero-actions">
            <button className="primary-button" onClick={() => onNavigate(gatewayState.actionView)}>
              {gatewayState.actionLabel} <ArrowRight size={16} />
            </button>
            <button className="secondary-button" onClick={() => onNavigate('activity')}>
              Aktiviteyi incele
            </button>
          </div>
        </div>
        <div className="readiness-ring" style={{ '--progress': `${readinessCount / readiness.length}` } as React.CSSProperties}>
          <div><strong>{readinessCount}/{readiness.length}</strong><span>hazır</span></div>
        </div>
      </section>

      <div className="metrics-grid">
        {metrics.map((metric, index) => (
          <article className={`metric-card tone-${metric.tone}`} key={metric.label}>
            <div className="metric-top">
              <span>{metric.label}</span>
              <div className="metric-icon"><metric.icon size={19} /></div>
            </div>
            <strong>{metric.value}</strong>
            <small>{metric.detail}</small>
            <MiniBars records={data.activity} offset={index} />
          </article>
        ))}
      </div>

      <div className="overview-grid">
        <section className="panel activity-panel">
          <PanelHeader
            title="Son istekler"
            subtitle="Yalnız performans ve durum metadata’sı"
            action={(
              <button className="text-button" onClick={() => onNavigate('activity')}>
                Tümünü aç <ArrowRight size={15} />
              </button>
            )}
          />
          <ActivityTable records={recent} compact />
        </section>

        <div className="overview-side">
          <section className="panel readiness-panel">
            <PanelHeader
              title="Kurulum durumu"
              subtitle={`${readinessCount} / ${readiness.length} adım tamamlandı`}
            />
            <div className="readiness-list">
              {readiness.map((item) => (
                <div className={item.complete ? 'complete' : ''} key={item.label}>
                  <span className="step-indicator">
                    {item.complete ? <Check size={14} /> : <span />}
                  </span>
                  <div><strong>{item.label}</strong><small>{item.detail}</small></div>
                  {!item.complete && (
                    <button onClick={item.action}>{item.actionLabel}</button>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section className="panel endpoint-panel">
            <div className="endpoint-icon"><Zap size={20} /></div>
            <div>
              <span className="eyebrow">OpenAI-compatible endpoint</span>
              <h3>İstemci bağlantısı hazır</h3>
              <p>Mevcut OpenAI SDK’nızda yalnız base URL ve API anahtarını değiştirin.</p>
            </div>
            <CopyField value={endpoint} label="API base URL" />
          </section>
        </div>
      </div>
    </>
  )
}

function ProvidersPage(props: {
  providers: Provider[]
  accounts: Account[]
  onAdd: (provider: Provider) => void
  onAccountToggle: (account: Account) => void
  onAccountEdit: (account: Account) => void
  onAccountTest: (account: Account) => void
  onAccountDelete: (account: Account) => void
}) {
  const firstProvider = props.providers[0]
  return (
    <>
      <PageIntro
        eyebrow="Provider workspace"
        title="DeepSeek web oturumlarını yönetin"
        description="Hesapları kapasite, sağlık ve günlük kullanım bilgisiyle tek ekranda izleyin."
        action={firstProvider && (
          <button className="primary-button" onClick={() => props.onAdd(firstProvider)}>
            <Plus size={16} /> Hesap ekle
          </button>
        )}
      />
      <div className="provider-grid">
        {props.providers.map((provider) => {
          const accounts = props.accounts.filter((account) => account.providerId === provider.id)
          const activeCount = accounts.filter((account) => account.status === 'active').length
          return (
            <article className="provider-card" key={provider.id}>
              <div className="provider-card-head">
                <ProviderAvatar name={provider.name} />
                <div>
                  <div className="title-line">
                    <h2>{provider.name}</h2>
                    <StatusBadge status={activeCount > 0 ? 'success' : 'warning'}>
                      {activeCount > 0 ? `${activeCount} aktif` : 'Hesap gerekli'}
                    </StatusBadge>
                  </div>
                  <p>{provider.description}</p>
                  <div className="provider-meta">
                    <span><Layers3 size={13} /> {provider.supportedModels.length} model</span>
                    <span><LockKeyhole size={13} /> Web session</span>
                    <span><Activity size={13} /> Sağlık kontrolü</span>
                  </div>
                </div>
              </div>

              <div className="model-chips">
                {provider.supportedModels.map((model) => <span key={model}>{model}</span>)}
              </div>

              <div className="account-list">
                {accounts.length === 0 ? (
                  <div className="empty-state compact-empty">
                    <Database size={23} />
                    <strong>Henüz hesap eklenmedi</strong>
                    <span>İlk DeepSeek web oturumunu şifreli olarak kaydedin.</span>
                    <button className="secondary-button" onClick={() => props.onAdd(provider)}>
                      <Plus size={16} /> İlk hesabı ekle
                    </button>
                  </div>
                ) : accounts.map((account) => {
                  const usagePercent = account.dailyLimit
                    ? Math.min(100, Math.round((account.todayUsed / account.dailyLimit) * 100))
                    : 0
                  return (
                    <div className="account-card" key={account.id}>
                      <div className="account-identity">
                        <span className={`status-orb ${account.health?.healthy ? 'healthy' : account.status}`} />
                        <div>
                          <strong>{account.name}</strong>
                          <span>{account.email || 'E-posta etiketi yok'}</span>
                        </div>
                        <StatusBadge status={accountStatusTone(account)}>
                          {accountStatusLabel(account)}
                        </StatusBadge>
                      </div>

                      <div className="account-stats">
                        <div><span>Bugün</span><strong>{formatNumber(account.todayUsed)}</strong></div>
                        <div><span>Günlük limit</span><strong>{account.dailyLimit ? formatNumber(account.dailyLimit) : 'Sınırsız'}</strong></div>
                        <div><span>Gecikme</span><strong>{account.health ? formatDuration(account.health.latencyMs) : '—'}</strong></div>
                        <div><span>Son kullanım</span><strong>{formatRelativeTime(account.lastUsed)}</strong></div>
                      </div>

                      {account.dailyLimit && (
                        <div className="usage-progress">
                          <div><span>Kota kullanımı</span><strong>%{usagePercent}</strong></div>
                          <i><span style={{ width: `${usagePercent}%` }} /></i>
                        </div>
                      )}

                      {account.cooldownUntil && (
                        <div className="inline-warning">
                          <Clock3 size={15} /> Devre kesici {formatRelativeTime(account.cooldownUntil)} kapanacak.
                        </div>
                      )}
                      {account.errorMessage && (
                        <div className="inline-warning danger">
                          <AlertTriangle size={15} /> {account.errorMessage}
                        </div>
                      )}

                      <div className="account-actions">
                        {provider.healthCheckSupported && (
                          <button className="secondary-button compact" onClick={() => props.onAccountTest(account)}>
                            <Activity size={15} /> Bağlantıyı test et
                          </button>
                        )}
                        <button className="secondary-button compact" onClick={() => props.onAccountToggle(account)}>
                          {account.status === 'active' ? 'Duraklat' : 'Etkinleştir'}
                        </button>
                        <button className="icon-button small" onClick={() => props.onAccountEdit(account)} aria-label="Hesabı düzenle">
                          <Pencil size={15} />
                        </button>
                        <button className="icon-button small danger" onClick={() => props.onAccountDelete(account)} aria-label="Hesabı sil">
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
              {accounts.length > 0 && (
                <button className="secondary-button full" onClick={() => props.onAdd(provider)}>
                  <Plus size={16} /> Başka hesap ekle
                </button>
              )}
            </article>
          )
        })}
      </div>
    </>
  )
}

function ApiKeysPage(props: {
  records: ApiKeyRecord[]
  onCreate: () => void
  onToggle: (record: ApiKeyRecord) => void
  onEdit: (record: ApiKeyRecord) => void
  onRotate: (record: ApiKeyRecord) => void
  onDelete: (record: ApiKeyRecord) => void
}) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'all' | 'active' | 'inactive'>('all')
  const filtered = props.records.filter((record) => {
    const expired = Boolean(record.expiresAt && record.expiresAt <= Date.now())
    const matchesQuery = `${record.name} ${record.keyPrefix}`.toLowerCase().includes(query.toLowerCase())
    const matchesStatus = status === 'all'
      || (status === 'active' && record.enabled && !expired)
      || (status === 'inactive' && (!record.enabled || expired))
    return matchesQuery && matchesStatus
  })

  return (
    <>
      <PageIntro
        eyebrow="Client access"
        title="İstemci erişimini kontrollü dağıtın"
        description="Her entegrasyon için ayrı anahtar, model kapsamı ve kota tanımlayın."
        action={(
          <button className="primary-button" onClick={props.onCreate}>
            <Plus size={16} /> Yeni anahtar
          </button>
        )}
      />
      <section className="panel">
        <div className="toolbar">
          <label className="search-field">
            <Search size={16} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Anahtar adı veya prefix ara"
              aria-label="API anahtarlarında ara"
            />
          </label>
          <SegmentedControl
            value={status}
            options={[
              { value: 'all', label: 'Tümü' },
              { value: 'active', label: 'Aktif' },
              { value: 'inactive', label: 'Kapalı' },
            ]}
            onChange={setStatus}
          />
          <span className="result-count">{filtered.length} kayıt</span>
        </div>

        <div className="key-grid">
          {filtered.map((record) => {
            const quotaPercent = Math.min(100, Math.round((record.todayUsed / record.dailyQuota) * 100))
            const expired = Boolean(record.expiresAt && record.expiresAt <= Date.now())
            const expiresSoon = Boolean(
              record.expiresAt
                && record.expiresAt > Date.now()
                && record.expiresAt <= Date.now() + 7 * 24 * 60 * 60_000,
            )
            const quotaWarning = quotaPercent >= 80
            const statusTone = expired ? 'danger' : record.enabled ? 'success' : 'neutral'
            const statusLabel = expired ? 'Süresi doldu' : record.enabled ? 'Aktif' : 'Kapalı'
            return (
              <article className="key-card" key={record.id}>
                <header>
                  <div className="key-card-icon"><KeyRound size={18} /></div>
                  <div><strong>{record.name}</strong><span>{record.managedByEnvironment ? 'Ortam değişkeni' : 'Panel anahtarı'}</span></div>
                  <StatusBadge status={statusTone}>
                    {statusLabel}
                  </StatusBadge>
                </header>
                <code>{record.keyPrefix}••••••••••••</code>
                <dl>
                  <div><dt>Kapsam</dt><dd>{record.scopes.join(' + ')}</dd></div>
                  <div><dt>Model erişimi</dt><dd>{record.modelAllowlist.length || 'Tümü'}</dd></div>
                  <div><dt>Dakikalık sınır</dt><dd>{formatNumber(record.requestsPerMinute)}</dd></div>
                  <div><dt>Son kullanım</dt><dd>{formatRelativeTime(record.lastUsedAt)}</dd></div>
                  <div><dt>Geçerlilik</dt><dd>{record.expiresAt ? formatAbsoluteDate(record.expiresAt) : 'Süresiz'}</dd></div>
                  <div><dt>IP politikası</dt><dd>{record.allowedCidrs.length > 0 ? `${record.allowedCidrs.length} kural` : 'Tüm IP’ler'}</dd></div>
                </dl>
                {(record.rotatedFromId || record.replacedById) && (
                  <div className="rotation-note">
                    <RefreshCw size={14} />
                    {record.replacedById ? 'Yeni anahtara geçiş süresinde' : 'Rotasyon ile oluşturuldu'}
                  </div>
                )}
                {record.managedByEnvironment && (
                  <div className="inline-warning">
                    <AlertTriangle size={15} /> Ortam anahtarı panelden döndürülemez; yalnız acil yönetim ve bootstrap için kullanın.
                  </div>
                )}
                {expiresSoon && (
                  <div className="inline-warning">
                    <Clock3 size={15} /> Anahtar {formatRelativeTime(record.expiresAt)} sona erecek. İstemci geçişini planlayın.
                  </div>
                )}
                {quotaWarning && (
                  <div className={`inline-warning ${quotaPercent >= 100 ? 'danger' : ''}`}>
                    <Gauge size={15} /> Günlük kotanın %{quotaPercent} kadarı kullanıldı.
                  </div>
                )}
                <div className="usage-progress">
                  <div><span>Bugünkü kullanım / günlük kota</span><strong>{formatNumber(record.todayUsed)} / {formatNumber(record.dailyQuota)}</strong></div>
                  <i><span style={{ width: `${quotaPercent}%` }} /></i>
                </div>
                <small className="lifetime-usage">Toplam {formatNumber(record.usageCount)} doğrulanmış istemci isteği</small>
                {!record.managedByEnvironment && (
                  <footer>
                    <button className="secondary-button compact" onClick={() => props.onToggle(record)}>
                      {record.enabled ? 'Erişimi kapat' : 'Erişimi aç'}
                    </button>
                    <button className="secondary-button compact" onClick={() => props.onEdit(record)}>
                      <Pencil size={14} /> Politikayı düzenle
                    </button>
                    <button className="secondary-button compact" onClick={() => props.onRotate(record)}>
                      <RefreshCw size={14} /> Döndür
                    </button>
                    <button className="icon-button small danger" onClick={() => props.onDelete(record)} aria-label={`${record.name} anahtarını sil`}>
                      <Trash2 size={15} />
                    </button>
                  </footer>
                )}
              </article>
            )
          })}
        </div>
        {filtered.length === 0 && (
          <div className="empty-state">
            <KeyRound size={25} />
            <strong>{props.records.length === 0 ? 'Henüz API anahtarı yok' : 'Eşleşen anahtar bulunamadı'}</strong>
            <span>{props.records.length === 0 ? 'İlk istemci bağlantısı için güvenli bir anahtar oluşturun.' : 'Arama veya filtreyi değiştirin.'}</span>
          </div>
        )}
      </section>
    </>
  )
}

function ActivityPage({
  records,
  accounts,
  metrics,
}: {
  records: RequestActivity[]
  accounts: Account[]
  metrics: DashboardData['overview']['requests']
}) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'all' | RequestActivity['status']>('all')
  const [accountId, setAccountId] = useState('all')
  const accountNames = new Map(accounts.map((account) => [account.id, account.name]))
  const filtered = records.filter((record) => {
    const searchable = `${record.model} ${record.actualModel ?? ''} ${record.requestId} ${record.errorCode ?? ''}`.toLowerCase()
    return searchable.includes(query.toLowerCase())
      && (status === 'all' || record.status === status)
      && (accountId === 'all' || record.accountId === accountId)
  })
  const successCount = records.filter((record) => record.status === 'success').length
  const failureCount = records.filter((record) => record.status === 'error').length
  const busiestAccount = metrics.usageByAccount[0]
  const busiestAccountName = busiestAccount
    ? accountNames.get(busiestAccount.accountId) ?? 'Silinmiş hesap'
    : 'Henüz veri yok'

  return (
    <>
      <PageIntro
        eyebrow="Request telemetry"
        title="İstek sağlığını içerik kaydetmeden izleyin"
        description="Prompt ve yanıtlar saklanmaz; yalnız durum, model, süre ve anonim istek kimliği gösterilir."
      />
      <div className="activity-summary-grid">
        <SummaryCard label="Görüntülenen" value={formatNumber(filtered.length)} icon={Filter} />
        <SummaryCard label="Başarılı" value={formatNumber(successCount)} icon={CheckCircle2} tone="success" />
        <SummaryCard label="P50 gecikme" value={formatDuration(metrics.latencyP50)} icon={Clock3} />
        <SummaryCard label="P95 gecikme" value={formatDuration(metrics.latencyP95)} icon={Gauge} tone={metrics.latencyP95 > 10_000 ? 'danger' : 'neutral'} />
      </div>
      <div className="operations-insight-grid">
        <article>
          <span>Hata dağılımı</span>
          <strong>{failureCount === 0 ? 'Hata kaydı yok' : `${failureCount} başarısız istek`}</strong>
          <div className="insight-tags">
            {metrics.errorsByCode.slice(0, 4).map((entry) => (
              <span key={entry.code}>{entry.code} · {entry.count}</span>
            ))}
            {metrics.errorsByCode.length === 0 && <span>Operasyon normal</span>}
          </div>
        </article>
        <article>
          <span>En yoğun hesap</span>
          <strong>{busiestAccountName}</strong>
          <small>{busiestAccount ? `${formatNumber(busiestAccount.count)} istek` : 'İstek geldikçe hesap dağılımı görünür.'}</small>
        </article>
        <article>
          <span>Maksimum gecikme</span>
          <strong>{formatDuration(metrics.maximumLatency)}</strong>
          <small>{formatNumber(metrics.total)} kayıtlık güvenli metadata örneklemi</small>
        </article>
      </div>
      <section className="panel">
        <div className="activity-chart">
          <div>
            <p className="eyebrow">Son istek örneklemi</p>
            <h2>Gecikme dağılımı</h2>
          </div>
          <ActivityBars records={records.slice(0, 24).reverse()} />
        </div>
        <div className="toolbar activity-toolbar">
          <label className="search-field">
            <Search size={16} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Model, istek ID veya hata kodu ara"
              aria-label="Aktivitede ara"
            />
          </label>
          <select value={accountId} onChange={(event) => setAccountId(event.target.value)} aria-label="Hesaba göre filtrele">
            <option value="all">Tüm hesaplar</option>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </select>
          <SegmentedControl
            value={status}
            options={[
              { value: 'all', label: 'Tümü' },
              { value: 'success', label: 'Başarılı' },
              { value: 'error', label: 'Hatalı' },
              { value: 'pending', label: 'Bekliyor' },
            ]}
            onChange={setStatus}
          />
        </div>
        <ActivityTable records={filtered} accountNames={accountNames} />
      </section>
    </>
  )
}

function SecurityPage({
  settings,
  audit,
  maintenance,
  sessionExpiresAt,
  onSave,
  onExportAudit,
}: {
  settings: GatewaySettings
  audit: AuditEvent[]
  maintenance: DashboardData['maintenance']
  sessionExpiresAt?: number
  onSave: (settings: Pick<GatewaySettings, 'loadBalanceStrategy'>) => void
  onExportAudit: () => void
}) {
  const [strategy, setStrategy] = useState(settings.loadBalanceStrategy)
  const [auditQuery, setAuditQuery] = useState('')
  const [auditOutcome, setAuditOutcome] = useState<'all' | AuditEvent['outcome']>('all')
  const [auditLimit, setAuditLimit] = useState(10)
  const filteredAudit = audit.filter((event) => {
    const searchable = `${event.action} ${auditActionLabel(event.action)} ${event.actor} ${event.targetType ?? ''}`.toLowerCase()
    return searchable.includes(auditQuery.toLowerCase())
      && (auditOutcome === 'all' || event.outcome === auditOutcome)
  })
  const visibleAudit = filteredAudit.slice(0, auditLimit)
  const securityChecks = [
    ['Credential storage', settings.security.credentialEncryption],
    ['API key storage', settings.security.apiKeyStorage],
    ['İstek gövdesi logları', settings.security.requestBodiesLogged ? 'Açık' : 'Kapalı'],
    ['Özel provider', settings.security.customProvidersEnabled ? 'Açık' : 'Kapalı'],
    ['Uzak medya', settings.security.remoteMediaEnabled ? 'Açık' : 'Kapalı'],
    ['Secure cookie', settings.security.secureCookies ? 'Zorunlu' : 'Geliştirme modu'],
  ]

  return (
    <>
      <PageIntro
        eyebrow="Security posture"
        title="Çalışma sınırları açık ve denetlenebilir"
        description="Runtime politikaları, yönlendirme stratejisi ve yönetici işlemleri tek ekranda."
      />
      <div className="security-overview">
        <section className="security-score-card">
          <div className="security-score"><ShieldCheck size={27} /><strong>6/6</strong></div>
          <div><span className="eyebrow">Security baseline</span><h2>Koruma sınırları etkin</h2><p>Credential, API anahtarı ve request metadata politikaları beklenen durumda.</p></div>
        </section>
        <section className="session-card">
          <Clock3 size={22} />
          <div><span>Yönetici oturumu</span><strong>{sessionExpiresAt ? formatTimeUntil(sessionExpiresAt) : 'Etkin'}</strong><small>HttpOnly · SameSite Strict</small></div>
        </section>
      </div>

      <div className="settings-layout">
        <section className="panel">
          <PanelHeader title="Trafik yönlendirme" subtitle="Yeni isteklerin hesap seçim davranışı" />
          <form className="strategy-form" onSubmit={(event) => {
            event.preventDefault()
            onSave({ loadBalanceStrategy: strategy })
          }}>
            {([
              ['round-robin', 'Round robin', 'İstekleri aktif hesaplara sırayla dağıtır.'],
              ['least-used', 'En az kullanılan', 'Günlük kullanımı düşük hesabı tercih eder.'],
              ['failover', 'Sabit öncelik', 'İlk hesabı kullanır, sorun halinde sıradakine geçer.'],
            ] as const).map(([value, label, description]) => (
              <label className={`strategy-option ${strategy === value ? 'selected' : ''}`} key={value}>
                <input
                  type="radio"
                  name="strategy"
                  value={value}
                  checked={strategy === value}
                  onChange={() => setStrategy(value)}
                />
                <span className="strategy-radio"><Check size={14} /></span>
                <span><strong>{label}</strong><small>{description}</small></span>
              </label>
            ))}
            <button className="primary-button" disabled={strategy === settings.loadBalanceStrategy}>
              Değişikliği kaydet
            </button>
          </form>
        </section>

        <section className="panel">
          <PanelHeader title="Runtime sınırları" subtitle="Deploy sırasında kilitlenen güvenlik politikaları" />
          <div className="security-check-grid">
            {securityChecks.map(([label, value]) => (
              <div key={label}>
                <span className="security-check-icon"><Check size={14} /></span>
                <span><small>{label}</small><strong>{value}</strong></span>
              </div>
            ))}
          </div>
          <div className="runtime-facts">
            <div><span>Request timeout</span><strong>{formatDuration(settings.requestTimeout)}</strong></div>
            <div><span>Stream idle</span><strong>{formatDuration(settings.streamIdleTimeout)}</strong></div>
            <div><span>Sağlık kontrolü</span><strong>{settings.accountHealthInterval > 0 ? formatDuration(settings.accountHealthInterval) : 'Kapalı'}</strong></div>
            <div><span>İstek kapsamı</span><strong>{settings.security.supportedInput}</strong></div>
          </div>
        </section>
      </div>

      <section className="panel maintenance-panel">
        <PanelHeader
          title="SQLite bakım durumu"
          subtitle="Veri içeriğini açmadan bütünlük ve depolama sağlığı"
          action={(
            <StatusBadge status={maintenance.integrity === 'ok' ? 'success' : 'danger'}>
              {maintenance.integrity === 'ok' ? 'Integrity OK' : 'Kontrol gerekli'}
            </StatusBadge>
          )}
        />
        <div className="maintenance-grid">
          <div><Database size={18} /><span><small>Veritabanı</small><strong>{formatBytes(maintenance.databaseBytes)}</strong></span></div>
          <div><Activity size={18} /><span><small>WAL dosyası</small><strong>{formatBytes(maintenance.walBytes)}</strong></span></div>
          <div><Layers3 size={18} /><span><small>Şema sürümü</small><strong>v{maintenance.schemaVersion}</strong></span></div>
          <div><ShieldCheck size={18} /><span><small>Journal modu</small><strong>{maintenance.journalMode.toUpperCase()}</strong></span></div>
        </div>
        <p className="maintenance-note">
          {formatNumber(maintenance.pageCount)} sayfa · {formatNumber(maintenance.freelistCount)} boş sayfa · bütünlük son kontrolü {formatRelativeTime(maintenance.integrityCheckedAt)} · içerik ve credential değerleri bu ekrana taşınmaz.
        </p>
      </section>

      <section className="panel audit-panel">
        <PanelHeader
          title="Yönetim audit günlüğü"
          subtitle={`${filteredAudit.length} kayıt · hassas değer içermeyen işlem izi`}
          action={(
            <button className="secondary-button compact" onClick={onExportAudit}>
              <Download size={15} /> CSV indir
            </button>
          )}
        />
        <div className="toolbar audit-toolbar">
          <label className="search-field">
            <Search size={16} />
            <input
              value={auditQuery}
              onChange={(event) => {
                setAuditQuery(event.target.value)
                setAuditLimit(10)
              }}
              placeholder="İşlem, aktör veya hedef ara"
              aria-label="Audit kayıtlarında ara"
            />
          </label>
          <SegmentedControl
            value={auditOutcome}
            options={[
              { value: 'all', label: 'Tümü' },
              { value: 'success', label: 'Başarılı' },
              { value: 'failure', label: 'Başarısız' },
            ]}
            onChange={(value) => {
              setAuditOutcome(value)
              setAuditLimit(10)
            }}
          />
          <span className="result-count">{visibleAudit.length} gösteriliyor</span>
        </div>
        <div className="audit-list">
          {visibleAudit.map((event) => (
            <div key={event.id}>
              <span className={`audit-icon ${event.outcome}`}>
                {event.outcome === 'success' ? <Check size={14} /> : <AlertTriangle size={14} />}
              </span>
              <div>
                <strong>{auditActionLabel(event.action)}</strong>
                <span>{event.actor} · {event.targetType ? `${event.targetType} · ` : ''}{formatRelativeTime(event.timestamp)}</span>
              </div>
              <StatusBadge status={event.outcome === 'success' ? 'success' : 'danger'}>
                {event.outcome === 'success' ? 'Başarılı' : 'Başarısız'}
              </StatusBadge>
            </div>
          ))}
          {filteredAudit.length === 0 && (
            <div className="empty-state compact-empty">
              <ShieldCheck size={23} />
              <strong>{audit.length === 0 ? 'Henüz audit kaydı yok' : 'Filtreyle eşleşen kayıt yok'}</strong>
            </div>
          )}
        </div>
        {visibleAudit.length < filteredAudit.length && (
          <div className="audit-load-more">
            <button className="secondary-button compact" onClick={() => setAuditLimit((current) => current + 10)}>
              10 kayıt daha göster
            </button>
          </div>
        )}
      </section>

      <div className="risk-note wide">
        <AlertTriangle size={19} />
        <p><strong>Web oturumu sınırı</strong> DeepSeek web protokolü resmi API değildir ve haber vermeden değişebilir. Ayrı bir hesap kullanın, credential sağlık kontrollerini izleyin ve bu gateway’i kritik tek sağlayıcı olarak konumlandırmayın.</p>
      </div>
    </>
  )
}

function AccountPanel(props: {
  provider: Provider
  account?: Account
  busy: boolean
  onClose: () => void
  onLinked: () => Promise<void>
  onSubmit: (input: {
    providerId: string
    name: string
    email?: string
    credentials: Record<string, string>
    dailyLimit?: number | null
  }) => Promise<void>
}) {
  const [name, setName] = useState(props.account?.name ?? '')
  const [email, setEmail] = useState(props.account?.email ?? '')
  const [dailyLimit, setDailyLimit] = useState(props.account ? String(props.account.dailyLimit ?? '') : '500')
  const [credentials, setCredentials] = useState<Record<string, string>>({})
  const [validation, setValidation] = useState<AccountHealthResult | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [validating, setValidating] = useState(false)
  const [showCredential, setShowCredential] = useState(false)
  const [providerOpened, setProviderOpened] = useState(false)
  const [connectionMode, setConnectionMode] = useState<'automatic' | 'manual'>(
    props.account ? 'manual' : 'automatic',
  )
  const [linkSession, setLinkSession] = useState<DeepSeekLinkSession | null>(null)
  const [linkStarting, setLinkStarting] = useState(false)
  const [linkCopied, setLinkCopied] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  const linkedReported = useRef(false)
  const isEditing = Boolean(props.account)
  const credentialUpdates = Object.fromEntries(
    Object.entries(credentials).filter(([, value]) => value.trim().length > 0),
  )
  const hasCredentialUpdates = Object.keys(credentialUpdates).length > 0
  const validationRequired = !isEditing || hasCredentialUpdates
  const canSubmit = name.trim().length > 0
    && !props.busy
    && !validating
    && (!validationRequired || validation?.healthy)

  useEffect(() => {
    if (
      !linkSession
      || ['complete', 'cancelled', 'expired'].includes(linkSession.status)
    ) {
      return
    }
    let disposed = false
    const poll = async () => {
      try {
        const current = await getDeepSeekLink(linkSession.id)
        if (disposed) return
        setLinkSession((previous) => ({
          ...current,
          connectorCode: previous?.connectorCode,
          nativeConnectorCode: previous?.nativeConnectorCode,
        }))
        if (current.status === 'complete' && !linkedReported.current) {
          linkedReported.current = true
          await props.onLinked()
        }
      } catch (cause) {
        if (!disposed) {
          setLinkError(cause instanceof Error ? cause.message : 'Bağlantı durumu alınamadı.')
        }
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 1_500)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [linkSession?.id, linkSession?.status, props.onLinked])

  const setCredential = (field: string, value: string) => {
    setCredentials((current) => ({ ...current, [field]: value }))
    if (value.trim()) setProviderOpened(true)
    setValidation(null)
    setValidationError(null)
  }

  const validateCredentials = async () => {
    const requiredMissing = props.provider.credentialFields
      .filter((field) => field.required)
      .some((field) => !credentialUpdates[field.name]?.trim())
    if (requiredMissing) {
      setValidation(null)
      setValidationError('Devam etmek için oturum tokenını girin.')
      return
    }

    setValidating(true)
    setValidation(null)
    setValidationError(null)
    try {
      const result = await validateAccountCredentials({
        providerId: props.provider.id,
        credentials: credentialUpdates,
      })
      setValidation(result)
    } catch (cause) {
      setValidationError(cause instanceof Error ? cause.message : 'Bağlantı doğrulanamadı.')
    } finally {
      setValidating(false)
    }
  }

  const copyConnectorCode = async (value = linkSession?.nativeConnectorCode) => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setLinkCopied(true)
      setLinkError(null)
    } catch {
      setLinkCopied(false)
      setLinkError('Bağlantı kodu panoya alınamadı. Kopyala düğmesini tekrar deneyin.')
    }
  }

  const startAutomaticLink = async () => {
    if (!name.trim()) {
      setLinkError('Önce hesap etiketini girin.')
      return
    }
    setLinkStarting(true)
    setLinkError(null)
    setLinkCopied(false)
    try {
      const started = await startDeepSeekLink({
        name: name.trim(),
        email: email.trim() || undefined,
        dailyLimit: dailyLimit ? Number(dailyLimit) : undefined,
      })
      setLinkSession(started)
      await copyConnectorCode(started.nativeConnectorCode)
      setProviderOpened(true)
    } catch (cause) {
      setLinkError(cause instanceof Error ? cause.message : 'Güvenli bağlantı başlatılamadı.')
    } finally {
      setLinkStarting(false)
    }
  }

  const cancelAutomaticLink = async () => {
    if (linkSession && !['complete', 'cancelled', 'expired'].includes(linkSession.status)) {
      await cancelDeepSeekLink(linkSession.id).catch(() => undefined)
    }
    setLinkSession(null)
    setLinkError(null)
    setLinkCopied(false)
    linkedReported.current = false
  }

  const closePanel = () => {
    if (linkSession && !['complete', 'cancelled', 'expired'].includes(linkSession.status)) {
      void cancelDeepSeekLink(linkSession.id).catch(() => undefined)
    }
    props.onClose()
  }

  return (
    <Modal
      title={isEditing ? 'DeepSeek hesabını düzenle' : 'DeepSeek hesabı ekle'}
      subtitle={isEditing
        ? 'Şifreli değerler gösterilmez. Token değişikliği kaydedilmeden önce yeniden doğrulanır.'
        : 'Portable connector girişi DeepSeek üzerinde açar ve oturumu güvenle doğrular.'}
      onClose={closePanel}
      drawer
    >
      <form className="drawer-form" onSubmit={(event) => {
        event.preventDefault()
        if (connectionMode !== 'manual' || !canSubmit) return
        void props.onSubmit({
          providerId: props.provider.id,
          name,
          email: email || undefined,
          credentials: credentialUpdates,
          dailyLimit: dailyLimit ? Number(dailyLimit) : isEditing ? null : undefined,
        })
      }}>
        {!isEditing && (
          <div className="onboarding-progress" aria-label="Hesap bağlantı adımları">
            <span className={providerOpened ? 'complete' : ''}><i>{providerOpened ? <Check size={13} /> : '1'}</i><strong>Connector hazır</strong></span>
            <span className={linkSession || hasCredentialUpdates ? 'complete' : ''}><i>{linkSession || hasCredentialUpdates ? <Check size={13} /> : '2'}</i><strong>Güvenli aktarım</strong></span>
            <span className={linkSession?.status === 'complete' || validation?.healthy ? 'complete' : ''}><i>{linkSession?.status === 'complete' || validation?.healthy ? <Check size={13} /> : '3'}</i><strong>Doğrulama</strong></span>
          </div>
        )}
        <div className="form-section">
          <div className="form-section-head"><span>01</span><div><strong>Hesap ayarları</strong><small>Bağlantıyı ayırt etmek için operasyon bilgileri</small></div></div>
          <Field label="Hesap etiketi *">
            <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} placeholder="Örn. Ana DeepSeek hesabı" />
          </Field>
          <div className="form-grid">
            <Field label="E-posta" hint="İsteğe bağlı operasyon referansı">
              <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} placeholder="hesap@example.com" />
            </Field>
            <Field label="Günlük istek sınırı" hint={isEditing ? 'Boş değer hesap sınırını kaldırır.' : 'Hesap bazlı güvenli tavan'}>
              <input type="number" min={1} max={1_000_000} value={dailyLimit} onChange={(event) => setDailyLimit(event.target.value)} />
            </Field>
          </div>
        </div>
        {!isEditing && (
          <div className="form-section">
            <div className="form-section-head"><span>02</span><div><strong>Bağlantı yöntemi</strong><small>Otomatik aktarım önerilir; manuel token yedek yöntemdir</small></div></div>
            <SegmentedControl
              value={connectionMode}
              options={[
                { value: 'automatic', label: 'Otomatik bağla' },
                { value: 'manual', label: 'Manuel token' },
              ]}
              onChange={(value) => {
                if (value !== connectionMode) void cancelAutomaticLink()
                setConnectionMode(value)
              }}
            />
          </div>
        )}
        {connectionMode === 'automatic' && !isEditing ? (
          <div className="form-section">
            <div className="form-section-head"><span>03</span><div><strong>DeepSeek ile güvenli bağlantı</strong><small>Parola ve oturum tokenı admin ekranına girilmez</small></div></div>
            <div className="connector-card">
              <div className="connector-card-head">
                <span><PlugZap size={19} /></span>
                <div>
                  <strong>Chat2API Session Connector</strong>
                  <p>Windows, macOS veya Linux uygulaması kurulu tarayıcıyı izole profille açar. Eklenti ve mağaza onayı gerekmez.</p>
                </div>
                <a
                  className="secondary-button compact"
                  href="https://github.com/ibrahimhalilkilicarslan/chat2api-session-connector/releases"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  <DownloadCloud size={14} /> Connector paketleri
                </a>
              </div>
              <details className="connector-install-help">
                <summary>Nasıl bağlanır?</summary>
                <ol>
                  <li>İşletim sisteminize uygun connector paketini bir kez indirin.</li>
                  <li>Aşağıdan beş dakikalık bağlantı kodunu oluşturun; kod panoya alınır.</li>
                  <li>Connector’ı açıp kodu yapıştırın ve gateway adresini doğrulayın.</li>
                  <li>Açılan DeepSeek penceresinde girişi tamamlayın.</li>
                </ol>
              </details>
              {!linkSession ? (
                <button
                  type="button"
                  className="primary-button connector-start"
                  onClick={() => void startAutomaticLink()}
                  disabled={linkStarting || !name.trim()}
                >
                  {linkStarting
                    ? <><RefreshCw size={16} className="spin" /> Bağlantı hazırlanıyor</>
                    : <><PlugZap size={16} /> Bağlantı kodu oluştur</>}
                </button>
              ) : (
                <div className={`connector-status ${linkSession.status}`}>
                  <span>
                    {linkSession.status === 'complete'
                      ? <Check size={18} />
                      : linkSession.status === 'validating'
                      ? <RefreshCw size={18} className="spin" />
                      : linkSession.status === 'expired'
                      ? <AlertTriangle size={18} />
                      : <Clock3 size={18} />}
                  </span>
                  <div>
                    <strong>{linkSession.status === 'complete'
                      ? 'Hesap bağlandı'
                      : linkSession.status === 'validating'
                      ? 'Oturum doğrulanıyor'
                      : linkSession.status === 'expired'
                      ? 'Bağlantı süresi doldu'
                      : 'DeepSeek girişi bekleniyor'}</strong>
                    <small>{linkSession.status === 'complete'
                      ? 'Token doğrulandı ve doğrudan şifreli kasaya kaydedildi.'
                      : linkSession.errorMessage
                      ?? 'Connector uygulamasını açıp panodaki kodu yapıştırın. DeepSeek penceresini uygulama açar.'}</small>
                  </div>
                  {linkSession.status !== 'complete' && linkSession.nativeConnectorCode && (
                    <button
                      type="button"
                      className="secondary-button compact"
                      onClick={() => void copyConnectorCode()}
                    >
                      {linkCopied ? <Check size={14} /> : <Copy size={14} />}
                      {linkCopied ? 'Kod panoda' : 'Kodu kopyala'}
                    </button>
                  )}
                </div>
              )}
              {linkSession && !['complete', 'expired'].includes(linkSession.status) && (
                <div className="connector-actions">
                  <button
                    type="button"
                    className="secondary-button compact"
                    onClick={() => void copyConnectorCode()}
                  >
                    {linkCopied ? <Check size={14} /> : <Copy size={14} />}
                    {linkCopied ? 'Kod panoda' : 'Bağlantı kodunu kopyala'}
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => void cancelAutomaticLink()}
                  >
                    Bağlantıyı iptal et
                  </button>
                </div>
              )}
              {linkError && <p className="connector-error">{linkError}</p>}
              <p className="connector-privacy">
                Connector kişisel tarayıcı profilinizi, parolanızı, OTP kodunuzu veya geçmişinizi okuyamaz. Geçici profil işlem sonunda silinir; web tokenı yalnız onayladığınız gateway’in tek kullanımlık endpointine gönderilir.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="form-section">
              <div className="form-section-head"><span>{isEditing ? '02' : '03'}</span><div><strong>Web oturumu</strong><small>Token yalnız şifreli kasaya kaydedilir ve tekrar gösterilmez</small></div></div>
              <div className="credential-box">
                <div><LockKeyhole size={16} /><span>AES-256-GCM encrypted storage</span></div>
                {props.provider.credentialFields.map((field) => (
                  <Field key={field.name} label={`${field.label}${field.required ? ' *' : ''}`} hint={field.helpText}>
                    {field.type === 'textarea' ? (
                      <textarea
                        value={credentials[field.name] ?? ''}
                        onChange={(event) => setCredential(field.name, event.target.value)}
                        required={!isEditing && field.required}
                        rows={5}
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={field.placeholder}
                      />
                    ) : (
                      <div className="secret-input">
                        <input
                          type={field.type === 'password' && showCredential ? 'text' : field.type}
                          value={credentials[field.name] ?? ''}
                          onChange={(event) => setCredential(field.name, event.target.value)}
                          required={!isEditing && field.required}
                          autoComplete="off"
                          placeholder={field.placeholder}
                        />
                        {field.type === 'password' && (
                          <button
                            type="button"
                            onClick={() => setShowCredential((visible) => !visible)}
                            aria-label={showCredential ? 'Tokenı gizle' : 'Tokenı göster'}
                          >
                            {showCredential ? <EyeOff size={16} /> : <Eye size={16} />}
                          </button>
                        )}
                      </div>
                    )}
                  </Field>
                ))}
                <details className="onboarding-help">
                  <summary>Manuel token nasıl bulunur?</summary>
                  <ol>
                    <li>DeepSeek sekmesinde hesabınıza giriş yapın.</li>
                    <li>Network panelinde <code>users/current</code> isteğini açın.</li>
                    <li><code>Authorization</code> değerini bu alana yapıştırın.</li>
                  </ol>
                  <p>Parola, cookie dosyası veya HAR yüklemeyin.</p>
                </details>
              </div>
            </div>
            <div className="form-section">
              <div className="form-section-head"><span>{isEditing ? '03' : '04'}</span><div><strong>Bağlantı doğrulaması</strong><small>Geçersiz token kaydedilmez</small></div></div>
              <div className="connection-check">
                <div>
                  <span className={`connection-check-icon ${validation?.healthy ? 'success' : validationError ? 'danger' : ''}`}>
                    {validating
                      ? <RefreshCw size={17} className="spin" />
                      : validation?.healthy
                      ? <Check size={17} />
                      : <Activity size={17} />}
                  </span>
                  <div>
                    <strong>{validation?.healthy
                      ? 'Oturum doğrulandı'
                      : validationError
                      ? 'Bağlantı doğrulanamadı'
                      : hasCredentialUpdates
                      ? 'Doğrulamaya hazır'
                      : isEditing
                      ? 'Mevcut token korunacak'
                      : 'Token bekleniyor'}</strong>
                    <small>{validation?.healthy
                      ? `${validation.message} · ${validation.latencyMs} ms`
                      : validationError
                      ?? (isEditing && !hasCredentialUpdates
                        ? 'Tokenı değiştirmiyorsanız yeniden doğrulama gerekmez.'
                        : 'Kayıttan önce yalnız credential sağlık kontrolü yapılır.')}</small>
                  </div>
                </div>
                {hasCredentialUpdates && (
                  <button
                    type="button"
                    className="secondary-button compact"
                    onClick={() => void validateCredentials()}
                    disabled={validating}
                  >
                    {validating ? 'Kontrol ediliyor' : validation?.healthy ? 'Tekrar doğrula' : 'Bağlantıyı doğrula'}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={closePanel}>
            {connectionMode === 'automatic' && linkSession?.status === 'complete' ? 'Kapat' : 'Vazgeç'}
          </button>
          {connectionMode === 'manual' && (
            <button className="primary-button" disabled={!canSubmit}>
              {props.busy ? <><RefreshCw size={16} className="spin" /> Kaydediliyor</> : isEditing ? 'Değişiklikleri kaydet' : 'Doğrulanmış hesabı ekle'}
            </button>
          )}
        </div>
      </form>
    </Modal>
  )
}

function ApiKeyPanel(props: {
  busy: boolean
  providers: Provider[]
  onClose: () => void
  onSubmit: (input: {
    name: string
    scopes: Array<'chat' | 'models'>
    modelAllowlist: string[]
    requestsPerMinute: number
    dailyQuota: number
    expiresAt?: number
    allowedCidrs: string[]
  }) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [rpm, setRpm] = useState(60)
  const [daily, setDaily] = useState(1000)
  const models = [...new Set(props.providers.flatMap((provider) => provider.supportedModels))].sort()
  const [selectedModels, setSelectedModels] = useState<string[]>([])
  const [expiryDays, setExpiryDays] = useState('90')
  const [allowedCidrs, setAllowedCidrs] = useState('')
  return (
    <Modal title="Yeni API anahtarı" subtitle="İstemciye yalnız ihtiyaç duyduğu kapsamı ve kotayı verin." onClose={props.onClose} drawer>
      <form className="drawer-form" onSubmit={(event) => {
        event.preventDefault()
        void props.onSubmit({
          name,
          scopes: ['chat', 'models'],
          modelAllowlist: selectedModels,
          requestsPerMinute: rpm,
          dailyQuota: daily,
          expiresAt: expiryDays ? Date.now() + Number(expiryDays) * 24 * 60 * 60_000 : undefined,
          allowedCidrs: parsePolicyLines(allowedCidrs),
        })
      }}>
        <div className="form-section">
          <div className="form-section-head"><span>01</span><div><strong>İstemci kimliği</strong><small>Anahtarın nerede kullanıldığını net adlandırın</small></div></div>
          <Field label="Anahtar adı">
            <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} placeholder="Örn. reklam-analiz-codex" />
          </Field>
        </div>
        <div className="form-section">
          <div className="form-section-head"><span>02</span><div><strong>Kota politikası</strong><small>İstemci bazlı hız ve günlük kullanım sınırı</small></div></div>
          <div className="form-grid">
            <Field label="Dakikalık sınır">
              <input type="number" min={1} max={100000} value={rpm} onChange={(event) => setRpm(Number(event.target.value))} />
            </Field>
            <Field label="Günlük kota">
              <input type="number" min={1} max={10000000} value={daily} onChange={(event) => setDaily(Number(event.target.value))} />
            </Field>
          </div>
        </div>
        <div className="form-section">
          <div className="form-section-head"><span>03</span><div><strong>Erişim sınırları</strong><small>Süre ve kaynak ağı politikası</small></div></div>
          <div className="form-grid">
            <Field label="Anahtar geçerliliği">
              <select value={expiryDays} onChange={(event) => setExpiryDays(event.target.value)}>
                <option value="30">30 gün</option>
                <option value="90">90 gün</option>
                <option value="180">180 gün</option>
                <option value="365">1 yıl</option>
                <option value="">Süresiz</option>
              </select>
            </Field>
            <Field label="IP / CIDR allowlist" hint="Boş bırakılırsa tüm kaynak IP’ler kabul edilir.">
              <textarea
                value={allowedCidrs}
                onChange={(event) => setAllowedCidrs(event.target.value)}
                rows={3}
                spellCheck={false}
                placeholder={'203.0.113.10\n2001:db8::/32'}
              />
            </Field>
          </div>
        </div>
        <div className="form-section">
          <div className="form-section-head"><span>04</span><div><strong>Model erişimi</strong><small>Seçim yoksa tüm aktif modeller kullanılabilir</small></div></div>
          <div className="model-selector">
            {models.map((model) => (
              <label className={selectedModels.includes(model) ? 'selected' : ''} key={model}>
                <input
                  type="checkbox"
                  checked={selectedModels.includes(model)}
                  onChange={(event) => setSelectedModels(
                    event.target.checked
                      ? [...selectedModels, model]
                      : selectedModels.filter((entry) => entry !== model),
                  )}
                />
                <span><Check size={13} /></span>
                {model}
              </label>
            ))}
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={props.onClose}>Vazgeç</button>
          <button className="primary-button" disabled={props.busy}>
            {props.busy ? <><RefreshCw size={16} className="spin" /> Oluşturuluyor</> : 'Anahtarı oluştur'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function ApiKeyRotationPanel(props: {
  record: ApiKeyRecord
  busy: boolean
  onClose: () => void
  onSubmit: (input: { gracePeriodMinutes: number; expiresAt?: number }) => Promise<void>
}) {
  const [gracePeriodMinutes, setGracePeriodMinutes] = useState(60)
  const [expiryDays, setExpiryDays] = useState('90')

  return (
    <Modal
      title="API anahtarını güvenle döndür"
      subtitle={`${props.record.name} için aynı kota, model ve IP politikalarıyla yeni bir anahtar üretilecek.`}
      onClose={props.onClose}
      drawer
    >
      <form className="drawer-form" onSubmit={(event) => {
        event.preventDefault()
        void props.onSubmit({
          gracePeriodMinutes,
          expiresAt: expiryDays ? Date.now() + Number(expiryDays) * 24 * 60 * 60_000 : undefined,
        })
      }}>
        <div className="form-section">
          <div className="form-section-head"><span>01</span><div><strong>Geçiş penceresi</strong><small>Eski istemcilerin yeni anahtara taşınma süresi</small></div></div>
          <Field label="Eski anahtarın çalışacağı ek süre">
            <select value={gracePeriodMinutes} onChange={(event) => setGracePeriodMinutes(Number(event.target.value))}>
              <option value={0}>Hemen kapat</option>
              <option value={15}>15 dakika</option>
              <option value={60}>1 saat</option>
              <option value={1440}>1 gün</option>
              <option value={10080}>7 gün</option>
            </select>
          </Field>
          <Field label="Yeni anahtarın geçerliliği">
            <select value={expiryDays} onChange={(event) => setExpiryDays(event.target.value)}>
              <option value="30">30 gün</option>
              <option value="90">90 gün</option>
              <option value="180">180 gün</option>
              <option value="365">1 yıl</option>
              <option value="">Süresiz</option>
            </select>
          </Field>
        </div>
        <div className="risk-note">
          <RefreshCw size={18} />
          <p>Yeni raw anahtar yalnız bir kez gösterilir. Eski anahtar seçilen geçiş süresi sonunda otomatik olarak geçersiz olur.</p>
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={props.onClose}>Vazgeç</button>
          <button className="primary-button" disabled={props.busy}>
            {props.busy ? <><RefreshCw size={16} className="spin" /> Döndürülüyor</> : 'Yeni anahtarı üret'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function ApiKeyPolicyPanel(props: {
  record: ApiKeyRecord
  providers: Provider[]
  busy: boolean
  onClose: () => void
  onSubmit: (input: {
    modelAllowlist: string[]
    requestsPerMinute: number
    dailyQuota: number
    expiresAt: number | null
    allowedCidrs: string[]
  }) => Promise<void>
}) {
  const models = [...new Set(props.providers.flatMap((provider) => provider.supportedModels))].sort()
  const [selectedModels, setSelectedModels] = useState(props.record.modelAllowlist)
  const [rpm, setRpm] = useState(props.record.requestsPerMinute)
  const [dailyQuota, setDailyQuota] = useState(props.record.dailyQuota)
  const [expiresAt, setExpiresAt] = useState(formatDateTimeLocal(props.record.expiresAt))
  const [allowedCidrs, setAllowedCidrs] = useState(props.record.allowedCidrs.join('\n'))

  return (
    <Modal
      title="API anahtarı politikası"
      subtitle={`${props.record.name} için erişim sınırlarını güncelleyin. Raw anahtar bu işlemde okunmaz veya değişmez.`}
      onClose={props.onClose}
      drawer
    >
      <form className="drawer-form" onSubmit={(event) => {
        event.preventDefault()
        void props.onSubmit({
          modelAllowlist: selectedModels,
          requestsPerMinute: rpm,
          dailyQuota,
          expiresAt: expiresAt ? new Date(expiresAt).getTime() : null,
          allowedCidrs: parsePolicyLines(allowedCidrs),
        })
      }}>
        <div className="form-section">
          <div className="form-section-head"><span>01</span><div><strong>Kota ve süre</strong><small>İstemcinin operasyon sınırları</small></div></div>
          <div className="form-grid">
            <Field label="Dakikalık istek">
              <input type="number" min={1} max={100000} value={rpm} onChange={(event) => setRpm(Number(event.target.value))} required />
            </Field>
            <Field label="Günlük kota">
              <input type="number" min={1} max={10000000} value={dailyQuota} onChange={(event) => setDailyQuota(Number(event.target.value))} required />
            </Field>
            <Field label="Geçerlilik sonu" hint="Boş bırakılırsa süresiz olur.">
              <input
                type="datetime-local"
                value={expiresAt}
                min={formatDateTimeLocal(Date.now() + 2 * 60_000)}
                onChange={(event) => setExpiresAt(event.target.value)}
              />
            </Field>
            <Field label="IP / CIDR allowlist" hint="Her satıra bir IP veya CIDR; boş değer tüm kaynaklara izin verir.">
              <textarea
                value={allowedCidrs}
                onChange={(event) => setAllowedCidrs(event.target.value)}
                rows={4}
                spellCheck={false}
                placeholder={'203.0.113.10\n2001:db8::/32'}
              />
            </Field>
          </div>
        </div>
        <div className="form-section">
          <div className="form-section-head"><span>02</span><div><strong>Model erişimi</strong><small>Seçim yoksa tüm aktif modeller</small></div></div>
          <div className="model-selector">
            {models.map((model) => (
              <label className={selectedModels.includes(model) ? 'selected' : ''} key={model}>
                <input
                  type="checkbox"
                  checked={selectedModels.includes(model)}
                  onChange={() => setSelectedModels((current) => (
                    current.includes(model)
                      ? current.filter((entry) => entry !== model)
                      : [...current, model]
                  ))}
                />
                <span><Check size={13} /></span>
                <code>{model}</code>
              </label>
            ))}
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={props.onClose}>Vazgeç</button>
          <button className="primary-button" disabled={props.busy}>
            {props.busy ? <><RefreshCw size={16} className="spin" /> Kaydediliyor</> : 'Politikayı kaydet'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function OneTimeKey({ value, onClose }: { value: string; onClose: () => void }) {
  const [copied, setCopied] = useState<'key' | 'example' | null>(null)
  const baseUrl = window.location.origin
  const example = `OPENAI_BASE_URL=${baseUrl}/v1\nOPENAI_API_KEY=<bu-ekrandaki-anahtar>\n\ncurl "${baseUrl}/v1/models" \\\n  -H "Authorization: Bearer $OPENAI_API_KEY"`
  return (
    <Modal title="API anahtarı oluşturuldu" subtitle="Raw değer yalnız bu ekranda bir kez gösterilir." onClose={onClose} narrow>
      <div className="success-illustration"><CheckCircle2 size={29} /></div>
      <div className="one-time-key">
        <code>{value}</code>
        <button onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied('key'))}>
          {copied === 'key' ? <Check size={17} /> : <Copy size={17} />}
          {copied === 'key' ? 'Kopyalandı' : 'Kopyala'}
        </button>
      </div>
      <div className="credential-box example-box">
        <div><Server size={16} /><span>İstemci ortam değişkenleri</span></div>
        <pre><code>{example}</code></pre>
        <button className="secondary-button full" onClick={() => void navigator.clipboard.writeText(example).then(() => setCopied('example'))}>
          {copied === 'example' ? <Check size={17} /> : <Copy size={17} />}
          {copied === 'example' ? 'Örnek kopyalandı' : 'Kurulum örneğini kopyala'}
        </button>
      </div>
      <div className="risk-note"><AlertTriangle size={18} /><p>Anahtarı secret manager’da saklayın. Kaynak kod, URL veya sohbet mesajına eklemeyin.</p></div>
      <button className="primary-button full modal-final-button" onClick={onClose}>Anahtarı güvenle sakladım</button>
    </Modal>
  )
}

function ConfirmDialog({
  confirmation,
  busy,
  onClose,
  onConfirm,
}: {
  confirmation: Confirmation
  busy: boolean
  onClose: () => void
  onConfirm: () => Promise<void>
}) {
  return (
    <Modal title={confirmation.title} subtitle={confirmation.description} onClose={onClose} narrow>
      <div className={`confirm-visual ${confirmation.tone === 'danger' ? 'danger' : ''}`}>
        <AlertTriangle size={25} />
      </div>
      <div className="confirm-copy">
        <strong>Bu işlem geri alınamaz.</strong>
        <p>Devam etmeden önce bağlı istemci ve operasyon etkisini doğrulayın.</p>
      </div>
      <div className="confirm-actions">
        <button className="secondary-button" onClick={onClose}>Vazgeç</button>
        <button className={confirmation.tone === 'danger' ? 'danger-button' : 'primary-button'} disabled={busy} onClick={() => void onConfirm()}>
          {busy ? 'İşleniyor' : confirmation.confirmLabel}
        </button>
      </div>
    </Modal>
  )
}

function CommandPalette({
  data,
  onClose,
  onNavigate,
  onRefresh,
  onCreateKey,
  onAddAccount,
}: {
  data: DashboardData | null
  onClose: () => void
  onNavigate: (view: View) => void
  onRefresh: () => void
  onCreateKey: () => void
  onAddAccount: () => void
}) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => inputRef.current?.focus(), [])
  const actions = [
    ...navigation.map((item) => ({
      id: item.id,
      label: item.label,
      description: item.description,
      icon: item.icon,
      action: () => onNavigate(item.id),
    })),
    {
      id: 'add-account',
      label: 'DeepSeek hesabı ekle',
      description: 'Yeni web oturumu kaydet',
      icon: Plus,
      action: onAddAccount,
    },
    {
      id: 'create-key',
      label: 'API anahtarı oluştur',
      description: 'Yeni istemci erişimi tanımla',
      icon: KeyRound,
      action: onCreateKey,
    },
    {
      id: 'refresh',
      label: 'Verileri yenile',
      description: data ? `${data.activity.length} aktivite kaydı yüklü` : 'Paneli yeniden yükle',
      icon: RefreshCw,
      action: onRefresh,
    },
  ]
  const filtered = actions.filter((action) => `${action.label} ${action.description}`.toLowerCase().includes(query.toLowerCase()))
  return (
    <div className="command-layer" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose()
    }}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-label="Hızlı erişim">
        <div className="command-search">
          <Search size={18} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Sayfa veya işlem ara"
            onKeyDown={(event) => {
              if (event.key === 'Escape') onClose()
              if (event.key === 'Enter' && filtered[0]) filtered[0].action()
            }}
          />
          <kbd>ESC</kbd>
        </div>
        <div className="command-results">
          {filtered.map((action) => (
            <button key={action.id} onClick={action.action}>
              <span><action.icon size={17} /></span>
              <div><strong>{action.label}</strong><small>{action.description}</small></div>
              <ChevronRight size={16} />
            </button>
          ))}
          {filtered.length === 0 && <div className="command-empty">Eşleşen işlem bulunamadı.</div>}
        </div>
        <footer><Command size={13} /> İlk sonucu açmak için Enter</footer>
      </section>
    </div>
  )
}

function ActivityTable({
  records,
  accountNames = new Map(),
  compact = false,
}: {
  records: RequestActivity[]
  accountNames?: Map<string, string>
  compact?: boolean
}) {
  return (
    <>
      <div className="responsive-table desktop-record-table">
        <table>
          <thead><tr><th>Durum</th><th>Model / istek</th>{!compact && <th>Hesap</th>}<th>Süre</th><th>Zaman</th></tr></thead>
          <tbody>
            {records.map((record) => (
              <tr key={record.id}>
                <td><StatusBadge status={activityTone(record.status)}>{activityStatusLabel(record.status)}</StatusBadge></td>
                <td><strong>{record.model}</strong><small>{record.isStream ? 'stream' : 'json'} · {record.requestId.slice(0, 8)}</small></td>
                {!compact && <td>{accountNames.get(record.accountId ?? '') ?? record.providerId ?? '—'}</td>}
                <td>{formatDuration(record.latency)}</td>
                <td>{formatDate(record.timestamp)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {records.length === 0 && <div className="empty-state"><Activity size={24} /><strong>Henüz istek kaydı yok</strong><span>İlk istemci çağrısı burada görünecek.</span></div>}
      </div>
      <div className="mobile-record-list">
        {records.map((record) => (
          <article className="mobile-record-card" key={record.id}>
            <header>
              <StatusBadge status={activityTone(record.status)}>{activityStatusLabel(record.status)}</StatusBadge>
              <time>{formatRelativeTime(record.timestamp)}</time>
            </header>
            <div className="mobile-record-title"><strong>{record.model}</strong><small>{record.isStream ? 'stream' : 'json'} · {record.requestId.slice(0, 8)}</small></div>
            <dl>
              {!compact && <div><dt>Hesap</dt><dd>{accountNames.get(record.accountId ?? '') ?? record.providerId ?? '—'}</dd></div>}
              <div><dt>Süre</dt><dd>{formatDuration(record.latency)}</dd></div>
            </dl>
          </article>
        ))}
        {records.length === 0 && <div className="empty-state"><Activity size={24} /><strong>Henüz istek kaydı yok</strong></div>}
      </div>
    </>
  )
}

function MobileNavigation({ activeView, onSelect }: { activeView: View; onSelect: (view: View) => void }) {
  return (
    <nav className="mobile-navigation" aria-label="Mobil yönetim menüsü">
      {navigation.map((item) => (
        <button className={activeView === item.id ? 'active' : ''} key={item.id} onClick={() => onSelect(item.id)}>
          <item.icon size={18} />
          <span>{item.shortLabel}</span>
        </button>
      ))}
    </nav>
  )
}

function PageIntro({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return (
    <section className="page-intro">
      <div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2><p>{description}</p></div>
      {action}
    </section>
  )
}

function SummaryCard({ label, value, icon: Icon, tone = 'neutral' }: { label: string; value: string; icon: typeof Activity; tone?: 'success' | 'danger' | 'neutral' }) {
  return <article className={`summary-card ${tone}`}><span><Icon size={17} /></span><div><small>{label}</small><strong>{value}</strong></div></article>
}

function MiniBars({ records, offset }: { records: RequestActivity[]; offset: number }) {
  const values = Array.from({ length: 12 }, (_, index) => {
    const record = records[(index + offset) % Math.max(records.length, 1)]
    if (!record) return 14 + ((index * 7 + offset * 11) % 38)
    return Math.max(12, Math.min(58, Math.round(record.latency / 80)))
  })
  return <div className="mini-bars" aria-hidden="true">{values.map((value, index) => <i key={index} style={{ height: `${value}%` }} />)}</div>
}

function ActivityBars({ records }: { records: RequestActivity[] }) {
  const max = Math.max(...records.map((record) => record.latency), 1)
  if (records.length === 0) return <div className="activity-bars empty-bars"><span>İstek geldikçe grafik oluşur.</span></div>
  return (
    <div className="activity-bars" aria-label="Son istek gecikme grafiği">
      {records.map((record) => (
        <i
          className={record.status}
          key={record.id}
          style={{ height: `${Math.max(8, (record.latency / max) * 100)}%` }}
          title={`${record.model}: ${formatDuration(record.latency)}`}
        />
      ))}
    </div>
  )
}

function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="copy-field">
      <span>{label}</span>
      <div><code>{value}</code><button onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true))}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? 'Kopyalandı' : 'Kopyala'}</button></div>
    </div>
  )
}

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
}) {
  return <div className="segmented-control">{options.map((option) => <button type="button" className={option.value === value ? 'active' : ''} key={option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>
}

function PanelHeader({ title, subtitle, action }: { title: string; subtitle: string; action?: ReactNode }) {
  return <div className="panel-header"><div><h2>{title}</h2><p>{subtitle}</p></div>{action}</div>
}

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return <label className={`field ${error ? 'has-error' : ''}`}><span>{label}</span>{children}{error ? <small className="field-error">{error}</small> : hint && <small>{hint}</small>}</label>
}

function Modal({
  title,
  subtitle,
  children,
  onClose,
  narrow = false,
  drawer = false,
}: {
  title: string
  subtitle: string
  children: ReactNode
  onClose: () => void
  narrow?: boolean
  drawer?: boolean
}) {
  const dialogRef = useRef<HTMLElement>(null)
  const closeFromEffect = useEffectEvent(onClose)
  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeFromEffect()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  return (
    <div className={`modal-layer ${drawer ? 'drawer-layer' : ''}`} role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose()
    }}>
      <section
        ref={dialogRef}
        tabIndex={-1}
        className={`modal ${narrow ? 'narrow' : ''} ${drawer ? 'drawer' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <div className="modal-head">
          <div><p className="eyebrow">{drawer ? 'Yapılandırma' : 'Güvenli işlem'}</p><h2 id="modal-title">{title}</h2><span>{subtitle}</span></div>
          <button className="icon-button" onClick={onClose} aria-label="Kapat"><X size={19} /></button>
        </div>
        {children}
      </section>
    </div>
  )
}

function Banner({ tone, children, onClose }: { tone: 'danger' | 'success'; children: ReactNode; onClose: () => void }) {
  return <div className={`banner ${tone}`}>{tone === 'success' ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}<span>{children}</span><button onClick={onClose} aria-label="Bildirimi kapat"><X size={15} /></button></div>
}

function StatusBadge({ status, children }: { status: 'success' | 'danger' | 'warning' | 'neutral'; children: ReactNode }) {
  return <span className={`status-badge ${status}`}><i />{children}</span>
}

function ProviderAvatar({ name }: { name: string }) {
  return <span className="provider-avatar">{name.slice(0, 2).toUpperCase()}</span>
}

function LoadingScreen() {
  return <div className="loading-screen"><div className="brand-mark large"><Server size={23} /></div><div className="loading-pulse"><i /><i /><i /></div><span>Gateway hazırlanıyor</span></div>
}

function PageSkeleton() {
  return <div className="skeleton-grid">{Array.from({ length: 8 }, (_, index) => <div key={index} />)}</div>
}

function deriveGatewayState(data: DashboardData | null) {
  if (!data || data.accounts.length === 0) {
    return {
      tone: 'warning' as const,
      shortLabel: 'Kurulum gerekli',
      label: 'Başlangıç adımı',
      headline: 'İlk DeepSeek hesabınızı bağlayın.',
      description: 'Gateway çalışıyor; istemci trafiği almadan önce şifreli bir web oturumu ekleyin ve bağlantıyı doğrulayın.',
      actionView: 'providers' as View,
      actionLabel: 'Hesapları aç',
    }
  }
  const readiness = data.overview.gateway.readiness
  if (readiness.reasonCode === 'no_active_account') {
    return {
      tone: 'warning' as const,
      shortLabel: 'Hesap kapalı',
      label: 'Aktif hesap gerekli',
      headline: 'DeepSeek hesabı etkinleştirilmeden trafik alınamaz.',
      description: 'Mevcut hesabı etkinleştirin veya yeni bir oturumu doğrulayarak ekleyin.',
      actionView: 'providers' as View,
      actionLabel: 'Hesapları aç',
    }
  }
  if (readiness.reasonCode === 'provider_rate_limited') {
    return {
      tone: 'warning' as const,
      shortLabel: 'Trafik kısıtlı',
      label: 'DeepSeek hız sınırı',
      headline: 'DeepSeek yeni istekleri geçici olarak sınırlıyor.',
      description: readiness.retryAt
        ? `Credential geçerli; trafik devre kesici tarafından korunuyor. Yeniden deneme ${formatRelativeTime(readiness.retryAt)} mümkün olacak.`
        : 'Credential geçerli; gerçek üretim çağrıları geçici olarak sınırlandırılıyor. Aktivite kayıtlarından sağlayıcı durumunu izleyin.',
      actionView: 'activity' as View,
      actionLabel: 'Aktiviteyi incele',
    }
  }
  if (readiness.status === 'blocked' || readiness.status === 'degraded') {
    return {
      tone: 'danger' as const,
      shortLabel: 'Dikkat gerekli',
      label: 'Operasyon uyarısı',
      headline: readinessHeadline(readiness.reasonCode),
      description: readinessDescription(readiness.reasonCode),
      actionView: 'providers' as View,
      actionLabel: 'Sorunu incele',
    }
  }
  if (readiness.status === 'needs_check') {
    return {
      tone: 'warning' as const,
      shortLabel: 'Kontrol bekliyor',
      label: readiness.reasonCode === 'no_successful_request'
        ? 'Trafik doğrulaması'
        : 'Credential doğrulaması',
      headline: readiness.reasonCode === 'no_successful_request'
        ? 'Oturum geçerli; ilk gerçek gateway isteği bekleniyor.'
        : 'Gateway hazır; hesap sağlığını doğrulayın.',
      description: readiness.reasonCode === 'no_successful_request'
        ? 'Sağlık kontrolü yalnız oturumu doğrular. Operasyonel hazır durumu için istemci anahtarıyla başarılı bir metin isteği tamamlayın.'
        : 'Aktif oturum mevcut ancak son credential sağlık kontrolü henüz tamamlanmamış.',
      actionView: readiness.reasonCode === 'no_successful_request' ? 'keys' as View : 'providers' as View,
      actionLabel: readiness.reasonCode === 'no_successful_request' ? 'Bağlantıyı kur' : 'Bağlantıyı test et',
    }
  }
  return {
    tone: 'success' as const,
    shortLabel: 'Operasyonel',
    label: 'Tüm sistemler normal',
    headline: 'Gateway trafiği güvenle karşılamaya hazır.',
    description: 'Aktif hesaplar sağlıklı, erişim sınırları etkin ve istek gövdeleri operasyon loglarına yazılmıyor.',
    actionView: 'activity' as View,
    actionLabel: 'Canlı aktivite',
  }
}

function readinessReasonLabel(reason: DashboardData['overview']['gateway']['readiness']['reasonCode']): string {
  const labels = {
    ready: 'Gerçek trafik doğrulandı',
    no_active_account: 'Aktif DeepSeek hesabı gerekli',
    credential_check_required: 'Credential kontrolü gerekli',
    no_successful_request: 'İlk başarılı istek bekleniyor',
    provider_rate_limited: 'DeepSeek istekleri geçici olarak sınırlıyor',
    provider_authentication_failed: 'Oturum tokenı geçersiz veya süresi dolmuş',
    provider_unavailable: 'DeepSeek erişilemiyor',
    provider_timeout: 'DeepSeek yanıt süresi aşıldı',
    provider_protocol_changed: 'DeepSeek web protokolü kontrol edilmeli',
    no_available_account: 'Kullanılabilir hesap bulunamadı',
  } satisfies Record<DashboardData['overview']['gateway']['readiness']['reasonCode'], string>
  return labels[reason]
}

function readinessHeadline(reason: DashboardData['overview']['gateway']['readiness']['reasonCode']): string {
  if (reason === 'provider_authentication_failed') return 'DeepSeek oturumu yeniden bağlanmalı.'
  if (reason === 'provider_protocol_changed') return 'DeepSeek web bağlantısı teknik kontrol bekliyor.'
  if (reason === 'provider_timeout') return 'DeepSeek yanıt süresi operasyon sınırını aştı.'
  if (reason === 'no_available_account') return 'Trafiği karşılayacak kullanılabilir hesap yok.'
  return 'DeepSeek bağlantısı geçici olarak kullanılamıyor.'
}

function readinessDescription(reason: DashboardData['overview']['gateway']['readiness']['reasonCode']): string {
  if (reason === 'provider_authentication_failed') {
    return 'Şifreli oturum tokenını güncelleyin ve kaydetmeden önce bağlantı doğrulamasını tamamlayın.'
  }
  if (reason === 'provider_protocol_changed') {
    return 'Credential sağlıklı görünse bile gerçek istek başarısız oldu. Provider adaptörünü ve son aktivite kodunu inceleyin.'
  }
  if (reason === 'no_available_account') {
    return 'Hesap durumu, günlük kota ve devre kesici bilgilerini birlikte kontrol edin.'
  }
  return readinessReasonLabel(reason)
}

function getNavigationBadge(view: View, data: DashboardData | null): { value: string; tone: string } | null {
  if (!data) return null
  if (view === 'providers' && data.overview.accounts.attention > 0) return { value: String(data.overview.accounts.attention), tone: 'danger' }
  if (view === 'providers') return { value: String(data.overview.accounts.active), tone: 'neutral' }
  if (view === 'keys') {
    return {
      value: String(data.apiKeys.filter((record) => (
        record.enabled && (!record.expiresAt || record.expiresAt > Date.now())
      )).length),
      tone: 'neutral',
    }
  }
  if (view === 'activity' && data.overview.requests.today > 0) return { value: formatNumber(data.overview.requests.today), tone: 'neutral' }
  return null
}

function readViewFromHash(): View {
  const candidate = window.location.hash.replace('#', '')
  return navigation.some((item) => item.id === candidate) ? candidate as View : 'overview'
}

function accountStatusTone(account: Account): 'success' | 'danger' | 'warning' | 'neutral' {
  if (account.status === 'error' || account.status === 'expired') return 'danger'
  if (account.cooldownUntil || account.health?.status === 'rate_limited') return 'warning'
  if (account.status === 'active' && account.health?.healthy) return 'success'
  return 'neutral'
}

function accountStatusLabel(account: Account): string {
  if (account.cooldownUntil) return 'Beklemede'
  if (account.health?.healthy) return account.status === 'active' ? 'Sağlıklı' : 'Duraklatıldı'
  if (account.status === 'error') return 'Hatalı'
  if (account.status === 'expired') return 'Süresi doldu'
  if (account.status === 'inactive') return 'Kapalı'
  return 'Kontrol bekliyor'
}

function activityTone(status: RequestActivity['status']): 'success' | 'danger' | 'warning' {
  return status === 'success' ? 'success' : status === 'pending' ? 'warning' : 'danger'
}

function activityStatusLabel(status: RequestActivity['status']): string {
  return status === 'success' ? 'Başarılı' : status === 'pending' ? 'Bekliyor' : 'Hatalı'
}

function auditActionLabel(action: string): string {
  const labels: Record<string, string> = {
    'admin.login': 'Yönetici oturumu',
    'admin.logout': 'Oturum kapatıldı',
    'account.create': 'Provider hesabı eklendi',
    'account.update': 'Provider hesabı güncellendi',
    'account.delete': 'Provider hesabı silindi',
    'account.health_check': 'Credential sağlık kontrolü',
    'account.credentials.validate': 'Kaydetmeden önce credential doğrulaması',
    'api_key.create': 'API anahtarı oluşturuldu',
    'api_key.rotate': 'API anahtarı döndürüldü',
    'api_key.update': 'API anahtarı güncellendi',
    'api_key.delete': 'API anahtarı silindi',
    'gateway.settings.update': 'Gateway ayarı güncellendi',
  }
  return labels[action] ?? action
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('tr-TR').format(value)
}

function formatDuration(value: number): string {
  if (value >= 60_000) return `${(value / 60_000).toFixed(1)} dk`
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)} sn`
  return `${formatNumber(value)} ms`
}

function formatDate(value?: number): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('tr-TR', { dateStyle: 'short', timeStyle: 'short' }).format(value)
}

function formatAbsoluteDate(value: number): string {
  return new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium' }).format(value)
}

function formatDateTimeLocal(value?: number): string {
  if (!value) return ''
  const date = new Date(value)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(value - offset).toISOString().slice(0, 16)
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function parsePolicyLines(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean))]
}

function formatRelativeTime(value?: number): string {
  if (!value) return 'Henüz yok'
  const difference = value - Date.now()
  const absolute = Math.abs(difference)
  if (absolute < 60_000) return difference > 0 ? 'birazdan' : 'şimdi'
  if (absolute < 3_600_000) {
    const minutes = Math.round(difference / 60_000)
    return new Intl.RelativeTimeFormat('tr', { numeric: 'auto' }).format(minutes, 'minute')
  }
  if (absolute < 86_400_000) {
    const hours = Math.round(difference / 3_600_000)
    return new Intl.RelativeTimeFormat('tr', { numeric: 'auto' }).format(hours, 'hour')
  }
  return formatDate(value)
}

function formatTimeUntil(value: number): string {
  const remaining = Math.max(0, value - Date.now())
  if (remaining === 0) return 'Süre dolmak üzere'
  const hours = Math.floor(remaining / 3_600_000)
  const minutes = Math.floor((remaining % 3_600_000) / 60_000)
  return `${hours} sa ${minutes} dk kaldı`
}
