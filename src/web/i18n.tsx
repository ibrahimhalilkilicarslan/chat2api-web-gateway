import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'

export type Locale = 'tr' | 'en' | 'zh-CN'

export const supportedLocales: ReadonlyArray<{
  code: Locale
  label: string
  shortLabel: string
}> = [
  { code: 'tr', label: 'Türkçe', shortLabel: 'TR' },
  { code: 'en', label: 'English', shortLabel: 'EN' },
  { code: 'zh-CN', label: '简体中文', shortLabel: '中文' },
]

const storageKey = 'c2a-locale'

type Translation = readonly [english: string, simplifiedChinese: string]

export const messageTable: Readonly<Record<string, Translation>> = {
  'Dil': ['Language', '语言'],
  'Arayüz dili': ['Interface language', '界面语言'],
  'Genel bakış': ['Overview', '概览'],
  'Özet': ['Overview', '概览'],
  'Sağlık ve kapasite': ['Health and capacity', '健康与容量'],
  'DeepSeek hesapları': ['DeepSeek accounts', 'DeepSeek 账户'],
  'Hesaplar': ['Accounts', '账户'],
  'Oturum ve kota yönetimi': ['Session and quota management', '会话与配额管理'],
  'API anahtarları': ['API keys', 'API 密钥'],
  'Anahtarlar': ['Keys', '密钥'],
  'İstemci erişim politikaları': ['Client access policies', '客户端访问策略'],
  'İstek aktivitesi': ['Request activity', '请求活动'],
  'Aktivite': ['Activity', '活动'],
  'Teknik kayıtlar ve performans': ['Technical records and performance', '技术记录与性能'],
  'Güvenlik': ['Security', '安全'],
  'Sınırlar ve denetim kayıtları': ['Boundaries and audit records', '边界与审计记录'],
  'Veriler alınamadı.': ['Could not load data.', '无法加载数据。'],
  'İşlem tamamlanamadı.': ['The operation could not be completed.', '操作无法完成。'],
  'Menüyü kapat': ['Close menu', '关闭菜单'],
  'Yönetim menüsü': ['Administration menu', '管理菜单'],
  'İzole çalışma': ['Isolated operation', '隔离运行'],
  'İçerik loglanmaz, sırlar şifrelidir.': [
    'Content is not logged; secrets are encrypted.',
    '不记录内容，敏感信息均已加密。',
  ],
  'Menüyü genişlet': ['Expand menu', '展开菜单'],
  'Menüyü daralt': ['Collapse menu', '收起菜单'],
  'Genişlet': ['Expand', '展开'],
  'Yönetim /': ['Administration /', '管理 /'],
  'Menüyü aç': ['Open menu', '打开菜单'],
  'Hızlı erişim': ['Quick access', '快速访问'],
  'Yenile': ['Refresh', '刷新'],
  'Çıkış yap': ['Sign out', '退出登录'],
  'Veriler hazırlanıyor': ['Preparing data', '正在准备数据'],
  '30 sn otomatik yenile': ['Auto-refresh every 30 sec', '每 30 秒自动刷新'],
  'Hesap durumu güncellendi.': ['Account status updated.', '账户状态已更新。'],
  'Bu oturum başka bir kayıtla aynı DeepSeek hesabına ait. Güvenlik için yalnız tek kayıt kullanılır.': [
    'This session belongs to the same DeepSeek identity as another record. Only one record is used for safety.',
    '此会话与另一条记录属于同一个 DeepSeek 账户。为确保安全，仅使用一条记录。',
  ],
  'Bağlantı testi tamamlanamadı.': [
    'The connection test could not be completed.',
    '无法完成连接测试。',
  ],
  'Hesabı sil': ['Delete account', '删除账户'],
  'API anahtarı güncellendi.': ['API key updated.', 'API 密钥已更新。'],
  'API anahtarı güncellendi': ['API key updated', 'API 密钥已更新'],
  'API anahtarını sil': ['Delete API key', '删除 API 密钥'],
  'Anahtarı sil': ['Delete key', '删除密钥'],
  'Gateway ayarları kaydedildi.': ['Gateway settings saved.', '网关设置已保存。'],
  'Denetim CSV dosyası indirildi.': ['Audit CSV downloaded.', '审计 CSV 已下载。'],
  'API anahtarı oluşturulamadı.': ['Could not create the API key.', '无法创建 API 密钥。'],
  'API anahtarı döndürülemedi.': ['Could not rotate the API key.', '无法轮换 API 密钥。'],
  'API anahtarı politikası güncellendi.': [
    'API key policy updated.',
    'API 密钥策略已更新。',
  ],
  'API anahtarı güncellenemedi.': ['Could not update the API key.', '无法更新 API 密钥。'],
  'Giriş yapılamadı.': ['Sign-in failed.', '登录失败。'],
  'Özel yönetim alanı': ['Private administration area', '专用管理区域'],
  'Yapay zekâ erişimini tek bir güvenli yüzeyden yönetin.': [
    'Manage AI access from one secure surface.',
    '通过一个安全界面管理 AI 访问。',
  ],
  'Hesap sağlığını, istemci anahtarlarını ve istek performansını içerik kaydetmeden izleyin.': [
    'Monitor account health, client keys, and request performance without storing content.',
    '在不存储内容的情况下监控账户健康、客户端密钥和请求性能。',
  ],
  'Şifreli oturumlar': ['Encrypted sessions', '加密会话'],
  'Yalnız teknik kayıt': ['Technical metadata only', '仅技术元数据'],
  'Kapalı varsayılan erişim': ['Fail-closed access', '默认拒绝访问'],
  'Yönetici oturumu': ['Administrator session', '管理员会话'],
  'Kontrol paneline giriş': ['Sign in to the control panel', '登录控制面板'],
  'Kurulum sırasında üretilen yönetici anahtarını girin.': [
    'Enter the administrator key generated during setup.',
    '请输入安装期间生成的管理员密钥。',
  ],
  'Yönetici erişim anahtarı': ['Administrator access key', '管理员访问密钥'],
  'En az 32 karakter': ['At least 32 characters', '至少 32 个字符'],
  'Anahtarı gizle': ['Hide key', '隐藏密钥'],
  'Anahtarı göster': ['Show key', '显示密钥'],
  'Doğrulanıyor': ['Verifying', '正在验证'],
  'Güvenli oturumu aç': ['Open secure session', '开启安全会话'],
  'Oturum çerezi HttpOnly ve SameSite Strict olarak saklanır.': [
    'The session cookie is stored as HttpOnly and SameSite Strict.',
    '会话 Cookie 使用 HttpOnly 和 SameSite Strict 保存。',
  ],
  'DeepSeek hesabı': ['DeepSeek account', 'DeepSeek 账户'],
  'En az bir aktif web oturumu': ['At least one active web session', '至少一个有效的网页会话'],
  'Hesap ekle': ['Add account', '添加账户'],
  'İçe aktar': ['Import', '导入'],
  'Dışa aktar': ['Export', '导出'],
  'İçe aktarma başarısız.': ['Import failed.', '导入失败。'],
  'Bağlantı kontrolü': ['Connection check', '连接检查'],
  'Aktif hesabın oturum doğrulaması': [
    'Session verification for the active account',
    '验证活动账户会话',
  ],
  'Kontrol et': ['Check', '检查'],
  'İstemci anahtarı': ['Client key', '客户端密钥'],
  'OpenAI uyumlu erişim anahtarı': ['OpenAI-compatible access key', 'OpenAI 兼容访问密钥'],
  'Anahtar oluştur': ['Create key', '创建密钥'],
  'Trafik doğrulaması': ['Traffic verification', '流量验证'],
  'Durumu incele': ['Review status', '查看状态'],
  'Aktif hesap': ['Active accounts', '活动账户'],
  'Henüz hesap eklenmedi': ['No account has been added yet', '尚未添加账户'],
  'Hesap durumu normal': ['Account status is normal', '账户状态正常'],
  'Bugünkü istek': ['Requests today', '今日请求'],
  'Bugün henüz trafik yok': ['No traffic yet today', '今日尚无流量'],
  'Ortalama gecikme': ['Average latency', '平均延迟'],
  'Anlık kapasite': ['Current capacity', '当前容量'],
  'Devre kesici normal': ['Circuit breaker is normal', '熔断器正常'],
  'Aktiviteyi incele': ['Review activity', '查看活动'],
  'hazır': ['ready', '已就绪'],
  'Son istekler': ['Recent requests', '最近请求'],
  'Yalnız performans ve durum metadata’sı': [
    'Performance and status metadata only',
    '仅性能和状态元数据',
  ],
  'Tümünü aç': ['View all', '查看全部'],
  'Kurulum durumu': ['Setup status', '设置状态'],
  'OpenAI uyumlu API': ['OpenAI-compatible API', 'OpenAI 兼容 API'],
  'İstemci bağlantısı hazır': ['Client connection is ready', '客户端连接已就绪'],
  'Mevcut OpenAI SDK’nızda yalnız base URL ve API anahtarını değiştirin.': [
    'Change only the base URL and API key in your existing OpenAI SDK.',
    '只需在现有 OpenAI SDK 中更改基础 URL 和 API 密钥。',
  ],
  'Hesap yönetimi': ['Account management', '账户管理'],
  'DeepSeek web oturumlarını yönetin': ['Manage DeepSeek web sessions', '管理 DeepSeek 网页会话'],
  'Hesapları kapasite, sağlık ve kayan pencere kullanımıyla tek ekranda izleyin.': [
    'Monitor capacity, health, and rolling-window usage for every account in one place.',
    '在一个界面中监控所有账户的容量、健康状态和滚动窗口用量。',
  ],
  'Hesap gerekli': ['Account required', '需要账户'],
  'model': ['models', '模型'],
  'Web oturumu': ['Web session', '网页会话'],
  'Oturum tokenı': ['Session token', '会话令牌'],
  'Sağlık kontrolü': ['Health check', '健康检查'],
  'İlk DeepSeek web oturumunu şifreli olarak kaydedin.': [
    'Store the first DeepSeek web session securely.',
    '安全保存第一个 DeepSeek 网页会话。',
  ],
  'İlk hesabı ekle': ['Add the first account', '添加第一个账户'],
  'E-posta etiketi yok': ['No email label', '无邮箱标签'],
  'Bugün': ['Today', '今日'],
  'Günlük limit': ['Daily limit', '每日上限'],
  'Pencere limiti': ['Window limit', '窗口上限'],
  'Bugün başarılı': ['Successful today', '今日成功'],
  'Sınırsız': ['Unlimited', '无限制'],
  'Gecikme': ['Latency', '延迟'],
  'Son kullanım': ['Last used', '上次使用'],
  'Kota kullanımı': ['Quota usage', '配额使用量'],
  'Kayan pencere kullanımı': ['Rolling-window usage', '滚动窗口用量'],
  'İlk kullanım slotu': ['The first usage slot', '首个使用槽位'],
  'geri gelecek.': ['will become available.', '后恢复。'],
  'Devre kesici': ['Circuit breaker', '熔断器'],
  'kapanacak.': ['will close.', '后关闭。'],
  'Bu hesabın oturumu doğrulanamadı. Bağlantıyı yeniden test edin.': [
    'This account session could not be verified. Test the connection again.',
    '无法验证此账户会话，请重新测试连接。',
  ],
  'Bağlantıyı test et': ['Test connection', '测试连接'],
  'Duraklat': ['Pause', '暂停'],
  'Etkinleştir': ['Enable', '启用'],
  'Hesabı düzenle': ['Edit account', '编辑账户'],
  'Başka hesap ekle': ['Add another account', '添加其他账户'],
  'İstemci erişimi': ['Client access', '客户端访问'],
  'İstemci erişimini kontrollü dağıtın': [
    'Distribute client access with clear controls',
    '通过明确控制分配客户端访问',
  ],
  'Her entegrasyon için ayrı anahtar, model kapsamı ve kota tanımlayın.': [
    'Define a separate key, model scope, and quota for each integration.',
    '为每个集成定义独立密钥、模型范围和配额。',
  ],
  'Yeni anahtar': ['New key', '新建密钥'],
  'Anahtar adı veya prefix ara': ['Search by key name or prefix', '按密钥名称或前缀搜索'],
  'API anahtarlarında ara': ['Search API keys', '搜索 API 密钥'],
  'Tümü': ['All', '全部'],
  'Aktif': ['Active', '活动'],
  'Kapalı': ['Disabled', '已停用'],
  'kayıt': ['records', '条记录'],
  'Süresi doldu': ['Expired', '已过期'],
  'Ortam değişkeni': ['Environment variable', '环境变量'],
  'Panel anahtarı': ['Panel key', '面板密钥'],
  'Kapsam': ['Scopes', '权限范围'],
  'Model erişimi': ['Model access', '模型访问'],
  'Dakikalık sınır': ['Per-minute limit', '每分钟上限'],
  'Geçerlilik': ['Validity', '有效期'],
  'Süresiz': ['No expiry', '永不过期'],
  'IP politikası': ['IP policy', 'IP 策略'],
  'Tüm IP’ler': ['All IPs', '所有 IP'],
  'Yeni anahtara geçiş süresinde': ['During the key transition window', '密钥过渡期内'],
  'Rotasyon ile oluşturuldu': ['Created by rotation', '通过轮换创建'],
  'Ortam anahtarı panelden döndürülemez; yalnız acil yönetim ve bootstrap için kullanın.': [
    'Environment keys cannot be rotated in the panel; use them only for emergency administration and bootstrap.',
    '环境密钥不能在面板中轮换，仅用于紧急管理和引导。',
  ],
  'Anahtar': ['Key', '密钥'],
  'sona erecek. İstemci geçişini planlayın.': [
    'will expire. Plan the client migration.',
    '后到期，请规划客户端迁移。',
  ],
  'Günlük kotanın %': ['Daily quota usage is ', '每日配额已使用 '],
  'kadarı kullanıldı.': ['%.', '%。'],
  'Bugünkü kullanım / günlük kota': ['Today / daily quota', '今日用量 / 每日配额'],
  'Toplam': ['Total', '总计'],
  'doğrulanmış istemci isteği': ['verified client requests', '个已验证客户端请求'],
  'Erişimi kapat': ['Disable access', '停用访问'],
  'Erişimi aç': ['Enable access', '启用访问'],
  'Politikayı düzenle': ['Edit policy', '编辑策略'],
  'Döndür': ['Rotate', '轮换'],
  'Henüz API anahtarı yok': ['No API key yet', '尚无 API 密钥'],
  'Eşleşen anahtar bulunamadı': ['No matching key found', '未找到匹配的密钥'],
  'İlk istemci bağlantısı için güvenli bir anahtar oluşturun.': [
    'Create a secure key for the first client connection.',
    '为第一个客户端连接创建安全密钥。',
  ],
  'Arama veya filtreyi değiştirin.': ['Change the search or filter.', '请更改搜索或筛选条件。'],
  'Silinmiş hesap': ['Deleted account', '已删除账户'],
  'Henüz veri yok': ['No data yet', '暂无数据'],
  'İstek izleme': ['Request monitoring', '请求监控'],
  'İstek sağlığını içerik kaydetmeden izleyin': [
    'Monitor request health without storing content',
    '在不存储内容的情况下监控请求健康',
  ],
  'Prompt ve yanıtlar saklanmaz; yalnız durum, model, süre ve anonim istek kimliği gösterilir.': [
    'Prompts and responses are not stored; only status, model, duration, and an anonymous request ID are shown.',
    '不存储提示词和响应，仅显示状态、模型、耗时和匿名请求 ID。',
  ],
  'Görüntülenen': ['Displayed', '已显示'],
  'Başarılı': ['Successful', '成功'],
  'P50 gecikme': ['P50 latency', 'P50 延迟'],
  'P95 gecikme': ['P95 latency', 'P95 延迟'],
  'Hata dağılımı': ['Error distribution', '错误分布'],
  'Hata kaydı yok': ['No error records', '无错误记录'],
  'Operasyon normal': ['Operations normal', '运行正常'],
  'En yoğun hesap': ['Busiest account', '最繁忙账户'],
  'İstek geldikçe hesap dağılımı görünür.': [
    'Account distribution appears as requests arrive.',
    '收到请求后将显示账户分布。',
  ],
  'Maksimum gecikme': ['Maximum latency', '最大延迟'],
  'kayıtlık güvenli metadata örneklemi': ['safe metadata sample', '条安全元数据样本'],
  'Son istek örneklemi': ['Recent request sample', '最近请求样本'],
  'Gecikme dağılımı': ['Latency distribution', '延迟分布'],
  'Model, istek ID veya hata kodu ara': [
    'Search model, request ID, or error code',
    '搜索模型、请求 ID 或错误代码',
  ],
  'Aktivitede ara': ['Search activity', '搜索活动'],
  'Hesaba göre filtrele': ['Filter by account', '按账户筛选'],
  'Tüm hesaplar': ['All accounts', '所有账户'],
  'Hatalı': ['Failed', '失败'],
  'Bekliyor': ['Pending', '等待中'],
  'kayıt gösteriliyor': ['records shown', '条记录已显示'],
  '12 kayıt daha göster': ['Show 12 more', '再显示 12 条'],
  'Oturum saklama': ['Session storage', '会话存储'],
  'API anahtarı saklama': ['API key storage', 'API 密钥存储'],
  'İstek gövdesi logları': ['Request body logs', '请求正文日志'],
  'Açık': ['Enabled', '已启用'],
  'Özel sağlayıcı': ['Custom provider', '自定义提供商'],
  'Uzak medya': ['Remote media', '远程媒体'],
  'Güvenli çerez': ['Secure cookie', '安全 Cookie'],
  'Zorunlu': ['Required', '强制'],
  'Geliştirme modu': ['Development mode', '开发模式'],
  'Güvenlik durumu': ['Security status', '安全状态'],
  'Çalışma sınırları açık ve denetlenebilir': [
    'Runtime boundaries are explicit and auditable',
    '运行边界清晰且可审计',
  ],
  'Çalışma politikaları, yönlendirme stratejisi ve yönetici işlemleri tek ekranda.': [
    'Runtime policies, routing strategy, and administrator actions in one place.',
    '在一个界面中查看运行策略、路由策略和管理员操作。',
  ],
  'Güvenlik standardı': ['Security baseline', '安全基线'],
  'Koruma sınırları etkin': ['Protection boundaries active', '保护边界已启用'],
  'Oturum, API anahtarı ve teknik istek kaydı politikaları beklenen durumda.': [
    'Session, API key, and technical request logging policies are in the expected state.',
    '会话、API 密钥和技术请求日志策略状态正常。',
  ],
  'Etkin': ['Enabled', '已启用'],
  'Trafik yönlendirme': ['Traffic routing', '流量路由'],
  'Yeni isteklerin hesap seçim davranışı': [
    'Account selection behavior for new requests',
    '新请求的账户选择行为',
  ],
  'Round robin': ['Round robin', '轮询'],
  'İstekleri aktif hesaplara sırayla dağıtır.': [
    'Distributes requests across active accounts in sequence.',
    '按顺序将请求分配给活动账户。',
  ],
  'En az kullanılan': ['Least used', '最少使用'],
  'Son kullanım penceresi daha boş hesabı tercih eder.': [
    'Prefers the account with more room in its recent usage window.',
    '优先选择近期使用窗口余量更大的账户。',
  ],
  'Sabit öncelik': ['Fixed priority', '固定优先级'],
  'İlk hesabı kullanır, sorun halinde sıradakine geçer.': [
    'Uses the first account and fails over to the next one if needed.',
    '优先使用第一个账户，出现问题时切换到下一个。',
  ],
  'Değişikliği kaydet': ['Save change', '保存更改'],
  'Çalışma sınırları': ['Runtime boundaries', '运行边界'],
  'Yayına alım sırasında kilitlenen güvenlik politikaları': [
    'Security policies locked at deployment',
    '部署时锁定的安全策略',
  ],
  'İstek zaman aşımı': ['Request timeout', '请求超时'],
  'Akış boşta kalma': ['Stream idle timeout', '流空闲超时'],
  'İstek kapsamı': ['Request scope', '请求范围'],
  'Yalnız metin': ['Text only', '仅文本'],
  'SQLite bakım durumu': ['SQLite maintenance status', 'SQLite 维护状态'],
  'Veri içeriğini açmadan bütünlük ve depolama sağlığı': [
    'Integrity and storage health without exposing data content',
    '在不暴露数据内容的情况下检查完整性和存储健康',
  ],
  'Bütünlük normal': ['Integrity is normal', '完整性正常'],
  'Kontrol gerekli': ['Review required', '需要检查'],
  'Veritabanı': ['Database', '数据库'],
  'WAL dosyası': ['WAL file', 'WAL 文件'],
  'Şema sürümü': ['Schema version', '架构版本'],
  'Journal modu': ['Journal mode', '日志模式'],
  'sayfa ·': ['pages ·', '页 ·'],
  'boş sayfa · bütünlük son kontrolü': ['free pages · last integrity check', '空闲页 · 上次完整性检查'],
  '· içerik ve oturum değerleri bu ekrana taşınmaz.': [
    '· content and session values are never exposed here.',
    '· 此界面不会显示内容或会话值。',
  ],
  'Yönetim denetim günlüğü': ['Administration audit log', '管理审计日志'],
  'CSV indir': ['Download CSV', '下载 CSV'],
  'İşlem, aktör veya hedef ara': ['Search action, actor, or target', '搜索操作、执行者或目标'],
  'Denetim kayıtlarında ara': ['Search audit records', '搜索审计记录'],
  'Başarısız': ['Failed', '失败'],
  'gösteriliyor': ['shown', '已显示'],
  'Henüz denetim kaydı yok': ['No audit record yet', '尚无审计记录'],
  'Filtreyle eşleşen kayıt yok': ['No record matches the filter', '没有符合筛选条件的记录'],
  '10 kayıt daha göster': ['Show 10 more', '再显示 10 条'],
  'Web oturumu sınırı': ['Web-session limitation', '网页会话限制'],
  'DeepSeek web protokolü resmi API değildir ve haber vermeden değişebilir. Ayrı bir hesap kullanın, oturum sağlık kontrollerini izleyin ve bu gateway’i kritik tek sağlayıcı olarak konumlandırmayın.': [
    'The DeepSeek web protocol is not an official API and may change without notice. Use a dedicated account, monitor session health, and do not rely on this gateway as your sole critical provider.',
    'DeepSeek 网页协议并非官方 API，可能会在不通知的情况下变更。请使用专用账户、监控会话健康状态，并不要将此网关作为唯一关键提供商。',
  ],
  'Bağlantı durumu alınamadı.': ['Could not retrieve connection status.', '无法获取连接状态。'],
  'Devam etmek için oturum tokenını girin.': [
    'Enter the session token to continue.',
    '请输入会话令牌以继续。',
  ],
  'Bağlantı doğrulanamadı.': ['The connection could not be verified.', '无法验证连接。'],
  'Bağlantı doğrulanamadı': ['Connection verification failed', '连接验证失败'],
  'Bağlantı kodu panoya alınamadı. Kopyala düğmesini tekrar deneyin.': [
    'Could not copy the connection code. Try the copy button again.',
    '无法复制连接代码，请再次点击复制按钮。',
  ],
  'macOS sürümünde bağlantı kodunu connector uygulamasına yapıştırın.': [
    'On macOS, paste the connection code into the connector application.',
    '在 macOS 上，请将连接代码粘贴到 Connector 应用中。',
  ],
  'Connector açılamadı.': ['Could not open the connector.', '无法打开 Connector。'],
  'Önce hesap etiketini girin.': ['Enter an account label first.', '请先输入账户标签。'],
  'Güvenli bağlantı başlatılamadı.': [
    'Could not start the secure connection.',
    '无法启动安全连接。',
  ],
  'DeepSeek hesabını düzenle': ['Edit DeepSeek account', '编辑 DeepSeek 账户'],
  'DeepSeek hesabı ekle': ['Add DeepSeek account', '添加 DeepSeek 账户'],
  'Şifreli değerler gösterilmez. Token değişikliği kaydedilmeden önce yeniden doğrulanır.': [
    'Encrypted values are never displayed. Token changes are verified before saving.',
    '加密值不会显示，令牌更改会在保存前重新验证。',
  ],
  'Connector DeepSeek girişini açar ve oturumu doğrudan bu gateway’e bağlar.': [
    'The connector opens DeepSeek sign-in and links the session directly to this gateway.',
    'Connector 会打开 DeepSeek 登录并将会话直接连接到此网关。',
  ],
  'Hesap bağlantı adımları': ['Account connection steps', '账户连接步骤'],
  'Connector hazır': ['Connector ready', 'Connector 已就绪'],
  'Güvenli aktarım': ['Secure transfer', '安全传输'],
  'Doğrulama': ['Verification', '验证'],
  'Hesap ayarları': ['Account settings', '账户设置'],
  'Bağlantıyı ayırt etmek için operasyon bilgileri': [
    'Operational details that identify this connection',
    '用于识别此连接的运营信息',
  ],
  'Hesap etiketi *': ['Account label *', '账户标签 *'],
  'Örn. Ana DeepSeek hesabı': ['Example: Primary DeepSeek account', '例如：主 DeepSeek 账户'],
  'E-posta': ['Email', '电子邮箱'],
  'İsteğe bağlı operasyon referansı': ['Optional operational reference', '可选运营参考'],
  'Günlük istek sınırı': ['Daily request limit', '每日请求上限'],
  'Boş değer hesap sınırını kaldırır.': ['Leave blank to remove the account limit.', '留空可移除账户上限。'],
  'Hesap bazlı güvenli tavan': ['Safe per-account ceiling', '账户级安全上限'],
  '15 dakikalık istek bütçesi': ['15-minute request budget', '15 分钟请求预算'],
  'Eski denemeler süre doldukça kademeli çıkar; günlük kilit oluşturmaz.': [
    'Older attempts leave the window gradually; this does not create a daily lock.',
    '较早的尝试会随时间逐步移出窗口，不会形成整日锁定。',
  ],
  'Bağlantı yöntemi': ['Connection method', '连接方式'],
  'Otomatik aktarım önerilir; manuel token yedek yöntemdir': [
    'Automatic transfer is recommended; manual token entry is a fallback.',
    '建议使用自动传输；手动令牌为备用方式。',
  ],
  'Otomatik bağla': ['Connect automatically', '自动连接'],
  'Manuel token': ['Manual token', '手动令牌'],
  'DeepSeek ile güvenli bağlantı': ['Secure connection to DeepSeek', '安全连接 DeepSeek'],
  'Parola ve oturum tokenı admin ekranına girilmez': [
    'Passwords and session tokens are not entered in the admin panel',
    '密码和会话令牌不会输入管理面板',
  ],
  'Windows ve Linux’ta tek tıkla açılır. macOS için bağlantı kodu yedek akışı kullanılabilir.': [
    'Opens with one click on Windows and Linux. A connection-code fallback is available for macOS.',
    'Windows 和 Linux 可一键打开；macOS 可使用连接代码备用流程。',
  ],
  'Connector Windows, macOS ve Linux masaüstü sistemlerini destekler.': [
    'The connector supports Windows, macOS, and Linux desktop systems.',
    'Connector 支持 Windows、macOS 和 Linux 桌面系统。',
  ],
  'Masaüstünde indirin': ['Download on desktop', '在桌面端下载'],
  'Diğer işletim sistemleri': ['Other operating systems', '其他操作系统'],
  'SHA-256 doğrulama': ['SHA-256 verification', 'SHA-256 校验'],
  'İlk kullanım': ['First use', '首次使用'],
  'İşletim sisteminize uygun güncel connector paketini indirin.': [
    'Download the current connector package for your operating system.',
    '下载适用于您操作系统的最新 Connector 软件包。',
  ],
  'Connector’ı bir kez açın; Windows ve Linux bağlantı kaydı otomatik kurulur.': [
    'Open the connector once; protocol registration is automatic on Windows and Linux.',
    '首次打开 Connector；Windows 和 Linux 会自动注册连接协议。',
  ],
  'Aşağıdan bağlantıyı başlatın ve gateway adresini doğrulayın.': [
    'Start the connection below and verify the gateway address.',
    '在下方启动连接并确认网关地址。',
  ],
  'Açılan DeepSeek penceresinde girişi tamamlayın.': [
    'Complete sign-in in the DeepSeek window that opens.',
    '在打开的 DeepSeek 窗口中完成登录。',
  ],
  'Bağlantı hazırlanıyor': ['Preparing connection', '正在准备连接'],
  'Connector ile bağlan': ['Connect with Connector', '使用 Connector 连接'],
  'Hesap bağlandı': ['Account connected', '账户已连接'],
  'Oturum doğrulanıyor': ['Verifying session', '正在验证会话'],
  'Bağlantı süresi doldu': ['Connection expired', '连接已过期'],
  'Connector açıldı': ['Connector opened', 'Connector 已打开'],
  'Connector onayı bekleniyor': ['Waiting for connector approval', '等待 Connector 确认'],
  'Token doğrulandı ve doğrudan şifreli kasaya kaydedildi.': [
    'The token was verified and stored directly in the encrypted vault.',
    '令牌已验证并直接保存到加密保险库。',
  ],
  'Connector penceresindeki gateway adresini onaylayıp DeepSeek girişini tamamlayın.': [
    'Confirm the gateway address in the connector window and complete DeepSeek sign-in.',
    '请在 Connector 窗口确认网关地址并完成 DeepSeek 登录。',
  ],
  'Connector açılmadıysa aşağıdaki düğmeyle yeniden deneyin veya kodu kopyalayın.': [
    'If the connector did not open, try again below or copy the code.',
    '如果 Connector 未打开，请在下方重试或复制代码。',
  ],
  'Connector’ı yeniden aç': ['Reopen Connector', '重新打开 Connector'],
  'Connector’ı aç': ['Open Connector', '打开 Connector'],
  'Kod panoda': ['Code copied', '代码已复制'],
  'Manuel kodu kopyala': ['Copy manual code', '复制手动代码'],
  'Bağlantıyı iptal et': ['Cancel connection', '取消连接'],
  'Connector kişisel tarayıcı profilinizi, parolanızı, OTP kodunuzu veya geçmişinizi okuyamaz. Geçici profil işlem sonunda silinir; web tokenı yalnız onayladığınız gateway’in tek kullanımlık endpointine gönderilir.': [
    'The connector cannot read your personal browser profile, password, OTP, or history. Its temporary profile is deleted afterward, and the web token is sent only to the one-time endpoint of the gateway you approve.',
    'Connector 无法读取您的个人浏览器配置、密码、OTP 或历史记录。临时配置会在完成后删除，网页令牌只会发送到您确认的网关一次性端点。',
  ],
  'Token yalnız şifreli kasaya kaydedilir ve tekrar gösterilmez': [
    'The token is stored only in the encrypted vault and is never shown again',
    '令牌仅保存到加密保险库，之后不再显示',
  ],
  'AES-256-GCM ile şifreli saklama': ['Encrypted at rest with AES-256-GCM', '使用 AES-256-GCM 加密存储'],
  'Tokenı gizle': ['Hide token', '隐藏令牌'],
  'Tokenı göster': ['Show token', '显示令牌'],
  'Manuel token nasıl bulunur?': ['How do I find the manual token?', '如何找到手动令牌？'],
  'DeepSeek sekmesinde hesabınıza giriş yapın.': [
    'Sign in to your account in the DeepSeek tab.',
    '在 DeepSeek 标签页中登录您的账户。',
  ],
  'Network panelinde': ['In the Network panel, open the', '在网络面板中打开'],
  'isteğini açın.': ['request.', '请求。'],
  'değerini bu alana yapıştırın.': ['value into this field.', '值粘贴到此字段。'],
  'Parola, cookie dosyası veya HAR yüklemeyin.': [
    'Do not upload a password, cookie file, or HAR.',
    '请勿上传密码、Cookie 文件或 HAR。',
  ],
  'Bağlantı doğrulaması': ['Connection verification', '连接验证'],
  'Geçersiz token kaydedilmez': ['Invalid tokens are not saved', '无效令牌不会保存'],
  'Oturum doğrulandı': ['Session verified', '会话已验证'],
  'Doğrulamaya hazır': ['Ready to verify', '可以验证'],
  'Mevcut token korunacak': ['Current token will be preserved', '将保留当前令牌'],
  'Token bekleniyor': ['Waiting for token', '等待令牌'],
  'Tokenı değiştirmiyorsanız yeniden doğrulama gerekmez.': [
    'No re-verification is needed if you are not changing the token.',
    '如果不更改令牌，则无需重新验证。',
  ],
  'Kayıttan önce yalnız oturum sağlık kontrolü yapılır.': [
    'Only session health is checked before saving.',
    '保存前仅检查会话健康状态。',
  ],
  'Kontrol ediliyor': ['Checking', '正在检查'],
  'Tekrar doğrula': ['Verify again', '重新验证'],
  'Bağlantıyı doğrula': ['Verify connection', '验证连接'],
  'Kapat': ['Close', '关闭'],
  'Vazgeç': ['Cancel', '取消'],
  'Kaydediliyor': ['Saving', '正在保存'],
  'Değişiklikleri kaydet': ['Save changes', '保存更改'],
  'Doğrulanmış hesabı ekle': ['Add verified account', '添加已验证账户'],
  'Yeni API anahtarı': ['New API key', '新建 API 密钥'],
  'İstemciye yalnız ihtiyaç duyduğu kapsamı ve kotayı verin.': [
    'Grant the client only the scopes and quota it needs.',
    '仅授予客户端所需的权限范围和配额。',
  ],
  'İstemci kimliği': ['Client identity', '客户端标识'],
  'Anahtarın nerede kullanıldığını net adlandırın': [
    'Use a clear name for where the key is used',
    '清楚标明密钥的使用位置',
  ],
  'Anahtar adı': ['Key name', '密钥名称'],
  'Örn. reklam-analiz-codex': ['Example: ads-analytics-codex', '例如：ads-analytics-codex'],
  'Kota politikası': ['Quota policy', '配额策略'],
  'İstemci bazlı hız ve günlük kullanım sınırı': [
    'Per-client rate and daily usage limits',
    '客户端级速率和每日用量限制',
  ],
  'Günlük kota': ['Daily quota', '每日配额'],
  'Erişim sınırları': ['Access boundaries', '访问边界'],
  'Süre ve kaynak ağı politikası': ['Expiry and source network policy', '有效期和来源网络策略'],
  'Anahtar geçerliliği': ['Key validity', '密钥有效期'],
  '30 gün': ['30 days', '30 天'],
  '90 gün': ['90 days', '90 天'],
  '180 gün': ['180 days', '180 天'],
  '1 yıl': ['1 year', '1 年'],
  'IP / CIDR allowlist': ['IP / CIDR allowlist', 'IP / CIDR 允许列表'],
  'Boş bırakılırsa tüm kaynak IP’ler kabul edilir.': [
    'Leave blank to accept all source IPs.',
    '留空则接受所有来源 IP。',
  ],
  'Seçim yoksa tüm aktif modeller kullanılabilir': [
    'All active models are available when none are selected',
    '未选择时可使用所有活动模型',
  ],
  'Oluşturuluyor': ['Creating', '正在创建'],
  'Anahtarı oluştur': ['Create key', '创建密钥'],
  'API anahtarını güvenle döndür': ['Rotate API key safely', '安全轮换 API 密钥'],
  'Geçiş penceresi': ['Transition window', '过渡窗口'],
  'Eski istemcilerin yeni anahtara taşınma süresi': [
    'Time for existing clients to move to the new key',
    '现有客户端迁移到新密钥的时间',
  ],
  'Eski anahtarın çalışacağı ek süre': ['Old-key grace period', '旧密钥宽限期'],
  'Hemen kapat': ['Disable immediately', '立即停用'],
  '15 dakika': ['15 minutes', '15 分钟'],
  '1 saat': ['1 hour', '1 小时'],
  '1 gün': ['1 day', '1 天'],
  '7 gün': ['7 days', '7 天'],
  'Yeni anahtarın geçerliliği': ['New-key validity', '新密钥有效期'],
  'Yeni raw anahtar yalnız bir kez gösterilir. Eski anahtar seçilen geçiş süresi sonunda otomatik olarak geçersiz olur.': [
    'The new raw key is shown once. The old key is disabled automatically when the selected transition window ends.',
    '新的原始密钥只显示一次。所选过渡期结束后，旧密钥将自动失效。',
  ],
  'Döndürülüyor': ['Rotating', '正在轮换'],
  'Yeni anahtarı üret': ['Generate new key', '生成新密钥'],
  'API anahtarı politikası': ['API key policy', 'API 密钥策略'],
  'Kota ve süre': ['Quota and expiry', '配额与有效期'],
  'İstemcinin operasyon sınırları': ['Client operational boundaries', '客户端运行边界'],
  'Dakikalık istek': ['Requests per minute', '每分钟请求数'],
  'Geçerlilik sonu': ['Expires at', '到期时间'],
  'Boş bırakılırsa süresiz olur.': ['Leave blank for no expiry.', '留空则永不过期。'],
  'Her satıra bir IP veya CIDR; boş değer tüm kaynaklara izin verir.': [
    'One IP or CIDR per line; blank allows all sources.',
    '每行一个 IP 或 CIDR；留空允许所有来源。',
  ],
  'Seçim yoksa tüm aktif modeller': ['All active models when none are selected', '未选择时使用所有活动模型'],
  'Politikayı kaydet': ['Save policy', '保存策略'],
  'API anahtarı oluşturuldu': ['API key created', 'API 密钥已创建'],
  'Raw değer yalnız bu ekranda bir kez gösterilir.': [
    'The raw value is shown once on this screen.',
    '原始值只在此界面显示一次。',
  ],
  'Kopyalandı': ['Copied', '已复制'],
  'Kopyala': ['Copy', '复制'],
  'İstemci ortam değişkenleri': ['Client environment variables', '客户端环境变量'],
  'Örnek kopyalandı': ['Example copied', '示例已复制'],
  'Kurulum örneğini kopyala': ['Copy setup example', '复制设置示例'],
  'Anahtarı secret manager’da saklayın. Kaynak kod, URL veya sohbet mesajına eklemeyin.': [
    'Store the key in a secret manager. Do not place it in source code, URLs, or chat messages.',
    '请将密钥保存在密钥管理器中，不要放入源代码、URL 或聊天消息。',
  ],
  'Anahtarı güvenle sakladım': ['I stored the key securely', '我已安全保存密钥'],
  'Bu işlem geri alınamaz.': ['This action cannot be undone.', '此操作无法撤销。'],
  'Devam etmeden önce bağlı istemci ve operasyon etkisini doğrulayın.': [
    'Verify the connected client and operational impact before continuing.',
    '继续之前，请确认已连接客户端及其运营影响。',
  ],
  'İşleniyor': ['Processing', '正在处理'],
  'Yeni web oturumu kaydet': ['Store a new web session', '保存新的网页会话'],
  'API anahtarı oluştur': ['Create API key', '创建 API 密钥'],
  'Yeni istemci erişimi tanımla': ['Define new client access', '定义新的客户端访问'],
  'Verileri yenile': ['Refresh data', '刷新数据'],
  'Paneli yeniden yükle': ['Reload the panel', '重新加载面板'],
  'Sayfa veya işlem ara': ['Search pages or actions', '搜索页面或操作'],
  'Eşleşen işlem bulunamadı.': ['No matching action found.', '未找到匹配的操作。'],
  'İlk sonucu açmak için Enter': ['Press Enter to open the first result', '按 Enter 打开第一项结果'],
  'Durum': ['Status', '状态'],
  'Model / istek': ['Model / request', '模型 / 请求'],
  'Hesap': ['Account', '账户'],
  'Süre': ['Duration', '耗时'],
  'Zaman': ['Time', '时间'],
  'Henüz istek kaydı yok': ['No request records yet', '尚无请求记录'],
  'İlk istemci çağrısı burada görünecek.': [
    'The first client call will appear here.',
    '第一个客户端调用会显示在这里。',
  ],
  'Mobil yönetim menüsü': ['Mobile administration menu', '移动端管理菜单'],
  'İstek geldikçe grafik oluşur.': [
    'The chart appears as requests arrive.',
    '收到请求后将生成图表。',
  ],
  'Son istek gecikme grafiği': ['Recent request latency chart', '最近请求延迟图'],
  'Yapılandırma': ['Configuration', '配置'],
  'Güvenli işlem': ['Secure action', '安全操作'],
  'Bildirimi kapat': ['Dismiss notification', '关闭通知'],
  'Gateway hazırlanıyor': ['Preparing gateway', '正在准备网关'],
  'Kurulum gerekli': ['Setup required', '需要设置'],
  'Başlangıç adımı': ['Getting started', '开始设置'],
  'İlk DeepSeek hesabınızı bağlayın.': [
    'Connect your first DeepSeek account.',
    '连接您的第一个 DeepSeek 账户。',
  ],
  'Gateway çalışıyor; istemci trafiği almadan önce şifreli bir web oturumu ekleyin ve bağlantıyı doğrulayın.': [
    'The gateway is running. Add an encrypted web session and verify it before accepting client traffic.',
    '网关正在运行。接收客户端流量前，请添加加密网页会话并完成验证。',
  ],
  'Hesapları aç': ['Open accounts', '打开账户'],
  'Hesap kapalı': ['Account disabled', '账户已停用'],
  'Aktif hesap gerekli': ['Active account required', '需要活动账户'],
  'DeepSeek hesabı etkinleştirilmeden trafik alınamaz.': [
    'Traffic cannot be accepted until a DeepSeek account is enabled.',
    '启用 DeepSeek 账户后才能接收流量。',
  ],
  'Mevcut hesabı etkinleştirin veya yeni bir oturumu doğrulayarak ekleyin.': [
    'Enable the existing account or verify and add a new session.',
    '请启用现有账户，或验证并添加新会话。',
  ],
  'Trafik kısıtlı': ['Traffic limited', '流量受限'],
  'DeepSeek hız sınırı': ['DeepSeek rate limit', 'DeepSeek 速率限制'],
  'DeepSeek yeni istekleri geçici olarak sınırlıyor.': [
    'DeepSeek is temporarily limiting new requests.',
    'DeepSeek 正在临时限制新请求。',
  ],
  'Oturum geçerli; gerçek üretim çağrıları geçici olarak sınırlandırılıyor. Aktivite kayıtlarından sağlayıcı durumunu izleyin.': [
    'The session is valid, but real requests are temporarily limited. Monitor provider status in activity records.',
    '会话有效，但实际请求暂时受限。请在活动记录中监控提供商状态。',
  ],
  'Dikkat gerekli': ['Attention required', '需要处理'],
  'Operasyon uyarısı': ['Operational warning', '运行警告'],
  'Sorunu incele': ['Review issue', '查看问题'],
  'Kontrol bekliyor': ['Awaiting check', '等待检查'],
  'Oturum doğrulaması': ['Session verification', '会话验证'],
  'Oturum geçerli; ilk gerçek gateway isteği bekleniyor.': [
    'The session is valid; waiting for the first real gateway request.',
    '会话有效，正在等待第一个实际网关请求。',
  ],
  'Gateway hazır; hesap sağlığını doğrulayın.': [
    'The gateway is ready; verify account health.',
    '网关已就绪，请验证账户健康状态。',
  ],
  'Sağlık kontrolü yalnız oturumu doğrular. Operasyonel hazır durumu için istemci anahtarıyla başarılı bir metin isteği tamamlayın.': [
    'A health check validates only the session. Complete a successful text request with a client key to confirm operational readiness.',
    '健康检查仅验证会话。请使用客户端密钥完成一次成功的文本请求，以确认运行就绪。',
  ],
  'Aktif oturum mevcut ancak son oturum sağlık kontrolü henüz tamamlanmamış.': [
    'An active session exists, but its latest health check has not completed.',
    '存在活动会话，但最近的健康检查尚未完成。',
  ],
  'Bağlantıyı kur': ['Set up connection', '设置连接'],
  'Operasyonel': ['Operational', '运行正常'],
  'Tüm sistemler normal': ['All systems normal', '所有系统正常'],
  'Gateway trafiği güvenle karşılamaya hazır.': [
    'The gateway is ready to handle traffic securely.',
    '网关已准备好安全处理流量。',
  ],
  'Aktif hesaplar sağlıklı, erişim sınırları etkin ve istek gövdeleri operasyon loglarına yazılmıyor.': [
    'Active accounts are healthy, access boundaries are enforced, and request bodies are not written to operational logs.',
    '活动账户健康、访问边界已启用，并且请求正文不会写入运行日志。',
  ],
  'Canlı aktivite': ['Live activity', '实时活动'],
  'Gerçek trafik doğrulandı': ['Real traffic verified', '实际流量已验证'],
  'Aktif DeepSeek hesabı gerekli': ['An active DeepSeek account is required', '需要活动的 DeepSeek 账户'],
  'Oturum kontrolü gerekli': ['Session check required', '需要会话检查'],
  'İlk başarılı istek bekleniyor': ['Waiting for the first successful request', '等待第一个成功请求'],
  'DeepSeek istekleri geçici olarak sınırlıyor': [
    'DeepSeek is temporarily limiting requests',
    'DeepSeek 正在临时限制请求',
  ],
  'Oturum tokenı geçersiz veya süresi dolmuş': [
    'The session token is invalid or expired',
    '会话令牌无效或已过期',
  ],
  'DeepSeek erişilemiyor': ['DeepSeek is unavailable', '无法访问 DeepSeek'],
  'DeepSeek yanıt süresi aşıldı': ['DeepSeek timed out', 'DeepSeek 响应超时'],
  'DeepSeek web protokolü kontrol edilmeli': [
    'The DeepSeek web protocol needs review',
    '需要检查 DeepSeek 网页协议',
  ],
  'Kullanılabilir hesap bulunamadı': ['No usable account found', '未找到可用账户'],
  'Hesapların kısa dönem kullanım bütçesi doldu': [
    'The short-term account usage budget is exhausted',
    '账户短期使用预算已耗尽',
  ],
  'DeepSeek oturumu yeniden bağlanmalı.': [
    'The DeepSeek session must be reconnected.',
    '必须重新连接 DeepSeek 会话。',
  ],
  'DeepSeek web bağlantısı teknik kontrol bekliyor.': [
    'The DeepSeek web connection needs technical review.',
    'DeepSeek 网页连接需要技术检查。',
  ],
  'DeepSeek yanıt süresi operasyon sınırını aştı.': [
    'DeepSeek exceeded the operational response-time limit.',
    'DeepSeek 超过了运行响应时间限制。',
  ],
  'Trafiği karşılayacak kullanılabilir hesap yok.': [
    'No usable account can handle traffic.',
    '没有可处理流量的账户。',
  ],
  'DeepSeek hesabı yoğun; istek sırada tamamlanamadı.': [
    'The DeepSeek account is busy and the queued request timed out.',
    'DeepSeek 账户繁忙，排队请求已超时。',
  ],
  'Hesap kapasitesi kısa süreliğine dinleniyor.': [
    'Account capacity is cooling down briefly.',
    '账户容量正在短暂冷却。',
  ],
  'DeepSeek bağlantısı geçici olarak kullanılamıyor.': [
    'The DeepSeek connection is temporarily unavailable.',
    'DeepSeek 连接暂时不可用。',
  ],
  'Şifreli oturum tokenını güncelleyin ve kaydetmeden önce bağlantı doğrulamasını tamamlayın.': [
    'Update the encrypted session token and verify the connection before saving.',
    '请更新加密会话令牌，并在保存前完成连接验证。',
  ],
  'Oturum sağlıklı görünse bile gerçek istek başarısız oldu. Sağlayıcı adaptörünü ve son aktivite kodunu inceleyin.': [
    'The real request failed even though the session appears healthy. Review the provider adapter and latest activity code.',
    '尽管会话看似健康，实际请求仍失败。请检查提供商适配器和最新活动代码。',
  ],
  'Hesap durumu, günlük kota ve devre kesici bilgilerini birlikte kontrol edin.': [
    'Review account status, daily quota, and circuit-breaker information together.',
    '请同时检查账户状态、每日配额和熔断器信息。',
  ],
  'Ön plan taslakları arka plan analizlerinden önce çalışır; kuyruk süresi dolarsa istemci kısa süre sonra yeniden denemelidir.': [
    'Foreground drafts run before background analysis; clients should retry shortly after a queue timeout.',
    '前台草稿优先于后台分析；队列超时后，客户端应稍后重试。',
  ],
  'Son 15 dakikadaki eski istekler pencereden çıktıkça kapasite otomatik ve kademeli olarak geri gelir.': [
    'Capacity returns automatically and gradually as older requests leave the 15-minute window.',
    '随着较早请求移出 15 分钟窗口，容量会自动逐步恢复。',
  ],
  'Beklemede': ['Waiting', '等待中'],
  'Sağlıklı': ['Healthy', '健康'],
  'Duraklatıldı': ['Paused', '已暂停'],
  'Oturum geçersiz veya süresi dolmuş': ['Session invalid or expired', '会话无效或已过期'],
  'DeepSeek bağlantısına ulaşılamıyor': ['Cannot reach DeepSeek', '无法连接 DeepSeek'],
  'DeepSeek bağlantı yöntemi değişmiş olabilir': [
    'The DeepSeek connection method may have changed',
    'DeepSeek 连接方式可能已更改',
  ],
  'Kullanılabilir hesap yok': ['No usable account', '无可用账户'],
  'Kısa dönem hesap bütçesi doldu': ['Short-term account budget exhausted', '账户短期预算已耗尽'],
  'Ön plan için hesap kapasitesi ayrıldı': [
    'Account capacity reserved for foreground work',
    '已为前台任务保留账户容量',
  ],
  'Sağlayıcı isteği sınırladı': ['Provider rate-limited the request', '提供商限制了请求'],
  'Oturum doğrulanamadı': ['Session verification failed', '会话验证失败'],
  'Sağlayıcıya ulaşılamadı': ['Provider unavailable', '无法访问提供商'],
  'Yanıt süresi aşıldı': ['Request timed out', '响应超时'],
  'Bağlantı protokolü değişti': ['Connection protocol changed', '连接协议已更改'],
  'Tanımlanamayan hata': ['Unknown error', '未知错误'],
  'Oturum kapatıldı': ['Session closed', '会话已关闭'],
  'Sağlayıcı hesabı eklendi': ['Provider account added', '已添加提供商账户'],
  'Sağlayıcı hesabı güncellendi': ['Provider account updated', '已更新提供商账户'],
  'Sağlayıcı hesabı silindi': ['Provider account deleted', '已删除提供商账户'],
  'Oturum sağlık kontrolü': ['Session health check', '会话健康检查'],
  'Kaydetmeden önce oturum doğrulaması': [
    'Session verification before save',
    '保存前会话验证',
  ],
  'API anahtarı döndürüldü': ['API key rotated', 'API 密钥已轮换'],
  'API anahtarı silindi': ['API key deleted', 'API 密钥已删除'],
  'API anahtarı silindi.': ['API key deleted.', 'API 密钥已删除。'],
  'Gateway ayarı güncellendi': ['Gateway setting updated', '网关设置已更新'],
  'Henüz yok': ['Not yet', '暂无'],
  'birazdan': ['shortly', '即将'],
  'şimdi': ['now', '现在'],
  'Süre dolmak üzere': ['Expiring now', '即将到期'],
  'DeepSeek web oturumunu izole ve metin tabanlı Chat Completions API yüzeyine dönüştürür.': [
    'Converts an isolated DeepSeek web session into a text-only Chat Completions API surface.',
    '将隔离的 DeepSeek 网页会话转换为纯文本 Chat Completions API 接口。',
  ],
  'Bearer ... veya yalnız token değeri': [
    'Bearer ... or the token value only',
    'Bearer ... 或仅令牌值',
  ],
  'Yalnız bu gateway için ayrılmış ve size ait yetkili bir DeepSeek hesabının tokenını kullanın.': [
    'Use a token from an authorized DeepSeek account you own and dedicate to this gateway.',
    '请使用您拥有并专用于此网关的已授权 DeepSeek 账户令牌。',
  ],
  'Veri merkezi ve web otomasyonu riski': [
    'Datacenter and web automation risk',
    '数据中心与网页自动化风险',
  ],
  'DeepSeek web oturumları resmi API değildir. VPS/veri merkezi IP’leri ile otomatik veya yüksek frekanslı kullanım sağlayıcı tarafından sınırlandırılabilir. Proxy rotasyonu ve anti-detection desteklenmez; yalnız yetkili hesapları ve sağlayıcının izin verdiği kullanım biçimini kullanın.': [
    'DeepSeek web sessions are not an official API. Automated or high-frequency use from VPS or datacenter IPs may be restricted by the provider. Proxy rotation and anti-detection are not supported; use only authorized accounts and provider-permitted workflows.',
    'DeepSeek 网页会话并非官方 API。通过 VPS 或数据中心 IP 进行自动化或高频使用可能会受到提供商限制。本项目不支持代理轮换或反检测；请仅使用已授权账户和提供商允许的工作方式。',
  ],
  'Hesap askıda': ['Account suspended', '账户已暂停'],
  'Sağlayıcı kısıtlaması': ['Provider restriction', '提供商限制'],
  'DeepSeek hesabı geçici olarak askıya alınmış.': [
    'The DeepSeek account is temporarily suspended.',
    'DeepSeek 账户已被暂时暂停。',
  ],
  'Sağlayıcı hesabı kullanım dışı bıraktı. DeepSeek web arayüzündeki hesap bildirimini inceleyin.': [
    'The provider disabled the account. Review the account notice in the DeepSeek web interface.',
    '提供商已停用该账户。请查看 DeepSeek 网页界面中的账户通知。',
  ],
  'Askıyı incele': ['Review suspension', '查看暂停状态'],
  'DeepSeek hesabı sağlayıcı tarafından askıya alındı': [
    'The DeepSeek account was suspended by the provider',
    'DeepSeek 账户已被提供商暂停',
  ],
  'Hesap sağlayıcı tarafından geçici olarak kısıtlandı. Askı süresi dolmadan otomatik istek göndermeyin.': [
    'The account was temporarily restricted by the provider. Do not send automated requests before the suspension expires.',
    '该账户已被提供商暂时限制。暂停期结束前请勿发送自动请求。',
  ],
  'Askıda': ['Suspended', '已暂停'],
  'Sağlayıcı hesabı askıya aldı': [
    'Provider suspended the account',
    '提供商已暂停账户',
  ],
}

