/**
 * 点（`point`）の表示スタイル。**図面全体で共有**する（AutoCAD の `PDMODE` / `PDSIZE`）。
 *
 * デスクトップ版 TrCad2D の `CadDocument.PointMode` / `PointSize` の移植。
 * `mode` は下位 5 ビットが基本の形、`32` を足すと外接円、`64` を足すと外接四角。
 *
 * | 下位ビット | 見た目 |
 * |---|---|
 * | 0 | 点（小さな塗り丸） |
 * | 1 | **描かない** |
 * | 2 | ＋ |
 * | 3 | × |
 * | 4 | ｜（上向きの短線） |
 *
 * `size` はワールド単位（mm）。**0 は画面固定サイズ**でズームに追従しない。
 */

import type { Vec2 } from './geometry.js';
import { vec } from './geometry.js';

export interface PointStyle {
  /** `PDMODE` 相当。 */
  mode: number;
  /** `PDSIZE` 相当（mm）。**0 は画面固定**。 */
  size: number;
}

export const DEFAULT_POINT_STYLE: PointStyle = { mode: 2, size: 0 };

/** 画面固定のときの半径（px）。デスクトップ版と同じ 8px 相当を 3px に合わせる。 */
export const POINT_SCREEN_HALF_PX = 3;

/** 選べる形の一覧（UI の並び順）。 */
export const POINT_MODE_CHOICES: { mode: number; label: string }[] = [
  { mode: 0, label: '点' },
  { mode: 1, label: '描かない' },
  { mode: 2, label: '＋' },
  { mode: 3, label: '×' },
  { mode: 4, label: '｜' },
  { mode: 32, label: '点＋円' },
  { mode: 34, label: '＋と円' },
  { mode: 35, label: '×と円' },
  { mode: 64, label: '点＋四角' },
  { mode: 66, label: '＋と四角' },
  { mode: 67, label: '×と四角' },
  { mode: 96, label: '点＋円と四角' },
  { mode: 98, label: '＋と円と四角' },
];

/** 基本の形（下位 5 ビット）。 */
export function baseMode(mode: number): number {
  return normalizeMode(mode) & 31;
}

export function hasCircle(mode: number): boolean {
  return (normalizeMode(mode) & 32) !== 0;
}

export function hasSquare(mode: number): boolean {
  return (normalizeMode(mode) & 64) !== 0;
}

/** 壊れた値（負・小数・NaN）を 0 に落とす。 */
export function normalizeMode(mode: number): number {
  return Number.isFinite(mode) && mode >= 0 ? Math.floor(mode) : 0;
}

/** その形を描くか（`1` は「描かない」）。 */
export function isPointVisible(mode: number): boolean {
  return baseMode(mode) !== 1 || hasCircle(mode) || hasSquare(mode);
}

/**
 * 点マーカーの半サイズ（画面 px）。
 *
 * `size` が 0 なら画面固定、正なら**ワールド寸法をズーム倍率で換算**する。
 * `viewScale` は画面 px / ワールド単位。
 */
export function markerHalfPx(style: PointStyle, viewScale: number): number {
  const size = Number.isFinite(style.size) ? style.size : 0;
  if (!(size > 0)) return POINT_SCREEN_HALF_PX;
  return Math.max(0.5, (size / 2) * viewScale);
}

export interface PointMarker {
  /** 線で描く部分（画面座標の線分列）。 */
  lines: [Vec2, Vec2][];
  /** 外接円（半径は `half`）。 */
  circle: boolean;
  /** 外接四角（半辺は `half`）。 */
  square: boolean;
  /** 中央の塗り丸の半径（px）。0 なら描かない。 */
  dotRadius: number;
  /** 外接図形の半サイズ（px）。 */
  half: number;
}

/**
 * 点 1 つ分の描き方を組み立てる（画面座標）。
 * 描画側はこの結果をそのまま線・円・四角として出すだけでよい。
 */
export function pointMarker(style: PointStyle, at: Vec2, viewScale: number): PointMarker {
  const half = markerHalfPx(style, viewScale);
  const m = normalizeMode(style.mode);
  const base = baseMode(m);
  const lines: [Vec2, Vec2][] = [];
  let dotRadius = 0;

  switch (base) {
    case 1:
      break; // 描かない（外接円・四角だけは下で足る）
    case 2:
      lines.push([vec(at.x - half, at.y), vec(at.x + half, at.y)]);
      lines.push([vec(at.x, at.y - half), vec(at.x, at.y + half)]);
      break;
    case 3:
      lines.push([vec(at.x - half, at.y - half), vec(at.x + half, at.y + half)]);
      lines.push([vec(at.x - half, at.y + half), vec(at.x + half, at.y - half)]);
      break;
    case 4:
      // 画面は Y 下向きなので、上向きの短線は -y へ伸ばす
      lines.push([vec(at.x, at.y), vec(at.x, at.y - half)]);
      break;
    default:
      // 0（とその他）は小さな塗り丸
      dotRadius = Math.max(half * 0.12, 1.2);
      break;
  }

  return { lines, circle: hasCircle(m), square: hasSquare(m), dotRadius, half };
}

/** 表示用の名前（`＋と円` など）。一覧に無い値は数値で見せる。 */
export function pointModeLabel(mode: number): string {
  const m = normalizeMode(mode);
  return POINT_MODE_CHOICES.find((c) => c.mode === m)?.label ?? `モード ${m}`;
}
