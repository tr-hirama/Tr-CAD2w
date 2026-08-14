import { describe, expect, it } from 'vitest';
import { vec } from '../src/core/geometry.js';
import {
  DEFAULT_ATTRS,
  type ArcEntity,
  type CircleEntity,
  type LineEntity,
  type PolylineEntity,
  cloneEntity,
  entityArea,
  entityBounds,
  entityLength,
  hitTest,
  rotateEntity,
  scaleEntity,
  snapPoints,
  translateEntity,
} from '../src/core/entity.js';

const line: LineEntity = { ...DEFAULT_ATTRS, id: 1, kind: 'line', a: vec(0, 0), b: vec(8, 0) };
const circle: CircleEntity = { ...DEFAULT_ATTRS, id: 2, kind: 'circle', center: vec(0, 0), radius: 4 };
const arc: ArcEntity = {
  ...DEFAULT_ATTRS,
  id: 3,
  kind: 'arc',
  center: vec(0, 0),
  radius: 4,
  startAngle: 0,
  endAngle: Math.PI / 2,
};
const poly: PolylineEntity = {
  ...DEFAULT_ATTRS,
  id: 4,
  kind: 'polyline',
  points: [vec(0, 0), vec(8, 0), vec(8, 4), vec(0, 4)],
  closed: true,
};

describe('entityBounds', () => {
  it('円は半径ぶん広がる', () => {
    expect(entityBounds(circle)).toEqual({ minX: -4, minY: -4, maxX: 4, maxY: 4 });
  });

  it('円弧は弧に含まれる軸方向の点だけを含む', () => {
    // 0〜90° の弧なので右端(4,0)と上端(0,4)まで。左・下へは広がらない
    const b = entityBounds(arc);
    expect(b.minX).toBeCloseTo(0, 12); // cos(π/2) の丸めで厳密な 0 にはならない
    expect(b.minY).toBeCloseTo(0, 12);
    expect(b.maxX).toBe(4);
    expect(b.maxY).toBe(4);
  });
});

describe('hitTest', () => {
  it('線は許容値の内側だけ当たる', () => {
    expect(hitTest(line, vec(4, 0.5), 1)).toBe(true);
    expect(hitTest(line, vec(4, 2), 1)).toBe(false);
  });

  it('円は円周に当たる（内側は当たらない）', () => {
    expect(hitTest(circle, vec(4, 0), 0.5)).toBe(true);
    expect(hitTest(circle, vec(0, 0), 0.5)).toBe(false);
  });

  it('円弧は弧の範囲外では当たらない', () => {
    expect(hitTest(arc, vec(4, 0), 0.5)).toBe(true);
    expect(hitTest(arc, vec(-4, 0), 0.5)).toBe(false);
  });

  it('閉じた連続線は閉合辺にも当たる', () => {
    expect(hitTest(poly, vec(0, 2), 0.25)).toBe(true);
  });
});

describe('変形', () => {
  it('平行移動は元の図形を書き換えない', () => {
    const moved = translateEntity(line, vec(2, 3));
    expect(moved).toMatchObject({ kind: 'line', a: vec(2, 3), b: vec(10, 3) });
    expect(line.a).toEqual(vec(0, 0));
  });

  it('矩形を回すと閉じた連続線になる', () => {
    const rect = { ...DEFAULT_ATTRS, id: 5, kind: 'rect' as const, a: vec(0, 0), b: vec(4, 2) };
    const rotated = rotateEntity(rect, vec(0, 0), Math.PI / 2);
    expect(rotated.kind).toBe('polyline');
    expect((rotated as PolylineEntity).closed).toBe(true);
    expect((rotated as PolylineEntity).points).toHaveLength(4);
  });

  it('拡縮は半径にも掛かる', () => {
    const s = scaleEntity(circle, vec(0, 0), 2) as CircleEntity;
    expect(s.radius).toBe(8);
  });
});

describe('計測', () => {
  it('長さ', () => {
    expect(entityLength(line)).toBe(8);
    expect(entityLength(circle)).toBeCloseTo(2 * Math.PI * 4, 12);
    expect(entityLength(arc)).toBeCloseTo(Math.PI * 2, 12);
    // 閉じた連続線は閉合辺も含む
    expect(entityLength(poly)).toBe(24);
  });

  it('面積は閉図形だけ', () => {
    expect(entityArea(poly)).toBe(32);
    expect(entityArea({ ...poly, closed: false })).toBe(0);
    expect(entityArea(line)).toBe(0);
  });
});

describe('snapPoints', () => {
  it('線は端点と中点を出す', () => {
    const s = snapPoints(line);
    expect(s).toEqual(
      expect.arrayContaining([
        { kind: 'end', at: vec(0, 0) },
        { kind: 'end', at: vec(8, 0) },
        { kind: 'mid', at: vec(4, 0) },
      ]),
    );
  });

  it('円は中心と四方の四分点を出す', () => {
    const s = snapPoints(circle);
    expect(s.some((p) => p.kind === 'center')).toBe(true);
    expect(s.filter((p) => p.kind === 'end')).toHaveLength(4);
  });
});

describe('cloneEntity', () => {
  it('連続線の点列は共有しない', () => {
    const c = cloneEntity(poly) as PolylineEntity;
    c.points.push(vec(99, 99));
    expect(poly.points).toHaveLength(4);
  });
});
