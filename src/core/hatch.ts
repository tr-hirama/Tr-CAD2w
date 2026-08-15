/**
 * ハッチング（塗り）の線分生成。
 *
 * デスクトップ版 TrCad2D の `HatchEngine.cs` の移植。**スキャンライン法**で、
 * ある角度・間隔の平行線群を引き、各線と境界の辺との交点を並べて偶奇でペアにし、
 * 内部に入る区間だけを線分として返す。
 *
 * 偶奇規則なので、**外周と穴を橋渡しで 1 本の輪にすれば穴あきも塗り分けられる**
 * （境界は 1 つの点列しか持たない。`.tc2` の `Pts` に合わせるため）。
 */

import type { Vec2 } from './geometry.js';
import { vec } from './geometry.js';
import type { HatchEntity, HatchPattern } from './entity.js';

/** パターンを構成する走査線の角度（度）。 */
export function patternAngles(p: HatchPattern): number[] {
  switch (p) {
    case 'line45':
      return [45];
    case 'line135':
      return [135];
    case 'cross':
      return [45, 135];
    case 'grid':
      return [0, 90];
    case 'solid':
      return []; // 塗りつぶしは線分を作らない
  }
}

export const HATCH_PATTERN_LABEL: Record<HatchPattern, string> = {
  solid: '塗りつぶし',
  line45: '45°',
  line135: '135°',
  cross: 'クロス',
  grid: '格子',
};

/** 既定のパターン間隔（mm）。 */
export const DEFAULT_HATCH_SPACING = 200;

/**
 * 走査線の本数の上限。
 *
 * 間隔をうんと小さくすると本数が発散して画面が固まる。
 * 図形の広がりに対して細かすぎる間隔は**この本数に収まるまで広げる**。
 */
export const MAX_SCAN_LINES = 5000;

/** ハッチ図形の線分（ワールド座標）。`solid` は線を持たない（塗りで描く）。 */
export function hatchSegments(e: HatchEntity): [Vec2, Vec2][] {
  const spacing = e.spacing > 1e-6 ? e.spacing : DEFAULT_HATCH_SPACING;
  const out: [Vec2, Vec2][] = [];
  for (const ang of patternAngles(e.pattern)) out.push(...scan(e.points, ang, spacing));
  return out;
}

/**
 * 閉じた点列を、角度 `angleDeg`・間隔 `spacing` の平行線で走査した内部区間。
 *
 * 点列は閉じているとみなす（最後の点と最初の点を結ぶ）。
 */
export function scan(poly: readonly Vec2[], angleDeg: number, spacing: number): [Vec2, Vec2][] {
  const result: [Vec2, Vec2][] = [];
  const n = poly.length;
  if (n < 3 || !(spacing > 0)) return result;

  const rad = (angleDeg * Math.PI) / 180;
  const dir = vec(Math.cos(rad), Math.sin(rad)); // 走査線の向き
  const nrm = vec(-dir.y, dir.x); // 法線（走査線をずらす向き）

  let min = Infinity;
  let max = -Infinity;
  for (const p of poly) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return result;
    const o = p.x * nrm.x + p.y * nrm.y;
    if (o < min) min = o;
    if (o > max) max = o;
  }

  const extent = max - min;
  if (!(extent > 0)) return result;
  // 細かすぎる間隔は本数の上限まで広げる（固まらせない）
  const step = Math.max(spacing, extent / MAX_SCAN_LINES);

  const ts: number[] = [];
  for (let off = Math.ceil(min / step) * step; off < max; off += step) {
    const base = vec(nrm.x * off, nrm.y * off);
    ts.length = 0;
    for (let i = 0; i < n; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % n]!;
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const det = ex * dir.y - ey * dir.x;
      if (Math.abs(det) < 1e-12) continue; // 走査線と平行な辺
      const rx = a.x - base.x;
      const ry = a.y - base.y;
      const t = (-rx * ey + ex * ry) / det; // 走査線上の位置
      const u = (dir.x * ry - dir.y * rx) / det; // 辺上の位置
      // 半開区間 [0,1) にすることで、頂点をまたぐときの二重計上を避ける
      if (u >= -1e-9 && u < 1 - 1e-9) ts.push(t);
    }
    ts.sort((x, y) => x - y);
    for (let k = 0; k + 1 < ts.length; k += 2) {
      const t0 = ts[k]!;
      const t1 = ts[k + 1]!;
      result.push([
        vec(base.x + dir.x * t0, base.y + dir.y * t0),
        vec(base.x + dir.x * t1, base.y + dir.y * t1),
      ]);
    }
  }
  return result;
}

/**
 * 閉じた図形（矩形・円・連続線）からハッチの境界点列を作る。
 * 対応しない図形は `null`。
 */
export function boundaryOf(pts: readonly Vec2[][] | null): Vec2[] | null {
  if (!pts || pts.length === 0) return null;
  const ring = pts[0]!;
  if (ring.length < 3) return null;
  // `flatten` は閉じた図形の最後に始点を足すので、重複する末尾は落とす
  const last = ring[ring.length - 1]!;
  const first = ring[0]!;
  const closed = Math.abs(last.x - first.x) < 1e-9 && Math.abs(last.y - first.y) < 1e-9;
  const out = closed ? ring.slice(0, -1) : [...ring];
  return out.length >= 3 ? out : null;
}
