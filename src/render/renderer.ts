/**
 * Canvas 2D による描画。
 *
 * イミディエイトモード（毎フレーム描き直し）で、**画面内の候補だけ**を描く。
 * DOM 要素を図形ごとに作らないので、図形が数万あっても重くならない。
 * 将来 WebGL へ差し替えられるよう、描画の入口はこのクラス 1 つに閉じている。
 */

import type { Aabb, Vec2 } from '../core/geometry.js';
import type { CadView } from '../core/view.js';
import type { CadDocument } from '../core/document.js';
import type { Entity, TextEntity } from '../core/entity.js';
import { TEXT_LINE_GAP, angleToPoint, flatten, rectCorners } from '../core/entity.js';
import { effectiveColor, effectiveLineStyle, isLightBackground, type ColorContext } from '../core/layer.js';
import { dashArrayPx, lineWidthPx, printLineWidthPx } from './linetype.js';
import type { SnapResult } from '../core/snap.js';
import type { LayoutSpace, Viewport } from '../core/layout.js';
import { modelEntityToPaper, viewportCorners, viewportModelExtent } from '../core/layout.js';
import { paperByName } from '../print/paper.js';

export interface RenderOptions {
  background: string;
  darkBoost: number;
  showGrid: boolean;
  /** グリッド間隔（mm）。 */
  gridSize: number;
  showAxis: boolean;
  /** 選択ハイライト色。 */
  selectionColor: string;
  /** 作図中のプレビュー図形（ラバーバンド）。 */
  preview?: Entity[] | undefined;
  /** 吸着マーカー。 */
  snap?: SnapResult | undefined;
  /** 矩形選択の枠（ワールド）。 */
  selectionBox?: { box: Aabb; crossing: boolean } | undefined;
  /**
   * モノクロ描画（印刷用）。すべての図形を黒で描く。
   * 背景に応じた反転や暗背景の持ち上げより優先する。
   */
  monochrome?: boolean | undefined;
  /**
   * 線幅を**紙の実寸**で描くときの px/mm（= dpi / 25.4）。印刷のときだけ渡す。
   * 画面では未指定にして画面固定の太さを使う（デスクトップ版準拠の非対称）。
   */
  lineWidthPxPerMm?: number | undefined;
}

export const DEFAULT_RENDER: RenderOptions = {
  background: '#ffffff',
  darkBoost: 0.6,
  showGrid: true,
  gridSize: 1000,
  showAxis: true,
  selectionColor: '#ff3b30',
};

export interface LayoutRenderOptions extends RenderOptions {
  /** 印刷可能領域を示す余白（mm）。0 なら描かない。 */
  margin: number;
  /**
   * 紙の輪郭と机の色を描くか。**画面では描き、紙に刷るときは描かない**
   * （紙の上に紙の枠を刷らない）。省略＝描く。
   */
  paperOutline?: boolean | undefined;
  /** ビューポートの枠を描くか。省略＝描く（画面用）。刷るときは中身だけ出す。 */
  viewportFrames?: boolean | undefined;
}

/** レイアウトの用紙寸法（向きを反映した mm）。 */
export function paperExtentOf(layout: LayoutSpace): { width: number; height: number } {
  const p = paperByName(layout.paper);
  return layout.orientation === 'landscape'
    ? { width: p.height, height: p.width }
    : { width: p.width, height: p.height };
}

