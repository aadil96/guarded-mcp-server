import { describe, expect, it, vi } from 'vitest';
import { closeDbWithin } from '../src/http/server.js';

describe('closeDbWithin', () => {
  it('reports closed when the pool ends in time', async () => {
    expect(await closeDbWithin(async () => {}, 1000)).toBe('closed');
  });

  it('gives up after the deadline when the pool never ends (a checked-out client is stuck)', async () => {
    vi.useFakeTimers();
    try {
      const result = closeDbWithin(() => new Promise<void>(() => {}), 5000);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await result).toBe('timed_out');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a failed close as failed rather than throwing', async () => {
    expect(await closeDbWithin(async () => { throw new Error('boom'); }, 1000)).toBe('failed');
  });
});
