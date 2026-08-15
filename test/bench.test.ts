import { describe, expect, it } from 'vitest';
import { BENCH_EXTENT, Lcg, formatBenchResult, generateBenchDocument, type BenchResult } from '../src/render/bench.js';

describe('擬似乱数', () => {
  it('同じ種なら同じ列（計測を比較できるように）', () => {
    const a = new Lcg(42);
    const b = new Lcg(42);
    const seqA = Array.from({ length: 5 }, () => a.next());
    const seqB = Array.from({ length: 5 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('種が違えば違う列', () => {
    expect(new Lcg(1).next()).not.toBe(new Lcg(2).next());
  });

  it('0 以上 1 未満に収まる', () => {
    const rng = new Lcg(7);
    for (let i = 0; i < 1000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('範囲と整数と選択', () => {
    const rng = new Lcg(99);
    for (let i = 0; i < 200; i++) {
      const v = rng.range(-5, 5);
      expect(v).toBeGreaterThanOrEqual(-5);
      expect(v).toBeLessThan(5);
      const n = rng.int(0, 3);
      expect([0, 1, 2]).toContain(n);
      expect(['a', 'b']).toContain(rng.pick(['a', 'b']));
    }
  });
});

describe('計測用の図面', () => {
  it('指定した数だけ作る', () => {
    expect(generateBenchDocument(500).count).toBe(500);
  });

  it('同じ種なら同じ図面（計測のたびに変わらない）', () => {
    const a = generateBenchDocument(200, 7);
    const b = generateBenchDocument(200, 7);
    expect(JSON.stringify(a.toJson().entities)).toBe(JSON.stringify(b.toJson().entities));
  });

  it('種が違えば違う図面', () => {
    const a = generateBenchDocument(200, 1);
    const b = generateBenchDocument(200, 2);
    expect(JSON.stringify(a.toJson().entities)).not.toBe(JSON.stringify(b.toJson().entities));
  });

  it('実図面に近い内訳（線と文字が多い）', () => {
    const doc = generateBenchDocument(2000, 3);
    const kinds: Record<string, number> = {};
    for (const e of doc.entities) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
    expect(kinds['line']).toBeGreaterThan(kinds['circle'] ?? 0);
    expect(kinds['text']).toBeGreaterThan(kinds['polyline'] ?? 0);
    // 5 種類すべて出る
    expect(Object.keys(kinds).sort()).toEqual(['circle', 'line', 'point', 'polyline', 'text']);
  });

  it('図面の広がりは想定の範囲に収まる', () => {
    const b = generateBenchDocument(2000, 5).bounds();
    expect(b.minX).toBeGreaterThan(-10_000);
    expect(b.maxX).toBeLessThan(BENCH_EXTENT + 10_000);
  });
});

describe('結果の書式', () => {
  it('issue に貼れる表になる', () => {
    const r: BenchResult = {
      entities: 30000,
      canvas: { width: 1060, height: 612 },
      buildMs: 12.3,
      indexMs: 4.5,
      cases: [
        { name: '全体表示', drawn: 30000, msMedian: 25.5, msMin: 24, msMax: 30, fps: 39, cells: 9324, queryMs: 4.9 },
      ],
    };
    const text = formatBenchResult(r);
    expect(text).toContain('30,000 件');
    expect(text).toContain('| 全体表示 | 30,000 | 25.5ms | 24ms | 30ms | 39 | 9,324 | 4.9ms |');
  });
});
