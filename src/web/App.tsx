import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronRight,
  CircleGauge,
  Copy,
  Database,
  KeyRound,
  Layers3,
  LockKeyhole,
  LogOut,
  Menu,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  ApiError,
  createAccount,
  createApiKey,
  deleteAccount,
  deleteApiKey,
  getSession,
  loadDashboard,
  login,
  logout,
  testAccount,
  updateAccount,
  updateApiKey,
  updateProvider,
  updateSettings,
} from './api'
import type {
  Account,
  ApiKeyRecord,
  DashboardData,
  GatewaySettings,
  Provider,
  RequestActivity,
} from './types'

type View = 'overview' | 'providers' | 'keys' | 'activity' | 'security'

const navigation: Array<{ id: View; label: string; icon: typeof CircleGauge }> = [
  { id: 'overview', label: 'Genel bakış', icon: CircleGauge },
  { id: 'providers', label: 'Sağlayıcılar', icon: Layers3 },
  { id: 'keys', label: 'API anahtarları', icon: KeyRound },
  { id: 'activity', label: 'İstek aktivitesi', icon: Activity },
  { id: 'security', label: 'Güvenlik ve ayarlar', icon: ShieldCheck },
]

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  const [data, setData] = useState<DashboardData | null>(null)
  const [view, setView] = useState<View>('overview')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [accountProvider, setAccountProvider] = useState<Provider | null>(null)
  const [editingAccount, setEditingAccount] = useState<Account | null>(null)
  const [keyPanel, setKeyPanel] = useState(false)
  const [revealedKey, setRevealedKey] = useState<string | null>(null)

  const refresh = async () => {
    setBusy(true)
    try {
      setData(await loadDashboard())
      setError(null)
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        setAuthenticated(false)
      } else {
        setError(cause instanceof Error ? cause.message : 'Veriler alınamadı.')
      }
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void getSession().then((active) => {
      setAuthenticated(active)
      if (active) void refresh()
    })
  }, [])

  const run = async (operation: () => Promise<unknown>, message: string) => {
    setBusy(true)
    setError(null)
    try {
      await operation()
      setNotice(message)
      await refresh()
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'İşlem tamamlanamadı.')
      return false
    } finally {
      setBusy(false)
    }
  }

  if (authenticated === null) return <LoadingScreen />
  if (!authenticated) {
    return <LoginScreen onAuthenticated={() => {
      setAuthenticated(true)
      void refresh()
    }} />
  }

  const activeNavLabel = navigation.find((item) => item.id === view)?.label ?? 'Genel bakış'
  const editingProvider = editingAccount
    ? data?.providers.find((provider) => provider.id === editingAccount.providerId)
    : undefined
  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? 'is-open' : ''}`}>
        <div className="brand">
          <div className="brand-mark"><Server size={20} /></div>
          <div>
            <strong>Chat2API</strong>
            <span>Secure gateway</span>
          </div>
          <button className="icon-button sidebar-close" onClick={() => setSidebarOpen(false)} aria-label="Menüyü kapat">
            <X size={19} />
          </button>
        </div>
        <nav aria-label="Yönetim menüsü">
          {navigation.map((item) => (
            <button
              key={item.id}
              className={view === item.id ? 'active' : ''}
              onClick={() => {
                setView(item.id)
                setSidebarOpen(false)
              }}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
              {view === item.id && <ChevronRight size={16} className="nav-arrow" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-security">
          <LockKeyhole size={17} />
          <div>
            <strong>İzole çalışma</strong>
            <span>Body log kapalı · secrets şifreli</span>
          </div>
        </div>
      </aside>

      {sidebarOpen && <button className="sidebar-backdrop" aria-label="Menüyü kapat" onClick={() => setSidebarOpen(false)} />}

      <main>
        <header className="topbar">
          <button className="icon-button menu-button" onClick={() => setSidebarOpen(true)} aria-label="Menüyü aç">
            <Menu size={20} />
          </button>
          <div>
            <p className="eyebrow">Gateway control plane</p>
            <h1>{activeNavLabel}</h1>
          </div>
          <div className="topbar-actions">
            <span className="live-status"><i /> Çalışıyor</span>
            <button className="icon-button" onClick={() => void refresh()} disabled={busy} aria-label="Yenile">
              <RefreshCw size={18} className={busy ? 'spin' : ''} />
            </button>
            <button
              className="icon-button"
              onClick={() => void logout().finally(() => setAuthenticated(false))}
              aria-label="Çıkış yap"
            >
              <LogOut size={18} />
            </button>
          </div>
        </header>

        <div className="content">
          {error && <Banner tone="danger" onClose={() => setError(null)}>{error}</Banner>}
          {notice && <Banner tone="success" onClose={() => setNotice(null)}>{notice}</Banner>}
          {!data ? <PageSkeleton /> : (
            <>
              {view === 'overview' && <OverviewPage data={data} setView={setView} />}
              {view === 'providers' && (
                <ProvidersPage
                  providers={data.providers}
                  accounts={data.accounts}
                  onAdd={setAccountProvider}
                  onToggle={(provider) => run(
                    () => updateProvider(provider.id, !provider.enabled),
                    `${provider.name} güncellendi.`,
                  )}
                  onAccountToggle={(account) => run(
                    () => updateAccount(account.id, { status: account.status === 'active' ? 'inactive' : 'active' }),
                    'Hesap durumu güncellendi.',
                  )}
                  onAccountEdit={setEditingAccount}
                  onAccountTest={async (account) => {
                    setBusy(true)
                    setError(null)
                    try {
                      const health = await testAccount(account.id)
                      setNotice(`${account.name}: ${health.message} (${health.latencyMs} ms)`)
                      await refresh()
                    } catch (cause) {
                      setError(cause instanceof Error ? cause.message : 'Bağlantı testi tamamlanamadı.')
                    } finally {
                      setBusy(false)
                    }
                  }}
                  onAccountDelete={(account) => {
                    if (window.confirm(`${account.name} hesabı kalıcı olarak silinsin mi?`)) {
                      void run(() => deleteAccount(account.id), 'Hesap silindi.')
                    }
                  }}
                />
              )}
              {view === 'keys' && (
                <ApiKeysPage
                  records={data.apiKeys}
                  onCreate={() => setKeyPanel(true)}
                  onToggle={(record) => run(
                    () => updateApiKey(record.id, !record.enabled),
                    'API anahtarı güncellendi.',
                  )}
                  onDelete={(record) => {
                    if (window.confirm(`${record.name} anahtarı kalıcı olarak silinsin mi?`)) {
                      void run(() => deleteApiKey(record.id), 'API anahtarı silindi.')
                    }
                  }}
                />
              )}
              {view === 'activity' && <ActivityPage records={data.activity} accounts={data.accounts} />}
              {view === 'security' && (
                <SecurityPage
                  settings={data.settings}
                  onSave={(settings) => run(() => updateSettings(settings), 'Gateway ayarları kaydedildi.')}
                />
              )}
            </>
          )}
        </div>
      </main>

      {accountProvider && (
        <AccountPanel
          provider={accountProvider}
          busy={busy}
          onClose={() => setAccountProvider(null)}
          onSubmit={async (input) => {
            const completed = await run(
              () => createAccount({
                ...input,
                dailyLimit: input.dailyLimit ?? undefined,
              }),
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
          onSubmit={async (input) => {
            const completed = await run(
              () => updateAccount(editingAccount.id, {
                name: input.name,
                email: input.email,
                dailyLimit: input.dailyLimit,
                credentials: Object.keys(input.credentials).length > 0 ? input.credentials : undefined,
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
            try {
              const created = await createApiKey(input)
              setRevealedKey(created.rawKey)
              setKeyPanel(false)
              await refresh()
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : 'API anahtarı oluşturulamadı.')
            } finally {
              setBusy(false)
            }
          }}
        />
      )}
      {revealedKey && <OneTimeKey value={revealedKey} onClose={() => setRevealedKey(null)} />}
    </div>
  )
}

function LoginScreen({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [token, setToken] = useState('')
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
      <div className="login-atmosphere" />
      <section className="login-card">
        <div className="login-icon"><ShieldCheck size={28} /></div>
        <p className="eyebrow">Private control plane</p>
        <h1>Chat2API Gateway</h1>
        <p>Sağlayıcı hesaplarını ve erişim anahtarlarını güvenli yönetim oturumundan kontrol edin.</p>
        <form onSubmit={submit}>
          <label htmlFor="admin-token">Yönetici erişim anahtarı</label>
          <input
            id="admin-token"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="current-password"
            required
            minLength={32}
            placeholder="••••••••••••••••"
          />
          {error && <p className="form-error">{error}</p>}
          <button className="primary-button" disabled={busy}>
            {busy ? 'Doğrulanıyor…' : <>Güvenli oturumu aç <ArrowRight size={17} /></>}
          </button>
        </form>
        <div className="login-footnote"><LockKeyhole size={14} /> Oturum 8 saat sonra otomatik kapanır.</div>
      </section>
    </div>
  )
}

function OverviewPage({ data, setView }: { data: DashboardData; setView: (view: View) => void }) {
  const cards = [
    {
      label: 'Aktif sağlayıcı',
      value: `${data.overview.providers.enabled}/${data.overview.providers.total}`,
      detail: `${data.overview.accounts.active} aktif hesap`,
      icon: Layers3,
    },
    {
      label: 'Bugünkü istek',
      value: formatNumber(data.overview.requests.today),
      detail: `%${Math.round(data.overview.requests.successRate * 100)} başarı`,
      icon: Activity,
    },
    {
      label: 'Ortalama gecikme',
      value: `${formatNumber(data.overview.requests.averageLatency)} ms`,
      detail: `${formatNumber(data.overview.requests.total)} toplam istek`,
      icon: CircleGauge,
    },
    {
      label: 'Anlık kapasite',
      value: `${data.overview.gateway.active}/${data.overview.gateway.limit}`,
      detail: `${data.overview.gateway.openCircuits.length} açık devre`,
      icon: Server,
    },
  ]
  const recent = data.activity.slice(0, 7)

  return (
    <>
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Operational status</p>
          <h2>Gateway sağlıklı ve erişim sınırları etkin.</h2>
          <p>Credential’lar şifreli, request body logları kapalı ve tüm istemci trafiği zorunlu API anahtarıyla korunuyor.</p>
        </div>
        <div className="hero-shield"><ShieldCheck size={34} /><span>Hardened</span></div>
      </section>
      <div className="metrics-grid">
        {cards.map((card) => (
          <article className="metric-card" key={card.label}>
            <div className="metric-icon"><card.icon size={19} /></div>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
            <small>{card.detail}</small>
          </article>
        ))}
      </div>
      <div className="two-column">
        <section className="panel">
          <PanelHeader title="Son istekler" subtitle="İçerik değil, yalnız operasyon metadata’sı" action={
            <button className="text-button" onClick={() => setView('activity')}>Tümünü aç <ArrowRight size={15} /></button>
          } />
          <ActivityTable records={recent} compact />
        </section>
        <section className="panel">
          <PanelHeader title="Sağlayıcı durumu" subtitle="Aktif hesap ve model kapsamı" />
          <div className="provider-summary-list">
            {data.providers.slice(0, 6).map((provider) => (
              <div key={provider.id}>
                <ProviderAvatar name={provider.name} />
                <div>
                  <strong>{provider.name}</strong>
                  <span>{provider.supportedModels.length} model</span>
                </div>
                <StatusBadge status={provider.activeAccountCount > 0 ? 'success' : 'neutral'}>
                  {provider.activeAccountCount > 0 ? `${provider.activeAccountCount} aktif` : 'Hesap yok'}
                </StatusBadge>
              </div>
            ))}
          </div>
          <button className="secondary-button full" onClick={() => setView('providers')}>Sağlayıcıları yönet</button>
        </section>
      </div>
    </>
  )
}

function ProvidersPage(props: {
  providers: Provider[]
  accounts: Account[]
  onAdd: (provider: Provider) => void
  onToggle: (provider: Provider) => void
  onAccountToggle: (account: Account) => void
  onAccountEdit: (account: Account) => void
  onAccountTest: (account: Account) => void
  onAccountDelete: (account: Account) => void
}) {
  return (
    <div className="provider-grid">
      {props.providers.map((provider) => {
        const accounts = props.accounts.filter((account) => account.providerId === provider.id)
        return (
          <article className="provider-card" key={provider.id}>
            <div className="provider-card-head">
              <ProviderAvatar name={provider.name} />
              <div>
                <h2>{provider.name}</h2>
                <p>{provider.description}</p>
                <span className={`integration-badge ${provider.integrationMode ?? 'web-session'}`}>
                  {provider.integrationMode === 'official-api' ? 'Resmi API' : 'Web session'}
                  {' · '}öncelik {provider.routingPriority}
                </span>
              </div>
              <button
                className={`switch ${provider.enabled ? 'is-on' : ''}`}
                onClick={() => props.onToggle(provider)}
                aria-label={`${provider.name} ${provider.enabled ? 'kapat' : 'aç'}`}
              ><i /></button>
            </div>
            <div className="model-chips">
              {provider.supportedModels.slice(0, 4).map((model) => <span key={model}>{model}</span>)}
              {provider.supportedModels.length > 4 && <span>+{provider.supportedModels.length - 4}</span>}
            </div>
            <div className="account-list">
              {accounts.length === 0 ? (
                <div className="empty-row"><Database size={17} /> Henüz hesap eklenmedi.</div>
              ) : accounts.map((account) => (
                <div className="account-row" key={account.id}>
                  <div className={`status-dot ${account.status}`} />
                  <div>
                    <strong>{account.name}</strong>
                    <span>{account.todayUsed}/{account.dailyLimit ?? '∞'} bugün</span>
                  </div>
                  <button className="mini-button" onClick={() => props.onAccountToggle(account)}>
                    {account.status === 'active' ? 'Duraklat' : 'Etkinleştir'}
                  </button>
                  {provider.healthCheckSupported && (
                    <button
                      className="icon-button small"
                      onClick={() => props.onAccountTest(account)}
                      aria-label={`${account.name} bağlantısını test et`}
                      title="Bağlantıyı test et"
                    >
                      <Activity size={14} />
                    </button>
                  )}
                  <button className="icon-button small" onClick={() => props.onAccountEdit(account)} aria-label="Hesabı düzenle">
                    <Pencil size={14} />
                  </button>
                  <button className="icon-button small danger" onClick={() => props.onAccountDelete(account)} aria-label="Hesabı sil">
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
            <button className="secondary-button full" onClick={() => props.onAdd(provider)}>
              <Plus size={16} /> Hesap ekle
            </button>
          </article>
        )
      })}
    </div>
  )
}

function ApiKeysPage(props: {
  records: ApiKeyRecord[]
  onCreate: () => void
  onToggle: (record: ApiKeyRecord) => void
  onDelete: (record: ApiKeyRecord) => void
}) {
  return (
    <section className="panel">
      <PanelHeader
        title="İstemci erişim anahtarları"
        subtitle="Raw değer yalnız oluşturulduğu anda gösterilir."
        action={<button className="primary-button compact" onClick={props.onCreate}><Plus size={16} /> Yeni anahtar</button>}
      />
      <div className="responsive-table">
        <table>
          <thead><tr><th>Ad</th><th>Prefix</th><th>Kapsam</th><th>Kota</th><th>Son kullanım</th><th>Durum</th><th /></tr></thead>
          <tbody>
            {props.records.map((record) => (
              <tr key={record.id}>
                <td><strong>{record.name}</strong><small>{formatNumber(record.usageCount)} kullanım</small></td>
                <td><code>{record.keyPrefix}…</code></td>
                <td>{record.scopes.join(', ')}</td>
                <td>{record.requestsPerMinute}/dk · {formatNumber(record.dailyQuota)}/gün</td>
                <td>{formatDate(record.lastUsedAt)}</td>
                <td>
                  <StatusBadge status={record.enabled ? 'success' : 'neutral'}>{record.enabled ? 'Aktif' : 'Kapalı'}</StatusBadge>
                  {record.managedByEnvironment && <small>Ortam tarafından yönetilir</small>}
                </td>
                <td className="table-actions">
                  {!record.managedByEnvironment && (
                    <>
                      <button className="mini-button" onClick={() => props.onToggle(record)}>{record.enabled ? 'Kapat' : 'Aç'}</button>
                      <button className="icon-button small danger" onClick={() => props.onDelete(record)} aria-label="Anahtarı sil"><Trash2 size={15} /></button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {props.records.length === 0 && <div className="empty-state"><KeyRound size={24} /><strong>Henüz API anahtarı yok</strong></div>}
      </div>
    </section>
  )
}

function ActivityPage({ records, accounts }: { records: RequestActivity[]; accounts: Account[] }) {
  const accountNames = new Map(accounts.map((account) => [account.id, account.name]))
  return (
    <section className="panel">
      <PanelHeader title="İstek aktivitesi" subtitle="Prompt, yanıt, header veya credential içeriği saklanmaz." />
      <ActivityTable records={records} accountNames={accountNames} />
    </section>
  )
}

function SecurityPage({
  settings,
  onSave,
}: {
  settings: GatewaySettings
  onSave: (settings: Pick<GatewaySettings, 'loadBalanceStrategy' | 'requestTimeout' | 'sessionTimeout' | 'deleteAfterTimeout'>) => void
}) {
  const [form, setForm] = useState(settings)
  return (
    <div className="settings-layout">
      <section className="panel">
        <PanelHeader title="Yönlendirme politikası" subtitle="Değişiklikler yeni isteklere uygulanır." />
        <form className="settings-form" onSubmit={(event) => {
          event.preventDefault()
          onSave(form)
        }}>
          <Field label="Hesap seçimi">
            <select value={form.loadBalanceStrategy} onChange={(event) => setForm({ ...form, loadBalanceStrategy: event.target.value as GatewaySettings['loadBalanceStrategy'] })}>
              <option value="round-robin">Round robin</option>
              <option value="fill-first">En az kullanılan hesap</option>
              <option value="failover">Sabit öncelik / failover</option>
            </select>
          </Field>
          <div className="form-grid">
            <Field label="İstek timeout (ms)">
              <input type="number" min={1000} max={900000} value={form.requestTimeout} onChange={(event) => setForm({ ...form, requestTimeout: Number(event.target.value) })} />
            </Field>
            <Field label="Oturum timeout (dk)">
              <input type="number" min={1} max={1440} value={form.sessionTimeout} onChange={(event) => setForm({ ...form, sessionTimeout: Number(event.target.value) })} />
            </Field>
          </div>
          <label className="check-row">
            <input type="checkbox" checked={form.deleteAfterTimeout} onChange={(event) => setForm({ ...form, deleteAfterTimeout: event.target.checked })} />
            <span><strong>Süresi dolan provider oturumlarını temizle</strong><small>Yerel session metadata’sını kaldırır.</small></span>
          </label>
          <button className="primary-button">Ayarları kaydet</button>
        </form>
      </section>
      <section className="panel">
        <PanelHeader title="Güvenlik sınırları" subtitle="Runtime tarafından zorunlu tutulan politikalar" />
        <div className="security-list">
          <SecurityItem label="Credential encryption" value={settings.security.credentialEncryption} />
          <SecurityItem label="API key storage" value={settings.security.apiKeyStorage} />
          <SecurityItem label="Request body logs" value={settings.security.requestBodiesLogged ? 'Açık' : 'Kapalı'} good={!settings.security.requestBodiesLogged} />
          <SecurityItem label="Custom providers" value={settings.security.customProvidersEnabled ? 'Açık' : 'Kapalı'} good={!settings.security.customProvidersEnabled} />
          <SecurityItem label="Remote media" value={settings.security.remoteMediaEnabled ? 'Açık' : 'Kapalı'} good={!settings.security.remoteMediaEnabled} />
          <SecurityItem label="Secure cookies" value={settings.security.secureCookies ? 'Zorunlu' : 'Dev modu'} good={settings.security.secureCookies} />
        </div>
        <div className="risk-note">
          <AlertTriangle size={18} />
          <p><strong>Provider kullanım riski</strong> Web oturumu tabanlı adaptörler sağlayıcı şartlarına ve hesap kontrollerine tabidir. Kritik iş yükleri resmi API’lerle yürütülmelidir.</p>
        </div>
      </section>
    </div>
  )
}

function AccountPanel(props: {
  provider: Provider
  account?: Account
  busy: boolean
  onClose: () => void
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
  const [dailyLimit, setDailyLimit] = useState(
    props.account ? String(props.account.dailyLimit ?? '') : '500',
  )
  const [credentials, setCredentials] = useState<Record<string, string>>({})
  const isEditing = Boolean(props.account)

  return (
    <Modal
      title={isEditing ? `${props.account?.name} hesabını düzenle` : `${props.provider.name} hesabı`}
      subtitle={isEditing
        ? 'Mevcut credential gösterilmez. Yalnız değiştirmek istediğiniz alanı doldurun.'
        : 'Credential değeri kaydedildikten sonra tekrar gösterilmez.'}
      onClose={props.onClose}
    >
      <form className="drawer-form" onSubmit={(event) => {
        event.preventDefault()
        const credentialUpdates = Object.fromEntries(
          Object.entries(credentials).filter(([, value]) => value.trim().length > 0),
        )
        void props.onSubmit({
          providerId: props.provider.id,
          name,
          email: email || undefined,
          credentials: credentialUpdates,
          dailyLimit: dailyLimit ? Number(dailyLimit) : isEditing ? null : undefined,
        })
      }}>
        <Field label="Hesap etiketi">
          <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} placeholder="Örn. DeepSeek ana hesap" />
        </Field>
        <div className="form-grid">
          <Field label="E-posta (isteğe bağlı)">
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} />
          </Field>
          <Field label="Günlük istek sınırı" hint={isEditing ? 'Boş bırakırsanız hesap sınırı kaldırılır.' : undefined}>
            <input type="number" min={1} max={1_000_000} value={dailyLimit} onChange={(event) => setDailyLimit(event.target.value)} />
          </Field>
        </div>
        <div className="credential-box">
          <div><LockKeyhole size={16} /><span>AES-256-GCM encrypted storage</span></div>
          {props.provider.credentialFields.map((field) => (
            <Field key={field.name} label={`${field.label}${field.required ? ' *' : ''}`} hint={field.helpText}>
              {field.type === 'textarea' ? (
                <textarea
                  value={credentials[field.name] ?? ''}
                  onChange={(event) => setCredentials({ ...credentials, [field.name]: event.target.value })}
                  required={!isEditing && field.required}
                  rows={4}
                  autoComplete="off"
                  placeholder={field.placeholder}
                />
              ) : (
                <input
                  type={field.type}
                  value={credentials[field.name] ?? ''}
                  onChange={(event) => setCredentials({ ...credentials, [field.name]: event.target.value })}
                  required={!isEditing && field.required}
                  autoComplete="off"
                  placeholder={field.placeholder}
                />
              )}
            </Field>
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={props.onClose}>Vazgeç</button>
          <button className="primary-button" disabled={props.busy}>
            {isEditing ? 'Değişiklikleri kaydet' : 'Hesabı şifreleyip ekle'}
          </button>
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
  }) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [rpm, setRpm] = useState(60)
  const [daily, setDaily] = useState(1000)
  const models = [...new Set(props.providers.flatMap((provider) => provider.supportedModels))].sort()
  const [selectedModels, setSelectedModels] = useState<string[]>([])
  return (
    <Modal title="Yeni API anahtarı" subtitle="Boş model seçimi tüm aktif modellere erişim verir." onClose={props.onClose}>
      <form className="drawer-form" onSubmit={(event) => {
        event.preventDefault()
        void props.onSubmit({
          name,
          scopes: ['chat', 'models'],
          modelAllowlist: selectedModels,
          requestsPerMinute: rpm,
          dailyQuota: daily,
        })
      }}>
        <Field label="Anahtar adı">
          <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} placeholder="Örn. reklam-analiz-codex" />
        </Field>
        <div className="form-grid">
          <Field label="Dakikalık sınır">
            <input type="number" min={1} max={100000} value={rpm} onChange={(event) => setRpm(Number(event.target.value))} />
          </Field>
          <Field label="Günlük kota">
            <input type="number" min={1} max={10000000} value={daily} onChange={(event) => setDaily(Number(event.target.value))} />
          </Field>
        </div>
        <Field label="Model allowlist" hint="Seçim yapmazsanız anahtar tüm aktif modellere erişebilir.">
          <div className="model-selector">
            {models.map((model) => (
              <label key={model}>
                <input
                  type="checkbox"
                  checked={selectedModels.includes(model)}
                  onChange={(event) => setSelectedModels(
                    event.target.checked
                      ? [...selectedModels, model]
                      : selectedModels.filter((entry) => entry !== model),
                  )}
                />
                {model}
              </label>
            ))}
          </div>
        </Field>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={props.onClose}>Vazgeç</button>
          <button className="primary-button" disabled={props.busy}>Anahtarı oluştur</button>
        </div>
      </form>
    </Modal>
  )
}

function OneTimeKey({ value, onClose }: { value: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <Modal title="API anahtarınız hazır" subtitle="Bu değer tekrar gösterilmeyecek." onClose={onClose} narrow>
      <div className="one-time-key">
        <code>{value}</code>
        <button onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true))}>
          {copied ? <Check size={17} /> : <Copy size={17} />} {copied ? 'Kopyalandı' : 'Kopyala'}
        </button>
      </div>
      <div className="risk-note"><AlertTriangle size={18} /><p>Anahtarı yalnız güvenli secret manager’da saklayın. URL, kaynak kod veya sohbet mesajına eklemeyin.</p></div>
      <button className="primary-button full" onClick={onClose}>Kaydettim, kapat</button>
    </Modal>
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
    <div className="responsive-table activity-table">
      <table>
        <thead><tr><th>Durum</th><th>Model</th>{!compact && <th>Hesap</th>}<th>Süre</th><th>Zaman</th></tr></thead>
        <tbody>
          {records.map((record) => (
            <tr key={record.id}>
              <td><StatusBadge status={record.status === 'success' ? 'success' : record.status === 'pending' ? 'warning' : 'danger'}>{record.status}</StatusBadge></td>
              <td><strong>{record.model}</strong><small>{record.isStream ? 'stream' : 'json'} · {record.requestId.slice(0, 8)}</small></td>
              {!compact && <td>{accountNames.get(record.accountId ?? '') ?? record.providerId ?? '—'}</td>}
              <td>{formatNumber(record.latency)} ms</td>
              <td>{formatDate(record.timestamp)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {records.length === 0 && <div className="empty-state"><Activity size={24} /><strong>Henüz istek kaydı yok</strong></div>}
    </div>
  )
}

function PanelHeader({ title, subtitle, action }: { title: string; subtitle: string; action?: ReactNode }) {
  return <div className="panel-header"><div><h2>{title}</h2><p>{subtitle}</p></div>{action}</div>
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>
}

function Modal(props: { title: string; subtitle: string; children: ReactNode; onClose: () => void; narrow?: boolean }) {
  return (
    <div className="modal-layer" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) props.onClose()
    }}>
      <section className={`modal ${props.narrow ? 'narrow' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div className="modal-head">
          <div><h2 id="modal-title">{props.title}</h2><p>{props.subtitle}</p></div>
          <button className="icon-button" onClick={props.onClose} aria-label="Kapat"><X size={19} /></button>
        </div>
        {props.children}
      </section>
    </div>
  )
}

