/**
 * 描画カリング・ヒットテスト用の均一グリッド空間インデックス。
 *
 * 図形数が増えても「画面内の候補だけ」を触るための土台。
 * セル幅は登録済み図形の平均サイズから決め、図形が増減したら作り直す
 * （`CadDocument` が版数で管理し、遅延再構築する）。
 */

import type { Aabb } from './geometry.js';
import { aabbIntersects } from './geometry.js';

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

  constructor(items: readonly Indexed[] = []) {
    this.rebuild(items);
  }

  rebuild(items: readonly Indexed[]): void {
    this.buckets.clear();
    this.boundsById.clear();
    this.unbounded.length = 0;
    if (items.length === 0) {
      this.cell = 1;
      return;
    }

    // 平均の対角長を目安にセル幅を決める（極端な図形に引きずられないよう中庸に）
    let sum = 0;
    let count = 0;
    for (const it of items) {
      if (!isFiniteAabb(it.bounds)) continue;
      sum += Math.max(it.bounds.maxX - it.bounds.minX, it.bounds.maxY - it.bounds.minY);
      count++;
    }
    this.cell = count === 0 ? 1 : Math.max(1e-6, (sum / count) * 2);

    for (const it of items) this.insert(it);
  }

  insert(item: Indexed): void {
    this.boundsById.set(item.id, item.bounds);
    if (!isFiniteAabb(item.bounds)) {
      this.unbounded.push(item.id);
      return;
    }
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

  /** 範囲に重なる可能性のある id。厳密判定は呼び出し側で行う。 */
  query(box: Aabb): number[] {
    const out = new Set<number>(this.unbounded);
    if (isFiniteAabb(box)) {
      const [x0, y0, x1, y1] = this.cellRange(box);
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

function isFiniteAabb(b: Aabb): boolean {
  return (
    Number.isFinite(b.minX) && Number.isFinite(b.minY) && Number.isFinite(b.maxX) && Number.isFinite(b.maxY)
  );
}
