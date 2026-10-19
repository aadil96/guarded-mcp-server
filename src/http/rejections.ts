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
  /** Most IPs tracked at once. Beyond this, new IPs share one overflow bucket until an old bucket has fully refilled. */
  maxTrackedIps: number;
};

export const defaultRejectionLimits: RejectionLimits = { burst: 10, refillPerSecond: 10 / 60, maxTrackedIps: 10_000 };

const OTHER = '(other)';
const EVICTION_SCAN = 64;

type Bucket = { tokens: number; at: number };

/**
 * Audits HTTP requests refused before any tool runs (bad token, Host, Origin, oversized body). Each row is
 * paid for from a per-IP token bucket, so a flood of bad requests can't grow audit_events without bound:
 * over the limit the request is still refused, the row is dropped, and drops are counted and written as one
 * summary row (error_code rejections_dropped) per flush. No header values are recorded, so no token material.
 */
export class RejectionAuditor {
  private readonly buckets = new Map<string, Bucket>();
  private readonly overflow: Bucket;
  private dropped = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastFlush: Promise<unknown> = Promise.resolve();
  private readonly writing = new Set<Promise<void>>();

  constructor(
    private readonly db: AppDb,
    private readonly limits: RejectionLimits = defaultRejectionLimits,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.overflow = { tokens: limits.burst, at: now() };
  }

  startPeriodicFlush(intervalMs = 60_000) {
    this.timer ??= setInterval(() => { void this.flush().catch((e) => console.error('rejection summary audit failed:', (e as Error).message)); }, intervalMs);
    this.timer.unref();
  }

  private refill(b: Bucket, t: number) {
    b.tokens = Math.min(this.limits.burst, b.tokens + ((t - b.at) / 1000) * this.limits.refillPerSecond);
    b.at = t;
  }

  /**
   * The bucket for this IP. Past maxTrackedIps, a new IP may only displace one of the oldest buckets that has
   * fully refilled (forgetting it loses nothing); otherwise it shares the overflow bucket, so rotating source
   * addresses can't reset their allowance.
   */
  private bucketFor(ip: string, t: number): Bucket {
    const known = this.buckets.get(ip);
    if (known) {
      this.buckets.delete(ip);
      this.buckets.set(ip, known);
      return known;
    }
    if (this.buckets.size >= this.limits.maxTrackedIps) {
      let scanned = 0;
      let room = false;
      for (const [key, b] of this.buckets) {
        this.refill(b, t);
        if (b.tokens >= this.limits.burst) {
          this.buckets.delete(key);
          room = true;
          break;
        }
        if (++scanned >= EVICTION_SCAN) break;
      }
      if (!room) return this.overflow;
    }
    const fresh = { tokens: this.limits.burst, at: t };
    this.buckets.set(ip, fresh);
    return fresh;
  }

  private take(ip: string): boolean {
    const t = this.now();
    const b = this.bucketFor(ip, t);
    this.refill(b, t);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  private countDropped(ip: string, n: number) {
    const key = this.dropped.has(ip) || this.dropped.size < 100 ? ip : OTHER;
    this.dropped.set(key, (this.dropped.get(key) ?? 0) + n);
  }

  /** Returns true if a row was written, false if it was dropped by the limit. */
  async record(r: Rejection): Promise<boolean> {
    if (!this.take(r.ip)) {
      this.countDropped(r.ip, 1);
      return false;
    }
    const startedAt = performance.now();
    const write = inAppTx(this.db, (tx) => writeAudit(tx, {
      actor: r.caller?.actor ?? 'anonymous', role: r.caller?.role ?? 'invalid', tool: 'http', outcome: 'denied', startedAt,
      correlationId: randomUUID(), errorCode: r.errorCode, args: { ip: r.ip, status: r.status, method: r.method },
    })).catch((e) => {
      this.countDropped(r.ip, 1);
      throw e;
    });
    const settled = write.then(() => {}, () => {}).finally(() => { this.writing.delete(settled); });
    this.writing.add(settled);
    await write;
    return true;
  }

  /**
   * Writes one summary row for the rejections dropped since the last flush, if any. Flushes run one at a time,
   * so a flush (including the final one in close) sees counts an earlier failed flush put back.
   */
  flush(): Promise<number> {
    const run = this.lastFlush.catch(() => {}).then(() => this.flushNow());
    this.lastFlush = run;
    return run;
  }

  private async flushNow(): Promise<number> {
    if (this.dropped.size === 0) return 0;
    const byIp = Object.fromEntries(this.dropped);
    const total = [...this.dropped.values()].reduce((a, b) => a + b, 0);
    const captured = this.dropped;
    this.dropped = new Map();
    const startedAt = performance.now();
    try {
      await inAppTx(this.db, (tx) => writeAudit(tx, {
        actor: 'anonymous', role: 'invalid', tool: 'http', outcome: 'denied', startedAt,
        correlationId: randomUUID(), errorCode: 'rejections_dropped', args: { total, byIp },
      }));
    } catch (e) {
      for (const [ip, n] of captured) this.countDropped(ip, n);
      throw e;
    }
    return total;
  }

  /**
   * Stops the periodic flush and writes the final summary. It first waits (up to waitMs) for refusal rows still
   * being written, so one that fails is counted in this summary rather than after it.
   */
  async close(waitMs = 2_000) {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled([...this.writing]), new Promise<void>((r) => { timer = setTimeout(r, waitMs); })]);
    clearTimeout(timer);
    await this.flush();
  }
}