interface DynamicPattern {
  pattern: RegExp
  english: (...values: string[]) => string
  simplifiedChinese: (...values: string[]) => string
}

const dynamicPatterns: readonly DynamicPattern[] = [
  {
    pattern: /^Sağlayıcının belirttiği bekleme süresi (.+) dolacak\. Bu tarihten önce otomatik deneme göndermeyin\.$/,
    english: (value) => `The provider wait period will end ${value}. Do not send automated checks before then.`,
    simplifiedChinese: (value) => `提供商规定的等待期将在${value}结束。在此之前请勿发送自动检查。`,
  },
  {
    pattern: /^Son güncelleme (.+)$/,
    english: (value) => `Last updated ${value}`,
    simplifiedChinese: (value) => `上次更新 ${value}`,
  },
  {
    pattern: /^Son başarılı istek (.+)$/,
    english: (value) => `Last successful request ${value}`,
    simplifiedChinese: (value) => `上次成功请求 ${value}`,
  },
  {
    pattern: /^(\d+) hesap dikkat istiyor$/,
    english: (count) => `${count} account${count === '1' ? '' : 's'} need attention`,
    simplifiedChinese: (count) => `${count} 个账户需要处理`,
  },
  {
    pattern: /^%(\d+) bugün başarılı$/,
    english: (percent) => `${percent}% successful today`,
    simplifiedChinese: (percent) => `今日成功率 ${percent}%`,
  },
  {
    pattern: /^(.+) toplam istek$/,
    english: (count) => `${count} total requests`,
    simplifiedChinese: (count) => `共 ${count} 个请求`,
  },
  {
    pattern: /^(\d+) açık devre$/,
    english: (count) => `${count} open circuit${count === '1' ? '' : 's'}`,
    simplifiedChinese: (count) => `${count} 个熔断器开启`,
  },
  {
    pattern: /^(\d+) \/ (\d+) adım tamamlandı$/,
    english: (complete, total) => `${complete} of ${total} steps complete`,
    simplifiedChinese: (complete, total) => `已完成 ${complete}/${total} 步`,
  },
  {
    pattern: /^(\d+) aktif$/,
    english: (count) => `${count} active`,
    simplifiedChinese: (count) => `${count} 个活动`,
  },
  {
    pattern: /^(\d+) (model|kayıt|kural)$/,
    english: (count, unit) => `${count} ${unit === 'model' ? 'models' : unit === 'kural' ? 'rules' : 'records'}`,
    simplifiedChinese: (count, unit) => `${count} ${unit === 'model' ? '个模型' : unit === 'kural' ? '条规则' : '条记录'}`,
  },
  {
    pattern: /^(\d+) başarısız istek$/,
    english: (count) => `${count} failed requests`,
    simplifiedChinese: (count) => `${count} 个失败请求`,
  },
  {
    pattern: /^(.+) istek$/,
    english: (count) => `${count} requests`,
    simplifiedChinese: (count) => `${count} 个请求`,
  },
  {
    pattern: /^(\d+) kayıt · hassas değer içermeyen işlem izi$/,
    english: (count) => `${count} records · action trail without sensitive values`,
    simplifiedChinese: (count) => `${count} 条记录 · 不含敏感值的操作轨迹`,
  },
  {
    pattern: /^(\d+) aktivite kaydı yüklü$/,
    english: (count) => `${count} activity records loaded`,
    simplifiedChinese: (count) => `已加载 ${count} 条活动记录`,
  },
  {
    pattern: /^(.+) için indir$/,
    english: (platform) => `Download for ${platform}`,
    simplifiedChinese: (platform) => `下载 ${platform} 版本`,
  },
  {
    pattern: /^(.+) hesabı ve şifreli oturum bilgisi kalıcı olarak silinecek\.$/,
    english: (name) => `${name} and its encrypted session data will be permanently deleted.`,
    simplifiedChinese: (name) => `${name} 及其加密会话数据将被永久删除。`,
  },
  {
    pattern: /^(.+) anahtarını kullanan istemciler anında erişimi kaybedecek\.$/,
    english: (name) => `Clients using ${name} will immediately lose access.`,
    simplifiedChinese: (name) => `使用 ${name} 的客户端将立即失去访问权限。`,
  },
  {
    pattern: /^(.+) hesabı güvenli bağlantıyla eklendi\.$/,
    english: (name) => `${name} was added through a secure connection.`,
    simplifiedChinese: (name) => `${name} 已通过安全连接添加。`,
  },
  {
    pattern: /^(.+) hesabı eklendi\.$/,
    english: (name) => `${name} account added.`,
    simplifiedChinese: (name) => `已添加 ${name} 账户。`,
  },
  {
    pattern: /^(.+) hesabı güncellendi\.$/,
    english: (name) => `${name} account updated.`,
    simplifiedChinese: (name) => `已更新 ${name} 账户。`,
  },
  {
    pattern: /^(.+) için aynı kota, model ve IP politikalarıyla yeni bir anahtar üretilecek\.$/,
    english: (name) => `A new key for ${name} will be generated with the same quota, model, and IP policies.`,
    simplifiedChinese: (name) => `将为 ${name} 生成具有相同配额、模型和 IP 策略的新密钥。`,
  },
  {
    pattern: /^(.+) için erişim sınırlarını güncelleyin\. Raw anahtar bu işlemde okunmaz veya değişmez\.$/,
    english: (name) => `Update access boundaries for ${name}. This action does not read or change the raw key.`,
    simplifiedChinese: (name) => `更新 ${name} 的访问边界。此操作不会读取或更改原始密钥。`,
  },
  {
    pattern: /^Oturum geçerli; trafik devre kesici tarafından korunuyor\. Yeniden deneme (.+) mümkün olacak\.$/,
    english: (value) => `The session is valid and traffic is protected by the circuit breaker. Retry will be available ${value}.`,
    simplifiedChinese: (value) => `会话有效，流量受熔断器保护。可在 ${value} 后重试。`,
  },
  {
    pattern: /^(\d+) sa (\d+) dk kaldı$/,
    english: (hours, minutes) => `${hours}h ${minutes}m remaining`,
    simplifiedChinese: (hours, minutes) => `剩余 ${hours} 小时 ${minutes} 分钟`,
  },
]

