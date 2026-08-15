import { describe, expect, it } from 'vitest';
import { SpatialIndex, type Indexed } from '../src/core/spatial-index.js';
import type { Aabb } from '../src/core/geometry.js';

function boxAt(x: number, y: number, size = 4): Aabb {
  return { minX: x, minY: y, maxX: x + size, maxY: y + size };
}

/** 格子状に並べた図形。 */
function gridItems(cols: number, rows: number, step = 16): Indexed[] {
  const items: Indexed[] = [];
  let id = 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) items.push({ id: id++, bounds: boxAt(c * step, r * step) });
  }
  return items;
}

describe('SpatialIndex', () => {
  it('範囲に重なるものを返す', () => {
    const index = new SpatialIndex(gridItems(4, 4));
    const hit = index.query({ minX: -1, minY: -1, maxX: 20, maxY: 20 });
    // (0,0) (16,0) (0,16) (16,16) の 4 つ
    expect(hit.sort((a, b) => a - b)).toEqual([1, 2, 5, 6]);
  });

  it('重ならない範囲は空', () => {
    const index = new SpatialIndex(gridItems(2, 2));
    expect(index.query({ minX: 1000, minY: 1000, maxX: 2000, maxY: 2000 })).toEqual([]);
  });

  it('空の索引は何も返さない', () => {
    expect(new SpatialIndex([]).query({ minX: -1e9, minY: -1e9, maxX: 1e9, maxY: 1e9 })).toEqual([]);
  });

  it('無限の範囲を持つ図形は常に候補に混ぜる', () => {
    const index = new SpatialIndex([
      { id: 1, bounds: boxAt(0, 0) },
      { id: 99, bounds: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity } },
    ]);
    expect(index.query({ minX: 1000, minY: 1000, maxX: 2000, maxY: 2000 })).toEqual([99]);
  });
});

describe('クエリ範囲は索引の範囲でクリップする（issue #16）', () => {
  it('図面よりずっと広い範囲を引いても結果は同じ', () => {
    const index = new SpatialIndex(gridItems(4, 4));
    const tight = index.query({ minX: -1, minY: -1, maxX: 100, maxY: 100 });
    const huge = index.query({ minX: -1e7, minY: -1e7, maxX: 1e7, maxY: 1e7 });
    expect(huge.sort((a, b) => a - b)).toEqual(tight.sort((a, b) => a - b));
  });

  it('**広い範囲でも走査量が跳ね上がらない**', () => {
    // これが無いと、大きく縮小したとき図面の外の空セルを延々と走査する
    // （3 万図形・1/10 縮小で 91 万セル＝158ms かかっていた）
    const index = new SpatialIndex(gridItems(40, 40));
    const world = { minX: 0, minY: 0, maxX: 40 * 16, maxY: 40 * 16 };
    const huge = { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 };

    const time = (box: Aabb): number => {
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) index.query(box);
      return performance.now() - t0;
    };
    time(world); // 暖機
    const tightMs = time(world);
    const hugeMs = time(huge);

    // クリップしていれば同じ程度（余裕を見て 5 倍以内）。
    // していないと 1e6/セル幅 の 2 乗ぶん走査して桁違いに遅くなる
    expect(hugeMs).toBeLessThan(Math.max(tightMs * 5, 50));
  });

  it('索引の範囲を公開する', () => {
    const index = new SpatialIndex(gridItems(2, 2));
    expect(index.indexedExtent).toEqual({ minX: 0, minY: 0, maxX: 20, maxY: 20 });
    expect(new SpatialIndex([]).indexedExtent).toBeNull();
  });

  it('作り直すと範囲も付いてくる', () => {
    const index = new SpatialIndex(gridItems(2, 2));
    index.rebuild([{ id: 1, bounds: boxAt(1000, 1000) }]);
    expect(index.indexedExtent).toEqual({ minX: 1000, minY: 1000, maxX: 1004, maxY: 1004 });
    expect(index.query({ minX: 0, minY: 0, maxX: 20, maxY: 20 })).toEqual([]);
  });
});
