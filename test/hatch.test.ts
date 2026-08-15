import { describe, expect, it } from 'vitest';
import { vec, type Vec2 } from '../src/core/geometry.js';
import {
  DEFAULT_ATTRS,
  DEFAULT_HATCH_STYLE,
  type HatchEntity,
  cloneEntity,
  entityBounds,
  hitTest,
  scaleEntity,
  translateEntity,
} from '../src/core/entity.js';
import { MAX_SCAN_LINES, boundaryOf, hatchSegments, patternAngles, scan } from '../src/core/hatch.js';

/** 一辺 8 の正方形（0,0)-(8,8)。 */
const square: Vec2[] = [vec(0, 0), vec(8, 0), vec(8, 8), vec(0, 8)];

function hatch(over: Partial<HatchEntity> = {}): HatchEntity {
  return { ...DEFAULT_ATTRS, ...DEFAULT_HATCH_STYLE, id: 1, kind: 'hatch', points: square, ...over };
}

describe('走査線', () => {
  it('水平線は間隔ごとに 1 本ずつ、幅いっぱいに引かれる', () => {
    // y = 2,4,6 の 3 本（0 と 8 は境界上なので入らない）
    const segs = scan(square, 0, 2);
    expect(segs).toHaveLength(3);
    for (const [a, b] of segs) {
      expect(Math.min(a.x, b.x)).toBeCloseTo(0, 9);
      expect(Math.max(a.x, b.x)).toBeCloseTo(8, 9);
      expect(a.y).toBeCloseTo(b.y, 9);
    }
    expect(segs.map(([a]) => a.y).sort((x, y) => x - y)).toEqual([2, 4, 6]);
  });

  it('間隔を半分にすると本数はおよそ倍', () => {
    expect(scan(square, 0, 1).length).toBe(7);
    expect(scan(square, 0, 2).length).toBe(3);
  });

  it('垂直線も同じ本数', () => {
    expect(scan(square, 90, 2)).toHaveLength(3);
  });

  it('点が 3 つ未満なら線は出ない', () => {
    expect(scan([vec(0, 0), vec(8, 8)], 0, 2)).toEqual([]);
  });

  it('間隔 0 以下は線を作らない（無限ループにしない）', () => {
    expect(scan(square, 0, 0)).toEqual([]);
    expect(scan(square, 0, -1)).toEqual([]);
  });

  it('細かすぎる間隔でも本数は上限に収まる（固まらせない）', () => {
    const segs = scan(square, 0, 1e-9);
    expect(segs.length).toBeGreaterThan(0);
    expect(segs.length).toBeLessThanOrEqual(MAX_SCAN_LINES + 1);
  });

  it('つぶれた境界（面積ゼロ）は線を作らない', () => {
    expect(scan([vec(0, 0), vec(8, 0), vec(4, 0)], 0, 1)).toEqual([]);
  });

  it('凹んだ境界は内側だけを塗る（凹みには入らない）', () => {
    // 上辺の中央が深く凹んだコの字
    const c: Vec2[] = [vec(0, 0), vec(8, 0), vec(8, 8), vec(5, 8), vec(5, 3), vec(3, 3), vec(3, 8), vec(0, 8)];
    // y=6 は左右の柱 2 本に割れる
    const segs = scan(c, 0, 6).filter(([a]) => Math.abs(a.y - 6) < 1e-9);
    expect(segs).toHaveLength(2);
    const widths = segs.map(([a, b]) => [Math.min(a.x, b.x), Math.max(a.x, b.x)]).sort((x, y) => x[0]! - y[0]!);
    expect(widths[0]).toEqual([0, 3]);
    expect(widths[1]).toEqual([5, 8]);
  });

  it('穴あき境界は穴を塗らない（外周と穴を橋渡しでつなぐ）', () => {
    // 外周 (0,0)-(8,8) の中に (3,3)-(5,5) の穴。橋渡しで 1 本の輪にする
    const ring: Vec2[] = [
      vec(0, 0),
      vec(8, 0),
      vec(8, 8),
      vec(0, 8),
      vec(0, 0),
      // 橋を渡って穴へ（穴は逆回り）
      vec(3, 3),
      vec(3, 5),
      vec(5, 5),
      vec(5, 3),
      vec(3, 3),
    ];
    const segs = scan(ring, 0, 4).filter(([a]) => Math.abs(a.y - 4) < 1e-9);
    // y=4 は穴で分断されて 2 本
    expect(segs).toHaveLength(2);
    const spans = segs.map(([a, b]) => [Math.min(a.x, b.x), Math.max(a.x, b.x)]).sort((x, y) => x[0]! - y[0]!);
    expect(spans[0]).toEqual([0, 3]);
    expect(spans[1]).toEqual([5, 8]);
    // 穴の中（x=4）を通る線分は無い
    for (const [a, b] of segs) {
      expect(Math.min(a.x, b.x) < 4 && Math.max(a.x, b.x) > 4).toBe(false);
    }
  });
});

