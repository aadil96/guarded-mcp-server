import { describe, expect, it } from 'vitest';
import { authenticate, expandScopes, loadTokenConfig, mintToken, parseTokenConfig, roleFor, sha256Hex } from '../src/auth/tokens.js';

const h = (c: string) => sha256Hex(c);

describe('token config', () => {
  it('stores hashes only, expands refund:request to include read, and never yields admin', () => {
    const [e] = parseTokenConfig(`sha256:${h('t1')} alice refund:request`);
    expect(e.actor).toBe('alice');
    expect(e.scopes).toEqual(['read', 'refund:request']);
    expect(roleFor(e.scopes)).toBe('operator');
    expect(roleFor(expandScopes(['read']))).toBe('reader');
    expect(JSON.stringify(e)).not.toContain('t1');
  });

  it('refuses empty, malformed, unknown-scope, admin, duplicate and raw-token configs', () => {
    expect(() => parseTokenConfig('')).toThrow(/no tokens/);
    expect(() => parseTokenConfig('# only a comment\n')).toThrow(/no tokens/);
    expect(() => parseTokenConfig('gms_rawtokenvalue alice read')).toThrow(/line 1/);
    expect(() => parseTokenConfig(`sha256:${h('a').toUpperCase()} alice read`)).toThrow(/line 1/);
    expect(() => parseTokenConfig(`sha256:${h('a')} alice read,admin`)).toThrow(/unknown scope "admin"/);
    expect(() => parseTokenConfig(`sha256:${h('a')} alice write`)).toThrow(/unknown scope/);
    expect(() => parseTokenConfig(`sha256:${h('a')} al!ce read`)).toThrow(/actor/);
    expect(() => parseTokenConfig(`sha256:${h('a')} alice read\nsha256:${h('a')} bob read`)).toThrow(/duplicate token hash/);
    expect(() => parseTokenConfig(`sha256:${h('a')} alice read\nsha256:${h('b')} alice read`)).toThrow(/duplicate actor/);
  });

  it('malformed-line errors never echo the line, which may be a pasted raw token', () => {
    try { parseTokenConfig('gms_SECRETVALUE123 alice read'); } catch (e) { expect((e as Error).message).not.toContain('SECRETVALUE'); }
  });

  it('loadTokenConfig needs exactly one of MCP_HTTP_TOKENS_FILE and MCP_HTTP_TOKENS', async () => {
    await expect(loadTokenConfig({})).rejects.toThrow(/no tokens configured/);
    await expect(loadTokenConfig({ MCP_HTTP_TOKENS: 'x', MCP_HTTP_TOKENS_FILE: '/tmp/x' })).rejects.toThrow(/not both/);
    await expect(loadTokenConfig({ MCP_HTTP_TOKENS: `sha256:${h('a')} alice read` })).resolves.toHaveLength(1);
  });
});

describe('authenticate', () => {
  const minted = mintToken('bob', ['read']);
  const entries = parseTokenConfig(minted.line);
  it('accepts the minted token and builds the caller from the config', () => {
    expect(minted.line).not.toContain(minted.token);
    expect(authenticate(`Bearer ${minted.token}`, entries)).toEqual({ ok: true, caller: { actor: 'bob', role: 'reader', scopes: ['read'] } });
  });
  it('rejects missing, wrong, non-Bearer and oversized headers', () => {
    expect(authenticate(undefined, entries)).toEqual({ ok: false, reason: 'missing_token' });
    for (const hdr of ['', `Bearer ${minted.token}x`, `bearer ${minted.token}`, `Basic ${minted.token}`, `Bearer ${'a'.repeat(513)}`, `Bearer ${minted.token} extra`]) {
      expect(authenticate(hdr, entries)).toEqual({ ok: false, reason: 'invalid_token' });
    }
  });
  it('mintToken refuses unknown scopes and bad actors', () => {
    expect(() => mintToken('bob', ['admin' as 'read'])).toThrow();
    expect(() => mintToken('', ['read'])).toThrow();
  });
});
