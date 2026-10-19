import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Caller } from '../audit/log.js';

export const SCOPES = ['read', 'refund:request'] as const;
export type Scope = (typeof SCOPES)[number];

/** A caller authenticated by a bearer token: never admin, and it carries the scopes the token grants. */
export type TokenCaller = Caller & { role: 'reader' | 'operator'; scopes: readonly Scope[] };

export type TokenEntry = { hash: Buffer; actor: string; scopes: readonly Scope[] };

const LINE = /^sha256:([0-9a-f]{64})\s+(\S+)\s+(\S+)$/;
const ACTOR = /^[A-Za-z0-9._@-]{1,64}$/;

const isScope = (s: string): s is Scope => (SCOPES as readonly string[]).includes(s);

/** refund:request implies read. No scope maps to admin: approving stays in the operator console. */
export function expandScopes(granted: readonly Scope[]): readonly Scope[] {
  const out = new Set<Scope>(granted);
  if (out.has('refund:request')) out.add('read');
  return SCOPES.filter((s) => out.has(s));
}

export const roleFor = (scopes: readonly Scope[]): TokenCaller['role'] => (scopes.includes('refund:request') ? 'operator' : 'reader');

export const sha256Hex = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * Parses token config: one `sha256:<64 hex> <actor> <scope[,scope]>` per line, `#` comments and blank lines
 * ignored. Holds hashes only. Throws on anything malformed, a duplicate hash or actor, or an empty config,
 * so the HTTP server refuses to start rather than run with a partial or empty token set.
 */
export function parseTokenConfig(text: string): TokenEntry[] {
  const entries: TokenEntry[] = [];
  const hashes = new Set<string>();
  const actors = new Set<string>();
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) throw new Error(`token config line ${i + 1}: expected "sha256:<64 lowercase hex> <actor> <scopes>"`);
    const [, hex, actor, scopeList] = m;
    if (!ACTOR.test(actor)) throw new Error(`token config line ${i + 1}: actor must match ${ACTOR}`);
    const scopes = scopeList.split(',');
    const bad = scopes.find((s) => !isScope(s));
    if (bad !== undefined) throw new Error(`token config line ${i + 1}: unknown scope "${bad}" (allowed: ${SCOPES.join(', ')})`);
    if (hashes.has(hex)) throw new Error(`token config line ${i + 1}: duplicate token hash`);
    if (actors.has(actor)) throw new Error(`token config line ${i + 1}: duplicate actor "${actor}"`);
    hashes.add(hex);
    actors.add(actor);
    entries.push({ hash: Buffer.from(hex, 'hex'), actor, scopes: expandScopes(scopes as Scope[]) });
  }
  if (entries.length === 0) throw new Error('token config has no tokens; the HTTP transport refuses to start without one');
  return entries;
}

export type AuthResult = { ok: true; caller: TokenCaller } | { ok: false; reason: 'missing_token' | 'invalid_token' };

/**
 * Checks an Authorization header against the configured hashes. The presented token is hashed and compared
 * with every entry in constant time (no early exit), so timing doesn't reveal which hash or prefix matched.
 */
export function authenticate(header: string | undefined, entries: readonly TokenEntry[]): AuthResult {
  const m = header === undefined ? null : /^Bearer ([\x21-\x7e]{1,512})$/.exec(header);
  if (!m) return { ok: false, reason: header === undefined ? 'missing_token' : 'invalid_token' };
  const presented = createHash('sha256').update(m[1], 'utf8').digest();
  let match: TokenEntry | undefined;
  for (const e of entries) if (timingSafeEqual(presented, e.hash) && match === undefined) match = e;
  if (!match) return { ok: false, reason: 'invalid_token' };
  return { ok: true, caller: { actor: match.actor, role: roleFor(match.scopes), scopes: match.scopes } };
}

/** A new random token and its config line. The raw token is shown once and never stored. */
export function mintToken(actor: string, scopes: readonly Scope[]): { token: string; line: string } {
  if (!ACTOR.test(actor)) throw new Error(`actor must match ${ACTOR}`);
  if (scopes.length === 0 || scopes.some((s) => !isScope(s))) throw new Error(`scopes must be one or more of: ${SCOPES.join(', ')}`);
  const token = `gms_${randomBytes(32).toString('base64url')}`;
  return { token, line: `sha256:${sha256Hex(token)} ${actor} ${scopes.join(',')}` };
}

/**
 * Token config from the environment: MCP_HTTP_TOKENS_FILE (a path) or MCP_HTTP_TOKENS (the lines inline),
 * exactly one of them. Throws if neither or both are set, or the config is malformed.
 */
export async function loadTokenConfig(env: NodeJS.ProcessEnv = process.env): Promise<TokenEntry[]> {
  const file = env.MCP_HTTP_TOKENS_FILE?.trim();
  const inline = env.MCP_HTTP_TOKENS;
  if (file && inline) throw new Error('set MCP_HTTP_TOKENS_FILE or MCP_HTTP_TOKENS, not both');
  if (file) {
    const { readFile } = await import('node:fs/promises');
    return parseTokenConfig(await readFile(file, 'utf8'));
  }
  if (inline) return parseTokenConfig(inline);
  throw new Error('no tokens configured: set MCP_HTTP_TOKENS_FILE or MCP_HTTP_TOKENS (sha256 hash lines from pnpm mint-token)');
}