function Banner({ tone, children, onClose }: { tone: 'danger' | 'success'; children: ReactNode; onClose: () => void }) {
  return <div className={`banner ${tone}`}>{tone === 'success' ? <Check size={17} /> : <AlertTriangle size={17} />}<span>{children}</span><button onClick={onClose}><X size={15} /></button></div>
}

function StatusBadge({ status, children }: { status: 'success' | 'danger' | 'warning' | 'neutral'; children: ReactNode }) {
  return <span className={`status-badge ${status}`}>{children}</span>
}

function ProviderAvatar({ name }: { name: string }) {
  return <span className="provider-avatar">{name.slice(0, 2).toUpperCase()}</span>
}

function SecurityItem({ label, value, good = true }: { label: string; value: string; good?: boolean }) {
  return <div><span>{label}</span><strong className={good ? 'good' : 'warning-text'}>{good && <Check size={14} />}{value}</strong></div>
}

function LoadingScreen() {
  return <div className="loading-screen"><div className="brand-mark"><Server size={22} /></div><span>Gateway hazırlanıyor</span></div>
}

function PageSkeleton() {
  return <div className="skeleton-grid">{Array.from({ length: 8 }, (_, index) => <div key={index} />)}</div>
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('tr-TR').format(value)
}

function formatDate(value?: number): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(value)
}