export interface RenderStats {
  /** 描画した図形数。 */
  drawn: number;
  /** 図面全体の図形数。 */
  total: number;
  /** 1 フレームの所要時間（ms）。 */
  ms: number;
}

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D コンテキストを取得できませんでした');
    this.ctx = ctx;
  }

  /** CSS ピクセル寸法に合わせて実解像度を取り直す。 */
  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void {
    this.dpr = Math.max(1, devicePixelRatio);
    this.canvas.width = Math.max(1, Math.round(cssWidth * this.dpr));
    this.canvas.height = Math.max(1, Math.round(cssHeight * this.dpr));
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
  }

  draw(doc: CadDocument, view: CadView, opts: RenderOptions): RenderStats {
    const t0 = performance.now();
    const ctx = this.ctx;
    const colorCtx: ColorContext = {
      layers: doc.layers,
      background: opts.background,
      darkBoost: opts.darkBoost,
    };

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, view.width, view.height);

    if (opts.showGrid) this.drawGrid(view, opts);
    if (opts.showAxis) this.drawAxis(view, opts);

    const visible = doc.visibleIn(view.visibleWorld());
    for (const e of visible) {
      const highlight = opts.monochrome ? '#000000' : doc.selection.has(e.id) ? opts.selectionColor : undefined;
      this.drawEntity(e, view, doc, colorCtx, highlight, false, opts.lineWidthPxPerMm);
    }

    if (opts.preview) {
      ctx.save();
      ctx.globalAlpha = 0.8;
      for (const e of opts.preview) {
        this.drawEntity(e, view, doc, colorCtx, opts.selectionColor, true, opts.lineWidthPxPerMm);
      }
      ctx.restore();
    }

    if (opts.selectionBox) this.drawSelectionBox(view, opts);
    if (opts.snap) this.drawSnapMarker(view, opts.snap, opts.selectionColor);

    ctx.restore();
    return { drawn: visible.length, total: doc.count, ms: performance.now() - t0 };
  }

  /** オフスクリーンの PNG データ URL（動作確認・書き出し用）。 */
  toDataUrl(type = 'image/png'): string {
    return this.canvas.toDataURL(type);
  }

  /**
   * 用紙空間（レイアウト）を描く。ワールド＝**紙 mm・原点は紙の左下**。
   *
   * 1. 紙の輪郭と印刷可能領域
   * 2. ビューポート（**窓の中にモデル空間を映し、窓の外は切り取る**）
   * 3. 用紙空間に直接置いた図形（図枠・表題欄）。**線種尺度は用紙側**を使う
   */
  drawLayout(doc: CadDocument, layout: LayoutSpace, view: CadView, opts: LayoutRenderOptions): RenderStats {
    const t0 = performance.now();
    const ctx = this.ctx;
    const colorCtx: ColorContext = {
      layers: doc.layers,
      background: opts.background,
      darkBoost: opts.darkBoost,
    };

    const outline = opts.paperOutline !== false;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // 画面では紙の外を「机の色」にして紙を浮かせる。刷るときは紙一面を背景色で塗る
    ctx.fillStyle = outline
      ? isLightBackground(opts.background)
        ? '#8a8a8a'
        : '#2a2a2a'
      : opts.background;
    ctx.fillRect(0, 0, view.width, view.height);

    const size = paperExtentOf(layout);
    if (outline) this.drawPaper(view, size, opts);

    let drawn = 0;
    for (const vp of layout.viewports) {
      drawn += this.drawViewport(doc, vp, view, colorCtx, opts);
    }

    // 用紙空間の図形（紙 mm・線種尺度は用紙側）
    for (const e of layout.entities) {
      if (!doc.layers.isVisible(e.layer)) continue;
      const highlight = opts.monochrome ? '#000000' : doc.selection.has(e.id) ? opts.selectionColor : undefined;
      this.drawEntityWith(e, view, doc, colorCtx, layout.lineTypeScale, highlight, opts.lineWidthPxPerMm);
      drawn++;
    }

    if (opts.preview) {
      ctx.save();
      ctx.globalAlpha = 0.8;
      for (const e of opts.preview) {
        this.drawEntityWith(e, view, doc, colorCtx, layout.lineTypeScale, opts.selectionColor, opts.lineWidthPxPerMm, true);
      }
      ctx.restore();
    }
    if (opts.selectionBox) this.drawSelectionBox(view, opts);
    if (opts.snap) this.drawSnapMarker(view, opts.snap, opts.selectionColor);

    ctx.restore();
    return { drawn, total: layout.entities.length + layout.viewports.length, ms: performance.now() - t0 };
  }

  /** 紙の輪郭と印刷可能領域（余白の内側）。 */
  private drawPaper(view: CadView, size: { width: number; height: number }, opts: LayoutRenderOptions): void {
    const ctx = this.ctx;
    const a = view.toScreen({ x: 0, y: size.height });
    const b = view.toScreen({ x: size.width, y: 0 });

    ctx.save();
    ctx.setLineDash([]);
    ctx.fillStyle = opts.background;
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.strokeStyle = isLightBackground(opts.background) ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1;
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);

    // 印刷可能領域（余白の内側）を破線で
    const m = opts.margin;
    if (m > 0 && size.width > m * 2 && size.height > m * 2) {
      const ia = view.toScreen({ x: m, y: size.height - m });
      const ib = view.toScreen({ x: size.width - m, y: m });
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = isLightBackground(opts.background) ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.30)';
      ctx.strokeRect(ia.x, ia.y, ib.x - ia.x, ib.y - ia.y);
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  /**
   * ビューポート 1 つ。**窓の矩形で切り取ってから**モデル空間を紙座標へ移して描く。
   * 窓が複数あるとマスク（外側を塗りつぶす）では足りないので、`ctx.clip()` を使う。
   */
  private drawViewport(
    doc: CadDocument,
    vp: Viewport,
    view: CadView,
    colorCtx: ColorContext,
    opts: LayoutRenderOptions,
  ): number {
    const ctx = this.ctx;
    const corners = viewportCorners(vp).map((p) => view.toScreen(p));
    let drawn = 0;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(corners[0]!.x, corners[0]!.y);
    for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i]!.x, corners[i]!.y);
    ctx.closePath();
    ctx.clip();

    // 窓に映る範囲のモデル図形だけを取り出して、紙座標へ移す
    const extent = viewportModelExtent(vp);
    for (const e of doc.visibleIn(extent)) {
      const paperEntity = modelEntityToPaper(vp, e);
      const highlight = opts.monochrome ? '#000000' : undefined;
      // 窓の中の線種は**モデル側の尺度を縮尺で割った値**で刻む
      // （紙の上での見た目が図面の縮尺どおりになる）
      this.drawEntityWith(
        paperEntity,
        view,
        doc,
        colorCtx,
        doc.lineTypeScale / Math.max(1e-9, vp.scaleDenominator),
        highlight,
        opts.lineWidthPxPerMm,
      );
      drawn++;
    }
    ctx.restore();

    if (opts.viewportFrames === false) return drawn;

    // 窓の枠（選択中は目立たせる）
    ctx.save();
    ctx.setLineDash(doc.selection.has(vp.id) ? [] : [6, 3]);
    ctx.strokeStyle = doc.selection.has(vp.id)
      ? opts.selectionColor
      : isLightBackground(opts.background)
        ? 'rgba(0,0,0,0.45)'
        : 'rgba(255,255,255,0.45)';
    ctx.lineWidth = doc.selection.has(vp.id) ? 2 : 1;
    this.strokePath(corners, true);
    ctx.restore();
    return drawn;
  }

  private drawEntity(
    e: Entity,
    view: CadView,
    doc: CadDocument,
    colorCtx: ColorContext,
    highlight?: string,
    dashedPreview = false,
    lineWidthPxPerMm?: number,
  ): void {
    this.drawEntityWith(e, view, doc, colorCtx, doc.lineTypeScale, highlight, lineWidthPxPerMm, dashedPreview);
  }

  /**
   * 図形 1 つを描く。**線種尺度を外から渡す**ので、モデル空間（500）と
   * 用紙空間（5）とビューポートの中（尺度で割った値）を同じ道で描ける。
   */
  private drawEntityWith(
    e: Entity,
    view: CadView,
    doc: CadDocument,
    colorCtx: ColorContext,
    lineTypeScale: number,
    highlight?: string,
    lineWidthPxPerMm?: number,
    dashedPreview = false,
  ): void {
    const ctx = this.ctx;
    const color = highlight ?? effectiveColor(e, colorCtx);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth =
      lineWidthPxPerMm === undefined
        ? lineWidthPx(e.lineWidth, this.dpr)
        : printLineWidthPx(e.lineWidth, lineWidthPxPerMm);
    ctx.setLineDash(
      dashedPreview ? [4, 4] : dashArrayPx(effectiveLineStyle(e, doc.layers), lineTypeScale, view.scale),
    );

    switch (e.kind) {
      case 'point':
        this.drawPointMarker(view.toScreen(e.at));
        break;
      case 'text':
        this.drawText(e, view, color);
        break;
      case 'circle': {
        const c = view.toScreen(e.center);
        const r = view.toScreenLen(e.radius);
        if (r < 0.4) {
          // 小さすぎる円は 1px の点として描く（LOD）
          ctx.fillRect(c.x, c.y, 1, 1);
          break;
        }
        ctx.beginPath();
        ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case 'arc': {
        const c = view.toScreen(e.center);
        const r = view.toScreenLen(e.radius);
        if (r < 0.4) {
          ctx.fillRect(c.x, c.y, 1, 1);
          break;
        }
        ctx.beginPath();
        // 画面は Y 下向きなので、反時計回りの弧は時計回りとして渡す
        ctx.arc(c.x, c.y, r, -e.startAngle, -e.endAngle, true);
        ctx.stroke();
        break;
      }
      case 'rect': {
        const pts = rectCorners(e).map((p) => view.toScreen(p));
        this.strokePath(pts, true);
        break;
      }
      default: {
        for (const path of flatten(e)) {
          this.strokePath(
            path.map((p) => view.toScreen(p)),
            false,
          );
        }
      }
    }
    ctx.setLineDash([]);
  }

  private strokePath(screenPts: readonly Vec2[], close: boolean): void {
    if (screenPts.length < 2) return;
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(screenPts[0]!.x, screenPts[0]!.y);
    let last = screenPts[0]!;
    for (let i = 1; i < screenPts.length; i++) {
      const p = screenPts[i]!;
      // LOD: サブピクセルの移動は間引く（最後の点は必ず打つ）
      if (i !== screenPts.length - 1 && Math.abs(p.x - last.x) < 0.4 && Math.abs(p.y - last.y) < 0.4) continue;
      ctx.lineTo(p.x, p.y);
      last = p;
    }
    if (close) ctx.closePath();
    ctx.stroke();
  }

  private drawPointMarker(c: Vec2): void {
    const ctx = this.ctx;
    const s = 3;
    ctx.beginPath();
    ctx.moveTo(c.x - s, c.y);
    ctx.lineTo(c.x + s, c.y);
    ctx.moveTo(c.x, c.y - s);
    ctx.lineTo(c.x, c.y + s);
    ctx.stroke();
  }

  private drawText(e: TextEntity, view: CadView, color: string): void {
    const ctx = this.ctx;
    const px = view.toScreenLen(e.height);
    if (px < 3) return; // 読めない大きさは描かない（LOD）
    const at = view.toScreen(e.at);

    ctx.save();
    ctx.translate(at.x, at.y);
    ctx.rotate(-e.rotation); // ワールドは反時計回り、画面は時計回り
    ctx.fillStyle = color;
    ctx.font = `${px}px "Noto Sans JP", "Yu Gothic UI", sans-serif`;
    ctx.textAlign = e.hAlign === 'center' ? 'center' : e.hAlign === 'right' ? 'right' : 'left';
    ctx.textBaseline =
      e.vAlign === 'top' ? 'top' : e.vAlign === 'middle' ? 'middle' : e.vAlign === 'bottom' ? 'bottom' : 'alphabetic';

    const lines = e.text.split('\n');
    const lead = px * TEXT_LINE_GAP;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i]!, 0, i * lead);
    }
    ctx.restore();
  }

  private drawGrid(view: CadView, opts: RenderOptions): void {
    const ctx = this.ctx;
    let step = opts.gridSize;
    if (step <= 0) return;
    // 画面上の間隔が 8px を切るまで 10 倍ずつ間引く
    while (view.toScreenLen(step) < 8) step *= 10;

    const w = view.visibleWorld();
    const light = isLightBackground(opts.background);
    ctx.strokeStyle = light ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const x0 = Math.floor(w.minX / step) * step;
    for (let x = x0; x <= w.maxX; x += step) {
      const s = view.toScreen({ x, y: 0 });
      ctx.moveTo(s.x, 0);
      ctx.lineTo(s.x, view.height);
    }
    const y0 = Math.floor(w.minY / step) * step;
    for (let y = y0; y <= w.maxY; y += step) {
      const s = view.toScreen({ x: 0, y });
      ctx.moveTo(0, s.y);
      ctx.lineTo(view.width, s.y);
    }
    ctx.stroke();
  }

  private drawAxis(view: CadView, opts: RenderOptions): void {
    const ctx = this.ctx;
    const o = view.toScreen({ x: 0, y: 0 });
    const light = isLightBackground(opts.background);
    ctx.lineWidth = 1;
    ctx.strokeStyle = light ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.30)';
    ctx.beginPath();
    if (o.y >= 0 && o.y <= view.height) {
      ctx.moveTo(0, o.y);
      ctx.lineTo(view.width, o.y);
    }
    if (o.x >= 0 && o.x <= view.width) {
      ctx.moveTo(o.x, 0);
      ctx.lineTo(o.x, view.height);
    }
    ctx.stroke();
  }

  private drawSelectionBox(view: CadView, opts: RenderOptions): void {
    const sb = opts.selectionBox;
    if (!sb) return;
    const ctx = this.ctx;
    const a = view.toScreen({ x: sb.box.minX, y: sb.box.maxY });
    const b = view.toScreen({ x: sb.box.maxX, y: sb.box.minY });
    ctx.save();
    ctx.setLineDash(sb.crossing ? [4, 4] : []);
    ctx.strokeStyle = opts.selectionColor;
    ctx.fillStyle = sb.crossing ? 'rgba(255,59,48,0.08)' : 'rgba(0,122,255,0.08)';
    ctx.lineWidth = 1;
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.restore();
  }

  private drawSnapMarker(view: CadView, snap: SnapResult, color: string): void {
    const ctx = this.ctx;
    const c = view.toScreen(snap.at);
    const r = 5;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    switch (snap.kind) {
      case 'end':
        ctx.rect(c.x - r, c.y - r, r * 2, r * 2);
        break;
      case 'mid':
        ctx.moveTo(c.x - r, c.y + r);
        ctx.lineTo(c.x + r, c.y + r);
        ctx.lineTo(c.x, c.y - r);
        ctx.closePath();
        break;
      case 'center':
        ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
        break;
      case 'intersect':
        ctx.moveTo(c.x - r, c.y - r);
        ctx.lineTo(c.x + r, c.y + r);
        ctx.moveTo(c.x + r, c.y - r);
        ctx.lineTo(c.x - r, c.y + r);
        break;
      default:
        ctx.rect(c.x - r + 1, c.y - r + 1, r * 2 - 2, r * 2 - 2);
        break;
    }
    ctx.stroke();
    ctx.restore();
  }

  /** 円周上の点（外部から弧のプレビューを作るとき用）。 */
  static pointOnCircle(center: Vec2, radius: number, ang: number): Vec2 {
    return angleToPoint(center, radius, ang);
  }
}