const localeToIntl: Readonly<Record<Locale, string>> = {
  tr: 'tr-TR',
  en: 'en-US',
  'zh-CN': 'zh-CN',
}

let activeLocale: Locale = 'tr'

export function resolveLocale(candidates: readonly string[]): Locale {
  for (const candidate of candidates) {
    const normalized = candidate.trim().toLowerCase()
    if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh-CN'
    if (normalized === 'en' || normalized.startsWith('en-')) return 'en'
    if (normalized === 'tr' || normalized.startsWith('tr-')) return 'tr'
  }
  return 'tr'
}

function initialLocale(): Locale {
  if (typeof window === 'undefined') return 'tr'
  try {
    const stored = window.localStorage.getItem(storageKey)
    if (stored && supportedLocales.some(({ code }) => code === stored)) return stored as Locale
  } catch {
    // Storage may be disabled. Browser language remains a safe fallback.
  }
  return resolveLocale(window.navigator.languages ?? [window.navigator.language])
}

function interpolate(value: string, replacements: Readonly<Record<string, string | number>>): string {
  return value.replace(/\{([^}]+)\}/g, (match, key: string) => (
    Object.hasOwn(replacements, key) ? String(replacements[key]) : match
  ))
}

export function translateForLocale(
  locale: Locale,
  source: string,
  replacements: Readonly<Record<string, string | number>> = {},
): string {
  const translated = messageTable[source]
  if (translated) {
    const value = locale === 'en' ? translated[0] : locale === 'zh-CN' ? translated[1] : source
    return interpolate(value, replacements)
  }

  if (locale !== 'tr') {
    for (const dynamic of dynamicPatterns) {
      const match = source.match(dynamic.pattern)
      if (!match) continue
      return locale === 'en'
        ? dynamic.english(...match.slice(1))
        : dynamic.simplifiedChinese(...match.slice(1))
    }
  }

  return interpolate(source, replacements)
}

