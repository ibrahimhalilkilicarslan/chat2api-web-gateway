import { describe, expect, it } from 'vitest'
import {
  messageTable,
  resolveLocale,
  supportedLocales,
  translateForLocale,
} from './i18n'

describe('admin interface localization', () => {
  it('resolves supported browser language variants with a Turkish fallback', () => {
    expect(resolveLocale(['zh-Hans-CN', 'en-US'])).toBe('zh-CN')
    expect(resolveLocale(['de-DE', 'en-GB'])).toBe('en')
    expect(resolveLocale(['tr-TR'])).toBe('tr')
    expect(resolveLocale(['de-DE'])).toBe('tr')
  })

  it('exposes Turkish, English, and Simplified Chinese as distinct choices', () => {
    expect(supportedLocales.map(({ code }) => code)).toEqual(['tr', 'en', 'zh-CN'])
  })

  it('translates core navigation and security copy', () => {
    expect(translateForLocale('en', 'Genel bakış')).toBe('Overview')
    expect(translateForLocale('zh-CN', 'Güvenlik')).toBe('安全')
    expect(translateForLocale(
      'en',
      'İçerik loglanmaz, sırlar şifrelidir.',
    )).toBe('Content is not logged; secrets are encrypted.')
  })

  it('translates dynamic operational messages without exposing their values', () => {
    expect(translateForLocale('en', '3 hesap dikkat istiyor'))
      .toBe('3 accounts need attention')
    expect(translateForLocale('zh-CN', '12 aktivite kaydı yüklü'))
      .toBe('已加载 12 条活动记录')
    expect(translateForLocale('en', 'Windows x64 için indir'))
      .toBe('Download for Windows x64')
  })

  it('keeps Turkish as the source locale and interpolates fallback messages', () => {
    expect(translateForLocale('tr', 'Genel bakış')).toBe('Genel bakış')
    expect(translateForLocale('en', 'Value: {value}', { value: 42 })).toBe('Value: 42')
  })

  it('keeps both translations populated for every source message', () => {
    for (const [source, [english, simplifiedChinese]] of Object.entries(messageTable)) {
      expect(source.trim().length).toBeGreaterThan(0)
      expect(english.trim().length).toBeGreaterThan(0)
      expect(simplifiedChinese.trim().length).toBeGreaterThan(0)
    }
  })
})
