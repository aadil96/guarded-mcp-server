import { describe, expect, it } from 'vitest';
import { redact } from '../src/audit/log.js';

describe('audit redactor', () => {
  it('redacts every key either former matcher redacted (approvals and read path)', () => {
    const keys = ['customer_email', 'phone', 'gstin', 'token', 'client_secret', 'password', 'passwd', 'api_key', 'apiKey', 'Authorization', 'cookie'];
    const out = redact(Object.fromEntries(keys.map((k) => [k, 'v']))) as Record<string, unknown>;
    for (const k of keys) expect(out[k], k).toBe('[redacted]');
  });

  it('keeps ordinary keys', () => {
    expect(redact({ order_id: 'o-1', amount_paise: 100 })).toEqual({ order_id: 'o-1', amount_paise: 100 });
  });
});