export function t(
  source: string,
  replacements: Readonly<Record<string, string | number>> = {},
): string {
  return translateForLocale(activeLocale, source, replacements)
}

export function getActiveLocale(): Locale {
  return activeLocale
}

export function getIntlLocale(): string {
  return localeToIntl[activeLocale]
}

interface I18nContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale)
  activeLocale = locale

  useEffect(() => {
    document.documentElement.lang = locale
    document.documentElement.dir = 'ltr'
  }, [locale])

  const setLocale = (nextLocale: Locale) => {
    activeLocale = nextLocale
    setLocaleState(nextLocale)
    try {
      window.localStorage.setItem(storageKey, nextLocale)
    } catch {
      // The language still applies to the current session when storage is unavailable.
    }
  }

  return (
    <I18nContext.Provider value={{ locale, setLocale }}>
      {children}
    </I18nContext.Provider>
  )
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext)
  if (!context) throw new Error('I18nProvider is unavailable')
  return context
}

const translatableProps = new Set([
  'aria-label',
  'title',
  'placeholder',
  'alt',
  'label',
  'shortLabel',
  'description',
  'subtitle',
  'eyebrow',
  'hint',
  'error',
  'confirmLabel',
  'actionLabel',
])

function translateTextNode(value: string, locale: Locale): string {
  const match = value.match(/^(\s*)(.*?)(\s*)$/s)
  if (!match || !match[2]) return value
  return `${match[1]}${translateForLocale(locale, match[2])}${match[3]}`
}

function localizeNode(node: ReactNode, locale: Locale): ReactNode {
  if (typeof node === 'string') return translateTextNode(node, locale)
  if (typeof node === 'number' || typeof node === 'boolean' || node == null) return node
  if (Array.isArray(node)) return node.map((child) => localizeNode(child, locale))
  if (!isValidElement(node)) return node

  const element = node as ReactElement<Record<string, unknown>>
  const nextProps: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(element.props)) {
    if (name === 'children' || name === 'action') {
      nextProps[name] = Children.map(value as ReactNode, (child) => localizeNode(child, locale))
    } else if (translatableProps.has(name) && typeof value === 'string') {
      nextProps[name] = translateTextNode(value, locale)
    }
  }
  return cloneElement(element, nextProps)
}

export function Localized({ children }: { children: ReactNode }) {
  const { locale } = useI18n()
  return <>{Children.map(children, (child) => localizeNode(child, locale))}</>
}
