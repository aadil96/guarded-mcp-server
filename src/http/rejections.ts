import { randomUUID } from 'node:crypto';
import { writeAudit } from '../audit/log.js';
import type { TokenCaller } from '../auth/tokens.js';
import { inAppTx } from '../db/index.js';
import type { AppDb } from '../db/types.js';

export type Rejection = {
  ip: string;
  status: number;
  errorCode: 'missing_token' | 'invalid_token' | 'invalid_host' | 'forbidden_origin' | 'body_too_large';
  /** The authenticated caller, for refusals after the token check; absent before it. */
  caller?: Pick<TokenCaller, 'actor' | 'role'>;
  method: string;
};

export type RejectionLimits = {
  /** Audit rows an IP may write in a burst. */
  burst: number;
  /** Tokens refilled per second, per IP. */
  refillPerSecond: number;
  /** Most IPs tracked at once; the oldest is forgotten first. */
  maxTrackedIps: number;
};

export const defaultRejectionLimits: RejectionLimits = { burst: 10, refillPerSecond: 10 / 60, maxTrackedIps: 10_000 };

const OTHER = '(other)';

/**
 * Audits HTTP requests refused before any tool runs (bad token, Host, Origin, oversized body). Each row is
 * paid for from a per-IP token bucket, so a flood of bad requests can't grow audit_events without bound:
 * over the limit the request is still refused, the row is dropped, and drops are counted and written as one
 * summary row (error_code rejections_dropped) per flush. No header values are recorded, so no token material.
 */
export class RejectionAuditor {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private dropped = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly db: AppDb,
    private readonly limits: RejectionLimits = defaultRejectionLimits,
    private readonly now: () => number = () => Date.now(),
  ) {}

  startPeriodicFlush(intervalMs = 60_000) {
    this.timer ??= setInterval(() => { void this.flush().catch((e) => console.error('rejection summary audit failed:', (e as Error).message)); }, intervalMs);
    this.timer.unref();
  }

  private take(ip: string): boolean {
    const t = this.now();
    let b = this.buckets.get(ip);
    if (b) this.buckets.delete(ip);
    else {
      if (this.buckets.size >= this.limits.maxTrackedIps) this.buckets.delete(this.buckets.keys().next().value as string);
      b = { tokens: this.limits.burst, at: t };
    }
    b.tokens = Math.min(this.limits.burst, b.tokens + ((t - b.at) / 1000) * this.limits.refillPerSecond);
    b.at = t;
    this.buckets.set(ip, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Returns true if a row was written, false if it was dropped by the limit. */
  async record(r: Rejection): Promise<boolean> {
    if (!this.take(r.ip)) {
      const key = this.dropped.has(r.ip) || this.dropped.size < 100 ? r.ip : OTHER;
      this.dropped.set(key, (this.dropped.get(key) ?? 0) + 1);
      return false;
    }
    const startedAt = performance.now();
    await inAppTx(this.db, (tx) => writeAudit(tx, {
      actor: r.caller?.actor ?? 'anonymous', role: r.caller?.role ?? 'invalid', tool: 'http', outcome: 'denied', startedAt,
      correlationId: randomUUID(), errorCode: r.errorCode, args: { ip: r.ip, status: r.status, method: r.method },
    }));
    return true;
  }

  /** Writes one summary row for the rejections dropped since the last flush, if any. */
  async flush(): Promise<number> {
    if (this.dropped.size === 0) return 0;
    const byIp = Object.fromEntries(this.dropped);
    const total = [...this.dropped.values()].reduce((a, b) => a + b, 0);
    this.dropped = new Map();
    const startedAt = performance.now();
    await inAppTx(this.db, (tx) => writeAudit(tx, {
      actor: 'anonymous', role: 'invalid', tool: 'http', outcome: 'denied', startedAt,
      correlationId: randomUUID(), errorCode: 'rejections_dropped', args: { total, byIp },
    }));
    return total;
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }
}