describe('パターン', () => {
  it('パターンごとの走査角', () => {
    expect(patternAngles('line45')).toEqual([45]);
    expect(patternAngles('line135')).toEqual([135]);
    expect(patternAngles('cross')).toEqual([45, 135]);
    expect(patternAngles('grid')).toEqual([0, 90]);
    expect(patternAngles('solid')).toEqual([]);
  });

  it('塗りつぶしは線分を持たない（塗りで描くため）', () => {
    expect(hatchSegments(hatch({ pattern: 'solid' }))).toEqual([]);
  });

  it('クロスは 45° 単独の 2 倍の本数', () => {
    const one = hatchSegments(hatch({ pattern: 'line45', spacing: 2 })).length;
    const cross = hatchSegments(hatch({ pattern: 'cross', spacing: 2 })).length;
    expect(cross).toBe(one * 2);
  });

  it('格子は縦横それぞれ引かれる', () => {
    const segs = hatchSegments(hatch({ pattern: 'grid', spacing: 2 }));
    const horizontal = segs.filter(([a, b]) => Math.abs(a.y - b.y) < 1e-9).length;
    const vertical = segs.filter(([a, b]) => Math.abs(a.x - b.x) < 1e-9).length;
    expect(horizontal).toBe(3);
    expect(vertical).toBe(3);
  });

  it('間隔 0 は既定値として扱う（線が消えない）', () => {
    expect(hatchSegments(hatch({ pattern: 'line45', spacing: 0, points: bigSquare() })).length).toBeGreaterThan(0);
  });
});

function bigSquare(): Vec2[] {
  return [vec(0, 0), vec(2000, 0), vec(2000, 2000), vec(0, 2000)];
}

describe('境界の取り出し', () => {
  it('閉じた点列の末尾の重複は落とす', () => {
    const ring = boundaryOf([[vec(0, 0), vec(8, 0), vec(8, 8), vec(0, 0)]]);
    expect(ring).toEqual([vec(0, 0), vec(8, 0), vec(8, 8)]);
  });

  it('開いた点列はそのまま（閉じているとみなす）', () => {
    expect(boundaryOf([[vec(0, 0), vec(8, 0), vec(8, 8)]])).toHaveLength(3);
  });

  it('2 点以下は境界にならない', () => {
    expect(boundaryOf([[vec(0, 0), vec(8, 0)]])).toBeNull();
    expect(boundaryOf([])).toBeNull();
    expect(boundaryOf(null)).toBeNull();
  });
});

describe('図形としての振る舞い', () => {
  it('外接矩形は境界の広がり', () => {
    const b = entityBounds(hatch());
    expect([b.minX, b.minY, b.maxX, b.maxY]).toEqual([0, 0, 8, 8]);
  });

  it('塗った内側のどこを押しても掴める', () => {
    expect(hitTest(hatch(), vec(4, 4), 0.1)).toBe(true);
  });

  it('外側では掴めない', () => {
    expect(hitTest(hatch(), vec(-2, 4), 0.1)).toBe(false);
  });

  it('平行移動は境界を動かす', () => {
    const m = translateEntity(hatch(), vec(10, 0)) as HatchEntity;
    expect(m.points[0]).toEqual(vec(10, 0));
  });

  it('拡縮は間隔も一緒に変える（塗りの見た目を保つ）', () => {
    const s = scaleEntity(hatch({ spacing: 2 }), vec(0, 0), 3) as HatchEntity;
    expect(s.spacing).toBe(6);
    expect(s.points[2]).toEqual(vec(24, 24));
  });

  it('複製は境界の配列を共有しない（Undo とコピペで消えない）', () => {
    const src = hatch();
    const copy = cloneEntity(src) as HatchEntity;
    expect(copy.points).toEqual(src.points);
    expect(copy.points).not.toBe(src.points);
  });
});
