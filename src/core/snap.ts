/**
 * オブジェクトスナップ（端点・中点・中心・節点・交点）とグリッド吸着。
 *
 * 全図形を走査せず、**カーソル近傍の候補だけ**を空間インデックスから取って評価する。
 */

import type { Vec2 } from './geometry.js';
import { dist, vec } from './geometry.js';
import type { Entity } from './entity.js';
import { flatten, snapPoints } from './entity.js';
import type { CadDocument } from './document.js';

export type SnapKind = 'end' | 'mid' | 'center' | 'node' | 'intersect' | 'grid';

export interface SnapResult {
  at: Vec2;
  kind: SnapKind;
  /** 吸着元の図形 id（グリッドのときは undefined）。 */
  entityId?: number;
}

export interface SnapSettings {
  objectSnap: boolean;
  gridSnap: boolean;
  /** グリッド間隔（mm）。 */
  gridSize: number;
  /** 吸着の許容半径（画面 px）。 */
  pixelTolerance: number;
}

export const DEFAULT_SNAP: SnapSettings = {
  objectSnap: true,
  gridSnap: false,
  gridSize: 1000,
  pixelTolerance: 12,
};

/** スナップ種別の優先度（小さいほど優先）。 */
const PRIORITY: Record<SnapKind, number> = {
  end: 0,
  intersect: 1,
  center: 2,
  mid: 3,
  node: 0,
  grid: 9,
};

/**
 * カーソル位置 `p`（ワールド）に対する吸着先を1つ返す。無ければ undefined。
 * `tol` はワールド単位の許容半径。
 */
export function findSnap(doc: CadDocument, p: Vec2, tol: number, settings: SnapSettings): SnapResult | undefined {
  let best: SnapResult | undefined;
  let bestScore = Infinity;

  const consider = (r: SnapResult): void => {
    const d = dist(p, r.at);
    if (d > tol) return;
    // 種別の優先度を第一、距離を第二に見る
    const score = PRIORITY[r.kind] * tol + d;
    if (score < bestScore) {
      bestScore = score;
      best = r;
    }
  };

  if (settings.objectSnap) {
    const box = { minX: p.x - tol, minY: p.y - tol, maxX: p.x + tol, maxY: p.y + tol };
    const near = doc.visibleIn(box);
    for (const e of near) {
      for (const s of snapPoints(e)) consider({ at: s.at, kind: s.kind, entityId: e.id });
    }
    // 交点は候補どうしの総当たり。近傍だけなので件数は小さい
    for (let i = 0; i < near.length; i++) {
      for (let j = i + 1; j < near.length; j++) {
        for (const x of intersections(near[i]!, near[j]!)) {
          consider({ at: x, kind: 'intersect', entityId: near[i]!.id });
        }
      }
    }
  }

  if (!best && settings.gridSnap && settings.gridSize > 0) {
    const g = settings.gridSize;
    const at = vec(Math.round(p.x / g) * g, Math.round(p.y / g) * g);
    if (dist(p, at) <= tol) return { at, kind: 'grid' };
  }
  return best;
}

/** グリッド吸着だけを適用する（作図中の座標確定に使う）。 */
export function applyGrid(p: Vec2, settings: SnapSettings): Vec2 {
  if (!settings.gridSnap || settings.gridSize <= 0) return p;
  const g = settings.gridSize;
  return vec(Math.round(p.x / g) * g, Math.round(p.y / g) * g);
}

/** 2 図形の交点。円・円弧は折れ線に近似して求める（土台の実装）。 */
export function intersections(a: Entity, b: Entity): Vec2[] {
  const out: Vec2[] = [];
  const pa = flatten(a, 96);
  const pb = flatten(b, 96);
  for (const path1 of pa) {
    for (let i = 0; i + 1 < path1.length; i++) {
      for (const path2 of pb) {
        for (let j = 0; j + 1 < path2.length; j++) {
          const x = segmentIntersection(path1[i]!, path1[i + 1]!, path2[j]!, path2[j + 1]!);
          if (x) out.push(x);
        }
      }
    }
  }
  return out;
}

/** 線分 p1p2 と p3p4 の交点（端点を含む。平行・重なりは undefined）。 */
export function segmentIntersection(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): Vec2 | undefined {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  const den = d1x * d2y - d1y * d2x;
  if (den === 0) return undefined;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / den;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return undefined;
  return vec(p1.x + d1x * t, p1.y + d1y * t);
}

export const SNAP_LABEL: Record<SnapKind, string> = {
  end: '端点',
  mid: '中点',
  center: '中心',
  node: '点',
  intersect: '交点',
  grid: 'グリッド',
};
