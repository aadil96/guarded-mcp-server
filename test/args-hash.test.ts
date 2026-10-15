import { describe, expect, it } from 'vitest';
import { argsHash, canonicalJson } from '../src/db/args-hash.js';

describe('canonicalJson / argsHash', () => {
  it('sorts keys recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 'x' } })).toBe('{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}');
  });
  it('same args in any key order hash the same', () => {
    expect(argsHash({ invoice_id: 'i1', amount_paise: 1200 })).toBe(argsHash({ amount_paise: 1200, invoice_id: 'i1' }));
    expect(argsHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
  it('does not coerce types: 1200 and "1200" differ', () => {
    expect(argsHash({ amount_paise: 1200 })).not.toBe(argsHash({ amount_paise: '1200' }));
  });
  it('different amounts differ', () => {
    expect(argsHash({ amount_paise: 1200 })).not.toBe(argsHash({ amount_paise: 1201 }));
  });
  it('rejects non-JSON values', () => {
    expect(() => canonicalJson({ a: NaN })).toThrow();
    expect(() => canonicalJson({ a: new Date() })).toThrow();
  });
});
