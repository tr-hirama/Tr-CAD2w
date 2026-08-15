import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INK_COLOR,
  DEFAULT_INK_WIDTH,
  cloneStrokes,
  eraseAt,
  normalizeStrokes,
  pointCount,
  simplifyStroke,
  type InkPoint,
  type InkStroke,
} from '../src/core/ink.js';

function p(x: number, y: number, pr = 0.5): InkPoint {
  return { x, y, p: pr };
}

function stroke(points: InkPoint[], color = DEFAULT_INK_COLOR, width = DEFAULT_INK_WIDTH): InkStroke {
  return { points, color, width };
}

describe('normalizeStrokes', () => {
  it('そのまま通る', () => {
    const s = [stroke([p(0, 0), p(0.5, 0.5)])];
    expect(normalizeStrokes(s)).toEqual(s);
  });

  it('範囲外の座標を 0〜1 に収める', () => {
    const got = normalizeStrokes([stroke([p(-1, 2)])]);
    expect(got[0]!.points[0]).toEqual({ x: 0, y: 1, p: 0.5 });
  });

  it('筆圧が無ければ 0.5', () => {
    const got = normalizeStrokes([{ points: [{ x: 0.25, y: 0.25 }] }]);
    expect(got[0]!.points[0]!.p).toBe(0.5);
  });

  it('数値でない座標の点は落とす', () => {
    const got = normalizeStrokes([{ points: [{ x: 0.25, y: 0.25 }, { x: 'a', y: 0 }, { x: 0.5, y: 0.5 }] }]);
    expect(got[0]!.points).toHaveLength(2);
  });

  /** 点が 1 つも無いストロークは描けないので持たない。 */
  it('点の無いストロークは捨てる', () => {
    expect(normalizeStrokes([{ points: [] }, stroke([p(0, 0)])])).toHaveLength(1);
  });

  it('壊れた色と太さを既定へ落とす', () => {
    const got = normalizeStrokes([{ points: [{ x: 0, y: 0 }], color: 'red', width: -1 }]);
    expect(got[0]!.color).toBe(DEFAULT_INK_COLOR);
    expect(got[0]!.width).toBe(DEFAULT_INK_WIDTH);
  });

  it('正しい色はそのまま', () => {
    expect(normalizeStrokes([{ points: [{ x: 0, y: 0 }], color: '#ff8000' }])[0]!.color).toBe('#ff8000');
  });

  it('配列でなければ空', () => {
    expect(normalizeStrokes(null)).toEqual([]);
    expect(normalizeStrokes('x')).toEqual([]);
    expect(normalizeStrokes(undefined)).toEqual([]);
  });
});

describe('cloneStrokes', () => {
  it('元と切り離れている', () => {
    const src = [stroke([p(0, 0)])];
    const copy = cloneStrokes(src);
    copy[0]!.points[0]!.x = 1;
    copy[0]!.color = '#ff0000';
    expect(src[0]!.points[0]!.x).toBe(0);
    expect(src[0]!.color).toBe(DEFAULT_INK_COLOR);
  });
});

describe('simplifyStroke', () => {
  /** まっすぐな線は両端だけあれば同じ形になる。 */
  it('直線上の点を落とす', () => {
    const line = [p(0, 0), p(0.25, 0), p(0.5, 0), p(0.75, 0), p(1, 0)];
    expect(simplifyStroke(line)).toEqual([p(0, 0), p(1, 0)]);
  });

  it('曲がり角は残す', () => {
    const bent = [p(0, 0), p(0.5, 0), p(0.5, 0.5)];
    expect(simplifyStroke(bent)).toHaveLength(3);
  });

  it('しきい値より小さいでこぼこは落とす', () => {
    // 0.001 のずれは既定のしきい値（0.002）より小さい
    const wobble = [p(0, 0), p(0.5, 0.001), p(1, 0)];
    expect(simplifyStroke(wobble)).toHaveLength(2);
  });

  it('しきい値より大きいでこぼこは残す', () => {
    const wobble = [p(0, 0), p(0.5, 0.01), p(1, 0)];
    expect(simplifyStroke(wobble)).toHaveLength(3);
  });

  it('2 点以下はそのまま', () => {
    expect(simplifyStroke([p(0, 0)])).toEqual([p(0, 0)]);
    expect(simplifyStroke([p(0, 0), p(1, 1)])).toHaveLength(2);
  });

  it('端点は必ず残る', () => {
    const many = Array.from({ length: 50 }, (_, i) => p(i / 49, Math.sin(i) * 0.0001));
    const got = simplifyStroke(many);
    expect(got[0]).toEqual(many[0]);
    expect(got[got.length - 1]).toEqual(many[many.length - 1]);
  });

  it('元の点を書き換えない', () => {
    const src = [p(0, 0), p(0.5, 0), p(1, 0)];
    simplifyStroke(src)[0]!.x = 9;
    expect(src[0]!.x).toBe(0);
  });
});

