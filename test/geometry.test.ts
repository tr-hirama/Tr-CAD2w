import { describe, expect, it } from 'vitest';
import {
  aabbContainsAabb,
  aabbFromCorners,
  aabbIntersects,
  closestOnSegment,
  distToSegment,
  rotate,
  vec,
} from '../src/core/geometry.js';

describe('geometry', () => {
  it('線分への距離は垂線の足で決まる', () => {
    // 検証値は二進小数として厳密な値を使う（丸めがぶれない）
    expect(distToSegment(vec(0, 2), vec(-4, 0), vec(4, 0))).toBe(2);
    expect(closestOnSegment(vec(0, 2), vec(-4, 0), vec(4, 0))).toEqual(vec(0, 0));
  });

  it('線分の外側は端点までの距離になる', () => {
    expect(distToSegment(vec(8, 0), vec(-4, 0), vec(4, 0))).toBe(4);
  });

  it('回転は反時計回り', () => {
    const p = rotate(vec(1, 0), Math.PI / 2);
    expect(p.x).toBeCloseTo(0, 12);
    expect(p.y).toBeCloseTo(1, 12);
  });

  it('矩形は角の順序に依らず min/max へ正規化される', () => {
    expect(aabbFromCorners(vec(4, 8), vec(-4, -8))).toEqual({ minX: -4, minY: -8, maxX: 4, maxY: 8 });
  });

  it('重なり判定と内包判定', () => {
    const outer = aabbFromCorners(vec(0, 0), vec(16, 16));
    const inner = aabbFromCorners(vec(4, 4), vec(8, 8));
    const apart = aabbFromCorners(vec(32, 32), vec(64, 64));
    expect(aabbIntersects(outer, inner)).toBe(true);
    expect(aabbIntersects(outer, apart)).toBe(false);
    expect(aabbContainsAabb(outer, inner)).toBe(true);
    expect(aabbContainsAabb(inner, outer)).toBe(false);
  });
});
