import { describe, expect, it } from 'vitest'
import { loadRuntimeConfig } from './config.js'

const validEnvironment = {
  NODE_ENV: 'test',
  CHAT2API_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  CHAT2API_BOOTSTRAP_API_KEY: 'bootstrap-key-that-is-at-least-thirty-two-characters',
  CHAT2API_ADMIN_TOKEN: 'admin-token-that-is-at-least-thirty-two-characters',
  CHAT2API_SESSION_SECRET: 'session-secret-that-is-at-least-thirty-two-characters',
  CHAT2API_ADMIN_ORIGINS: 'https://gateway.example.com',
}

describe('runtime configuration', () => {
  it('loads a strict configuration with safe defaults', () => {
    const config = loadRuntimeConfig(validEnvironment)

    expect(config.nodeEnv).toBe('test')
    expect(config.masterKey).toHaveLength(32)
    expect(config.adminOrigins).toEqual(['https://gateway.example.com'])
    expect(config.adminHosts).toEqual([])
    expect(config.trustProxy).toBe(1)
    expect(config.maxBodyBytes).toBe(2 * 1024 * 1024)
    expect(config.streamIdleTimeoutMs).toBe(90_000)
    expect(config.accountHealthIntervalMs).toBe(15 * 60_000)
  })

  it('fails closed when required secrets are absent', () => {
    expect(() => loadRuntimeConfig({ NODE_ENV: 'test' })).toThrow(
      'Invalid runtime configuration',
    )
  })

  it('rejects malformed encryption keys and non-exact origins', () => {
    expect(() => loadRuntimeConfig({
      ...validEnvironment,
      CHAT2API_MASTER_KEY: Buffer.alloc(16).toString('base64'),
    })).toThrow('exactly 32 bytes')

    expect(() => loadRuntimeConfig({
      ...validEnvironment,
      CHAT2API_ADMIN_ORIGINS: 'https://gateway.example.com/admin',
    })).toThrow('Invalid exact admin origin')

    expect(() => loadRuntimeConfig({
      ...validEnvironment,
      CHAT2API_TRUST_PROXY: 'true',
    })).toThrow('Invalid runtime configuration')
  })

  it('accepts only exact admin hostnames', () => {
    expect(loadRuntimeConfig({
      ...validEnvironment,
      CHAT2API_ADMIN_HOSTS: 'gateway.example.com,admin.internal.example',
    }).adminHosts).toEqual(['gateway.example.com', 'admin.internal.example'])

    expect(() => loadRuntimeConfig({
      ...validEnvironment,
      CHAT2API_ADMIN_HOSTS: 'https://admin.example.com',
    })).toThrow('Invalid exact admin host')

    expect(() => loadRuntimeConfig({
      ...validEnvironment,
      CHAT2API_ADMIN_HOSTS: 'different.gateway.example.com',
    })).toThrow('Every configured admin origin hostname')
  })
})