describe('pointCount', () => {
  it('点の総数を数える', () => {
    expect(pointCount([stroke([p(0, 0), p(1, 1)]), stroke([p(0, 1)])])).toBe(3);
    expect(pointCount([])).toBe(0);
  });
});

describe('eraseAt', () => {
  it('円に入ったストロークを丸ごと消す', () => {
    const src = [stroke([p(0, 0), p(0.1, 0.1)]), stroke([p(0.9, 0.9)])];
    const got = eraseAt(src, { x: 0.05, y: 0.05 }, 0.1);
    expect(got).toHaveLength(1);
    expect(got[0]!.points[0]).toEqual(p(0.9, 0.9));
  });

  it('触れていないストロークは残す', () => {
    const src = [stroke([p(0, 0)]), stroke([p(1, 1)])];
    expect(eraseAt(src, { x: 0.5, y: 0.5 }, 0.1)).toHaveLength(2);
  });

  it('半径ちょうどでも消す', () => {
    const src = [stroke([p(0, 0)])];
    expect(eraseAt(src, { x: 0.25, y: 0 }, 0.25)).toHaveLength(0);
  });

  it('元の配列を書き換えない', () => {
    const src = [stroke([p(0, 0)])];
    eraseAt(src, { x: 0, y: 0 }, 1);
    expect(src).toHaveLength(1);
  });
});

/**
 * 消しゴムは**線分との距離**で判定する（実機で踏んだ不具合）。
 *
 * `simplifyStroke` が点を間引くので、まっすぐな線では両端しか点が残らない。
 * 点だけを見ていると、**線の途中を狙っても消えない**。
 */
describe('eraseAt が線の途中に効く', () => {
  it('間引かれた直線の途中を狙っても消える', () => {
    // 両端しか点が無い線（simplifyStroke を通した後の姿）
    const line = [stroke([p(0.2, 0.6), p(0.5, 0.6)])];
    expect(eraseAt(line, { x: 0.35, y: 0.6 }, 0.02)).toHaveLength(0);
  });

  it('線から離れていれば消えない', () => {
    const line = [stroke([p(0.2, 0.6), p(0.5, 0.6)])];
    expect(eraseAt(line, { x: 0.35, y: 0.7 }, 0.02)).toHaveLength(1);
  });

  it('線分の外側（端点より先）は端点までの距離で見る', () => {
    const line = [stroke([p(0.2, 0.6), p(0.5, 0.6)])];
    // 端点 (0.2,0.6) から 0.01 手前 → 消える
    expect(eraseAt(line, { x: 0.19, y: 0.6 }, 0.02)).toHaveLength(0);
    // 端点から 0.1 離れている → 消えない
    expect(eraseAt(line, { x: 0.1, y: 0.6 }, 0.02)).toHaveLength(1);
  });

  it('折れ線のどの辺に触れても消える', () => {
    const bent = [stroke([p(0, 0), p(0.5, 0), p(0.5, 0.5)])];
    expect(eraseAt(bent, { x: 0.25, y: 0 }, 0.02)).toHaveLength(0);
    expect(eraseAt(bent, { x: 0.5, y: 0.25 }, 0.02)).toHaveLength(0);
  });

  it('点 1 つのストロークは点との距離で見る', () => {
    const dot = [stroke([p(0.5, 0.5)])];
    expect(eraseAt(dot, { x: 0.51, y: 0.5 }, 0.02)).toHaveLength(0);
    expect(eraseAt(dot, { x: 0.6, y: 0.5 }, 0.02)).toHaveLength(1);
  });
});
