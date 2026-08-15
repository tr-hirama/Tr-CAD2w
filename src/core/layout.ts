/**
 * 用紙空間（レイアウトとビューポート）。
 *
 * ビューポートは**モデル空間を縮尺・位置・回転で紙の上に映す窓**。
 * 座標は 2 種類あるので混ぜないこと:
 *
 * | 空間 | 単位 | 原点 |
 * |---|---|---|
 * | モデル | mm（図面の実寸） | 図面の原点 |
 * | 用紙 | mm（紙の実寸） | 紙の左下 |
 *
 * **線種尺度はモデルと用紙で別に持つ。** 用紙空間の図形（図枠など）にモデルと
 * 同じ尺度（新規図面で 500）を使うと、A4 より長い破線になって実線に見えてしまう。
 * デスクトップ版と同じく用紙空間は 5 を既定にする。
 */

import type { Entity } from './entity.js';
import type { Vec2 } from './geometry.js';
import { rotate, vec } from './geometry.js';
import type { Orientation } from '../print/paper.js';

/** 用紙空間の既定の線種尺度（モデル空間は `DEFAULT_LINETYPE_SCALE` = 500）。 */
export const PAPER_LINETYPE_SCALE = 5;

export interface Viewport {
  id: number;
  /** 紙の上での窓の位置と大きさ（mm。原点は紙の左下）。 */
  paperRect: { x: number; y: number; width: number; height: number };
  /** 窓の中心に映すモデル座標。 */
  center: Vec2;
  /** 縮尺の分母（1:N の N）。100 なら図面 100mm が紙 1mm。 */
  scaleDenominator: number;
  /** 窓の中での回転（ラジアン、反時計回り）。 */
  rotation: number;
}

export interface LayoutSpace {
  name: string;
  /** 用紙名（`PAPER_SIZES` の `name`）。 */
  paper: string;
  orientation: Orientation;
  /** 用紙空間に直接置く図形（図枠・表題欄など）。座標は紙 mm。 */
  entities: Entity[];
  viewports: Viewport[];
  /** 用紙空間の線種尺度。 */
  lineTypeScale: number;
}

export function makeLayout(name: string, paper = 'A4', orientation: Orientation = 'landscape'): LayoutSpace {
  return {
    name,
    paper,
    orientation,
    entities: [],
    viewports: [],
    lineTypeScale: PAPER_LINETYPE_SCALE,
  };
}

export function makeViewport(id: number, paperRect: Viewport['paperRect'], center: Vec2, scaleDenominator: number): Viewport {
  return { id, paperRect, center, scaleDenominator: scaleDenominator > 0 ? scaleDenominator : 1, rotation: 0 };
}

/** ビューポートの縮尺（紙 mm / モデル mm）。 */
export function viewportScale(vp: Viewport): number {
  return vp.scaleDenominator > 0 ? 1 / vp.scaleDenominator : 1;
}

/** モデル座標 → 紙座標（mm）。窓の外に出る点も計算はする（切り取りは描画側の仕事）。 */
export function modelToPaper(vp: Viewport, p: Vec2): Vec2 {
  const s = viewportScale(vp);
  const rel = rotate(vec(p.x - vp.center.x, p.y - vp.center.y), vp.rotation);
  return vec(
    vp.paperRect.x + vp.paperRect.width / 2 + rel.x * s,
    vp.paperRect.y + vp.paperRect.height / 2 + rel.y * s,
  );
}

/** 紙座標（mm） → モデル座標。`modelToPaper` の逆。 */
export function paperToModel(vp: Viewport, p: Vec2): Vec2 {
  const s = viewportScale(vp);
  const rel = vec(
    (p.x - (vp.paperRect.x + vp.paperRect.width / 2)) / s,
    (p.y - (vp.paperRect.y + vp.paperRect.height / 2)) / s,
  );
  const unrotated = rotate(rel, -vp.rotation);
  return vec(vp.center.x + unrotated.x, vp.center.y + unrotated.y);
}

/** その窓に映るモデル空間の範囲。 */
export function viewportModelExtent(vp: Viewport): { minX: number; minY: number; maxX: number; maxY: number } {
  const corners = [
    paperToModel(vp, vec(vp.paperRect.x, vp.paperRect.y)),
    paperToModel(vp, vec(vp.paperRect.x + vp.paperRect.width, vp.paperRect.y)),
    paperToModel(vp, vec(vp.paperRect.x + vp.paperRect.width, vp.paperRect.y + vp.paperRect.height)),
    paperToModel(vp, vec(vp.paperRect.x, vp.paperRect.y + vp.paperRect.height)),
  ];
  return {
    minX: Math.min(...corners.map((c) => c.x)),
    minY: Math.min(...corners.map((c) => c.y)),
    maxX: Math.max(...corners.map((c) => c.x)),
    maxY: Math.max(...corners.map((c) => c.y)),
  };
}

/** 窓いっぱいにその範囲が収まる縮尺の分母（1:N の N）を求める。 */
export function fitScaleDenominator(paperRect: Viewport['paperRect'], modelWidth: number, modelHeight: number): number {
  if (modelWidth <= 0 && modelHeight <= 0) return 1;
  const sx = modelWidth > 0 ? paperRect.width / modelWidth : Infinity;
  const sy = modelHeight > 0 ? paperRect.height / modelHeight : Infinity;
  const s = Math.min(sx, sy);
  return Number.isFinite(s) && s > 0 ? 1 / s : 1;
}
