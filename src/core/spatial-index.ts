/**
 * 描画カリング・ヒットテスト用の均一グリッド空間インデックス。
 *
 * 図形数が増えても「画面内の候補だけ」を触るための土台。
 * セル幅は登録済み図形の平均サイズから決め、図形が増減したら作り直す
 * （`CadDocument` が版数で管理し、遅延再構築する）。
 */

import type { Aabb } from './geometry.js';
import { aabbIntersects } from './geometry.js';

/**
 * 1 回の `query` で走査するセル数の上限。超えたら総当たりへ落とす。
 *
 * 総当たりは図形数に比例する（O(n)）だけなので、**遅くはなっても返ってくる**。
 * insert 側にも同じ発想の上限（4096 セル）が既にある。
 */
const MAX_SCAN_CELLS = 100_000;

export interface Indexed {
  readonly id: number;
  readonly bounds: Aabb;
}

export class SpatialIndex {
  private cell = 1;
  private readonly buckets = new Map<string, number[]>();
  private readonly boundsById = new Map<number, Aabb>();
  /** どのセルにも入らない（無限・巨大な）図形。常に候補に混ぜる。 */
  private readonly unbounded: number[] = [];
  /**
   * 索引に入っている図形全体の範囲。
   *
   * **クエリはこの範囲でクリップする。** 大きく縮小すると「画面に映るワールド
   * 範囲」が図面よりずっと広くなり、図面の外の空セルまで走査してしまう
   * （3 万図形・1/10 縮小で 91 万セル＝158ms。issue #16 の計測で判明）。
   */
  private extent: Aabb | null = null;

  constructor(items: readonly Indexed[] = []) {
    this.rebuild(items);
  }

  rebuild(items: readonly Indexed[]): void {
    this.buckets.clear();
    this.boundsById.clear();
    this.unbounded.length = 0;
    this.extent = null;
    if (items.length === 0) {
      this.cell = 1;
      return;
    }

    // 1 パス目: 平均の大きさと全体の広がりを測る。
    // **平均だけではだめ**で、点しか無い図面では平均が 0 になりセル幅が下限
    // （1e-6）に落ちる。すると query の二重ループが天文学的な回数になって
    // 返ってこない（issue #36）。散らばりからも下限を作る。
    let sum = 0;
    let count = 0;
    let box = null;
    for (const it of items) {
      if (!isFiniteAabb(it.bounds)) continue;
      sum += Math.max(it.bounds.maxX - it.bounds.minX, it.bounds.maxY - it.bounds.minY);
      count++;
      box = box === null ? it.bounds : union(box, it.bounds);
    }

    if (count === 0) {
      this.cell = 1;
    } else {
      const fromSize = (sum / count) * 2;
      // 図形が散らばっている範囲の対角。ここから「セル数が図形数の 4 倍を
      // 超えない」幅を逆算する（(spread/cell)^2 <= 4n → cell >= spread/(2√n)）
      const spread = box === null ? 0 : Math.hypot(box.maxX - box.minX, box.maxY - box.minY);
      const fromSpread = spread / (2 * Math.sqrt(count));
      this.cell = Math.max(fromSize, fromSpread, 1e-6);
    }

    for (const it of items) this.insert(it);
  }

  insert(item: Indexed): void {
    this.boundsById.set(item.id, item.bounds);
    if (!isFiniteAabb(item.bounds)) {
      this.unbounded.push(item.id);
      return;
    }
    this.extent = this.extent === null ? item.bounds : union(this.extent, item.bounds);
    const [x0, y0, x1, y1] = this.cellRange(item.bounds);
    // セルをまたぎ過ぎる図形はバケットを汚すだけなので unbounded 扱いにする
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) {
      this.unbounded.push(item.id);
      return;
    }
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = `${cx},${cy}`;
        const b = this.buckets.get(key);
        if (b) b.push(item.id);
        else this.buckets.set(key, [item.id]);
      }
    }
  }

  /**
   * 範囲に重なる可能性のある id。厳密判定は呼び出し側で行う。
   *
   * 走査するセル数が `MAX_SCAN_CELLS` を超えたら**総当たりに落とす**。
   * セル幅の決め方が将来変わっても、「遅い」で済んで「固まる」にはならない。
   */
  query(box: Aabb): number[] {
    const out = new Set<number>(this.unbounded);
    const clipped = this.clipToExtent(box);
    if (clipped) {
      const [x0, y0, x1, y1] = this.cellRange(clipped);
      const cells = (x1 - x0 + 1) * (y1 - y0 + 1);
      if (cells > MAX_SCAN_CELLS) {
        for (const [id, eb] of this.boundsById) {
          if (aabbIntersects(eb, box)) out.add(id);
        }
        return [...out];
      }
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const b = this.buckets.get(`${cx},${cy}`);
          if (!b) continue;
          for (const id of b) {
            const eb = this.boundsById.get(id);
            if (eb && aabbIntersects(eb, box)) out.add(id);
          }
        }
      }
    }
    return [...out];
  }

  /**
   * クエリ範囲を索引が持つ範囲へ狭める。重なりが無ければ null。
   *
   * **これが無いと、縮小したときに図面の外の空セルを延々と走査する。**
   */
  private clipToExtent(box: Aabb): Aabb | null {
    if (!isFiniteAabb(box) || this.extent === null) return null;
    const e = this.extent;
    if (!aabbIntersects(e, box)) return null;
    return {
      minX: Math.max(box.minX, e.minX),
      minY: Math.max(box.minY, e.minY),
      maxX: Math.min(box.maxX, e.maxX),
      maxY: Math.min(box.maxY, e.maxY),
    };
  }

  /** 索引に入っている図形全体の範囲（空なら null）。 */
  get indexedExtent(): Aabb | null {
    return this.extent;
  }

  get cellSize(): number {
    return this.cell;
  }

  private cellRange(b: Aabb): [number, number, number, number] {
    return [
      Math.floor(b.minX / this.cell),
      Math.floor(b.minY / this.cell),
      Math.floor(b.maxX / this.cell),
      Math.floor(b.maxY / this.cell),
    ];
  }
}

function union(a: Aabb, b: Aabb): Aabb {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

function isFiniteAabb(b: Aabb): boolean {
  return (
    Number.isFinite(b.minX) && Number.isFinite(b.minY) && Number.isFinite(b.maxX) && Number.isFinite(b.maxY)
  );
}
