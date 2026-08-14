/**
 * ワールド⇔スクリーンの変換。
 *
 * - ワールドは Y 上向き・単位は mm（図面寸法）
 * - スクリーンは Y 下向き・単位は CSS ピクセル
 * - `scale` は「1 ワールド単位あたりの画面ピクセル数」
 */

import type { Aabb, Vec2 } from './geometry.js';

export class CadView {
  /** 画面中央に映るワールド座標。 */
  center: Vec2 = { x: 0, y: 0 };
  /** 1 ワールド単位 = scale px。 */
  scale = 0.05;
  /** 表示領域（CSS ピクセル）。 */
  width = 1;
  height = 1;

  static readonly MIN_SCALE = 1e-6;
  static readonly MAX_SCALE = 1e6;

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
  }

  toScreen(p: Vec2): Vec2 {
    return {
      x: this.width / 2 + (p.x - this.center.x) * this.scale,
      y: this.height / 2 - (p.y - this.center.y) * this.scale,
    };
  }

  toWorld(p: Vec2): Vec2 {
    return {
      x: this.center.x + (p.x - this.width / 2) / this.scale,
      y: this.center.y - (p.y - this.height / 2) / this.scale,
    };
  }

  /** 画面上の距離（px）をワールドの長さへ。ヒットテストの許容値に使う。 */
  toWorldLen(px: number): number {
    return px / this.scale;
  }

  /** ワールドの長さを画面上の距離（px）へ。 */
  toScreenLen(w: number): number {
    return w * this.scale;
  }

  /** 画面ドラッグ量（px）だけ図面を動かす。 */
  panByScreen(dx: number, dy: number): void {
    this.center = {
      x: this.center.x - dx / this.scale,
      y: this.center.y + dy / this.scale,
    };
  }

  /** カーソル位置（画面座標）を固定してズームする。 */
  zoomAt(screenPt: Vec2, factor: number): void {
    const before = this.toWorld(screenPt);
    this.setScale(this.scale * factor);
    const after = this.toWorld(screenPt);
    this.center = {
      x: this.center.x + (before.x - after.x),
      y: this.center.y + (before.y - after.y),
    };
  }

  /** 画面中央を固定してズームする。 */
  zoomCenter(factor: number): void {
    this.setScale(this.scale * factor);
  }

  setScale(s: number): void {
    this.scale = Math.min(CadView.MAX_SCALE, Math.max(CadView.MIN_SCALE, s));
  }

  /** 全体表示。空の範囲なら何もしない。 */
  zoomToFit(box: Aabb, marginRatio = 0.06): void {
    if (!(box.minX <= box.maxX && box.minY <= box.maxY)) return;
    const w = box.maxX - box.minX;
    const h = box.maxY - box.minY;
    this.center = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
    if (w === 0 && h === 0) return; // 1点だけ。倍率は変えず中央に置く
    const m = 1 - Math.min(0.4, Math.max(0, marginRatio)) * 2;
    const sx = w === 0 ? Infinity : (this.width * m) / w;
    const sy = h === 0 ? Infinity : (this.height * m) / h;
    this.setScale(Math.min(sx, sy));
  }

  /** いま画面に映っているワールド範囲（描画カリング用）。 */
  visibleWorld(): Aabb {
    const a = this.toWorld({ x: 0, y: 0 });
    const b = this.toWorld({ x: this.width, y: this.height });
    return {
      minX: Math.min(a.x, b.x),
      minY: Math.min(a.y, b.y),
      maxX: Math.max(a.x, b.x),
      maxY: Math.max(a.y, b.y),
    };
  }
}
