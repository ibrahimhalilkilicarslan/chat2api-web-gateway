import { describe, expect, it } from 'vitest'
import type { SafeRequestLog } from '../../main/store/store.js'
import type { AccountHealthResult } from '../providers/account-health.js'
import { deriveOperationalReadiness } from './readiness.js'

const now = 1_800_000_000_000
const healthy: AccountHealthResult = {
  healthy: true,
  status: 'healthy',
  code: 'provider_healthy',
  message: 'Healthy.',
  checkedAt: now - 1000,
  latencyMs: 20,
}

function log(input: Partial<SafeRequestLog>): SafeRequestLog {
  return {
    id: input.id ?? crypto.randomUUID(),
    requestId: input.requestId ?? crypto.randomUUID(),
    timestamp: input.timestamp ?? now - 1000,
    status: input.status ?? 'success',
    statusCode: input.statusCode ?? 200,
    method: 'POST',
    url: '/v1/chat/completions',
    model: 'deepseek-v4-flash',
    latency: 200,
    isStream: false,
    ...input,
  }
}

describe('operational readiness', () => {
  it('blocks traffic when no active account exists', () => {
    expect(deriveOperationalReadiness({
      accounts: [],
      openCircuits: [],
      requestLogs: [],
      now,
    })).toMatchObject({
      status: 'blocked',
      reasonCode: 'no_active_account',
    })
  })

  it('reports a provider suspension when every account is held out of routing', () => {
    expect(deriveOperationalReadiness({
      accounts: [{
        id: 'account-1',
        status: 'error',
        health: {
          healthy: false,
          status: 'suspended',
          code: 'provider_account_suspended',
          message: 'Suspended.',
          checkedAt: now - 1000,
          latencyMs: 20,
          retryAt: now + 60_000,
        },
      }],
      openCircuits: [],
      requestLogs: [],
      now,
    })).toMatchObject({
      status: 'blocked',
      reasonCode: 'provider_account_suspended',
      retryAt: now + 60_000,
    })
  })

  it('requires a credential check before claiming readiness', () => {
    expect(deriveOperationalReadiness({
      accounts: [{ id: 'account-1', status: 'active' }],
      openCircuits: [],
      requestLogs: [],
      now,
    })).toMatchObject({
      status: 'needs_check',
      reasonCode: 'credential_check_required',
    })
  })

  it('does not treat a credential-only check as proven traffic readiness', () => {
    expect(deriveOperationalReadiness({
      accounts: [{ id: 'account-1', status: 'active', health: healthy }],
      openCircuits: [],
      requestLogs: [],
      now,
    })).toMatchObject({
      status: 'needs_check',
      reasonCode: 'no_successful_request',
    })
  })

  it('blocks when every active account has an open rate-limit circuit', () => {
    expect(deriveOperationalReadiness({
      accounts: [{ id: 'account-1', status: 'active', health: healthy }],
      openCircuits: [{ accountId: 'account-1', openedUntil: now + 60_000 }],
      requestLogs: [
        log({
          status: 'error',
          statusCode: 429,
          errorCode: 'provider_rate_limited',
        }),
      ],
      now,
    })).toMatchObject({
      status: 'blocked',
      reasonCode: 'provider_rate_limited',
      retryAt: now + 60_000,
    })
  })

  it('keeps a recent provider failure visible until a later success proves recovery', () => {
    const degraded = deriveOperationalReadiness({
      accounts: [{ id: 'account-1', status: 'active', health: healthy }],
      openCircuits: [],
      requestLogs: [
        log({
          timestamp: now - 1000,
          status: 'error',
          statusCode: 502,
          errorCode: 'provider_protocol_changed',
        }),
        log({ timestamp: now - 5000 }),
      ],
      now,
    })
    const recovered = deriveOperationalReadiness({
      accounts: [{ id: 'account-1', status: 'active', health: healthy }],
      openCircuits: [],
      requestLogs: [
        log({ timestamp: now - 500 }),
        log({
          timestamp: now - 1000,
          status: 'error',
          statusCode: 502,
          errorCode: 'provider_protocol_changed',
        }),
      ],
      now,
    })

    expect(degraded).toMatchObject({
      status: 'degraded',
      reasonCode: 'provider_protocol_changed',
    })
    expect(recovered).toMatchObject({
      status: 'operational',
      reasonCode: 'ready',
    })
  })
})
