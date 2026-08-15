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
import type { DimEntity, Entity, HatchEntity, ImageEntity, TextEntity } from '../core/entity.js';
import { TEXT_LINE_GAP, angleToPoint, flatten, rectCorners } from '../core/entity.js';
import { hatchSegments } from '../core/hatch.js';
import { dimGeometry } from '../core/dim-geom.js';
import { effectiveColor, effectiveLineStyle, isLightBackground, type ColorContext } from '../core/layer.js';
import { dashArrayPx, lineWidthPx, printLineWidthPx } from './linetype.js';
import type { SnapResult } from '../core/snap.js';
import { isPointVisible, pointMarker, type PointStyle } from '../core/point-style.js';
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
    // 画像は常に最背面（線や文字を隠さない）
    for (const e of visible) {
      if (e.kind !== 'image') continue;
      this.drawImage(e, view);
    }
    for (const e of visible) {
      if (e.kind === 'image') continue;
      const highlight = opts.monochrome ? '#000000' : doc.selection.has(e.id) ? opts.selectionColor : undefined;
      // 挿入は中身を展開して描く（属性は中身のものを使う）
      if (e.kind === 'insert') {
        for (const x of doc.explode(e)) {
          this.drawEntity(x, view, doc, colorCtx, highlight, false, opts.lineWidthPxPerMm);
        }
        continue;
      }
      this.drawEntity(e, view, doc, colorCtx, highlight, false, opts.lineWidthPxPerMm);
    }
    // 選択された画像だけは枠を見せる（選んだことが分かるように）
    for (const e of visible) {
      if (e.kind !== 'image' || !doc.selection.has(e.id)) continue;
      ctx.save();
      ctx.strokeStyle = opts.selectionColor;
      ctx.lineWidth = 1;
      this.strokePath(rectCorners({ ...e, kind: 'rect' }).map((p) => view.toScreen(p)), true);
      ctx.restore();
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
        this.drawPointMarker(view.toScreen(e.at), doc.pointStyle, view.scale);
        break;
      case 'text':
        this.drawText(e, view, color);
        break;
      case 'hatch':
        this.drawHatch(e, view, color);
        break;
      case 'image':
        this.drawImage(e, view);
        break;
      case 'insert':
        // 展開して描くのは `draw` の役目。ここへは来ない
        break;
      case 'dim':
        this.drawDim(e, view, color);
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

  /**
   * 点マーカー。**形とサイズは図面全体の点スタイル**（`PDMODE` / `PDSIZE` 相当）で決まる。
   * 組み立ては `point-style.ts` の純関数に任せ、ここは描くだけ。
   */
  private drawPointMarker(c: Vec2, style: PointStyle, viewScale: number): void {
    if (!isPointVisible(style.mode)) return;
    const ctx = this.ctx;
    const m = pointMarker(style, c, viewScale);

    ctx.setLineDash([]); // 点マーカーは線種の刻みを持たない
    if (m.lines.length > 0) {
      ctx.beginPath();
      for (const [a, b] of m.lines) {
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
    }
    if (m.dotRadius > 0) {
      ctx.beginPath();
      ctx.arc(c.x, c.y, m.dotRadius, 0, Math.PI * 2);
      ctx.fill();
    }
    if (m.circle) {
      ctx.beginPath();
      ctx.arc(c.x, c.y, m.half, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (m.square) ctx.strokeRect(c.x - m.half, c.y - m.half, m.half * 2, m.half * 2);
  }

  private drawText(e: TextEntity, view: CadView, color: string): void {
    this.drawTextAt(e.text, view.toScreen(e.at), view.toScreenLen(e.height), e.rotation, e.hAlign, e.vAlign, color);
  }

  /** 文字列を画面座標へ描く（`text` 図形と寸法値で共用）。 */
  private drawTextAt(
    text: string,
    at: Vec2,
    px: number,
    rotation: number,
    hAlign: TextEntity['hAlign'],
    vAlign: TextEntity['vAlign'],
    color: string,
  ): void {
    const ctx = this.ctx;
    if (px < 3) return; // 読めない大きさは描かない（LOD）

    ctx.save();
    ctx.translate(at.x, at.y);
    ctx.rotate(-rotation); // ワールドは反時計回り、画面は時計回り
    ctx.fillStyle = color;
    ctx.setLineDash([]); // 文字は線種の刻みを引き継がない
    ctx.font = `${px}px "Noto Sans JP", "Yu Gothic UI", sans-serif`;
    ctx.textAlign = hAlign === 'center' ? 'center' : hAlign === 'right' ? 'right' : 'left';
    ctx.textBaseline =
      vAlign === 'top' ? 'top' : vAlign === 'middle' ? 'middle' : vAlign === 'bottom' ? 'bottom' : 'alphabetic';

    const lines = text.split('\n');
    const lead = px * TEXT_LINE_GAP;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i]!, 0, i * lead);
    }
    ctx.restore();
  }

  /**
   * ハッチ。`solid` は境界を塗り、それ以外は走査線を引く。
   * 線分は `hatch.ts` が毎回作る（境界を動かせば塗りも追従する）。
   */
  private drawHatch(e: HatchEntity, view: CadView, color: string): void {
    const ctx = this.ctx;
    if (e.points.length < 3) return;
    const screen = e.points.map((p) => view.toScreen(p));

    if (e.pattern === 'solid') {
      ctx.beginPath();
      ctx.moveTo(screen[0]!.x, screen[0]!.y);
      for (let i = 1; i < screen.length; i++) ctx.lineTo(screen[i]!.x, screen[i]!.y);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      return;
    }

    ctx.setLineDash([]); // 塗りの線は線種の刻みを持たない
    for (const [a, b] of hatchSegments(e)) {
      this.strokePath([view.toScreen(a), view.toScreen(b)], false);
    }
    // 境界も薄く見せる（掴む手がかり）
    this.strokePath(screen, true);
  }

  /**
   * ラスタ画像。
   *
   * **バイト列から作った `Image` はフレームをまたいでキャッシュする。**
   * 毎フレーム作り直すと復号が走って描画が止まる。読み込みが終わるまでは
   * 何も描かず、終わったら次のフレームで出る。
   */
  private drawImage(e: ImageEntity, view: CadView): void {
    const img = this.imageFor(e.dataUrl);
    if (!img || !img.complete || img.naturalWidth === 0) return;
    const a = view.toScreen({ x: Math.min(e.a.x, e.b.x), y: Math.max(e.a.y, e.b.y) });
    const b = view.toScreen({ x: Math.max(e.a.x, e.b.x), y: Math.min(e.a.y, e.b.y) });
    const w = b.x - a.x;
    const h = b.y - a.y;
    if (!(w > 0) || !(h > 0)) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = Math.min(1, Math.max(0, e.opacity));
    ctx.drawImage(img, a.x, a.y, w, h);
    ctx.restore();
  }

  private readonly imageCache = new Map<string, HTMLImageElement>();

  /**
   * 画像の読み込みが終わったときに呼ぶ。
   *
   * **これが無いと、置いた画像は次に何か操作するまで画面に出ない**
   * （復号が終わっても描き直しが起きないため）。`CadApp` が再描画を繋ぐ。
   */
  onImageLoad: (() => void) | null = null;

  private imageFor(dataUrl: string): HTMLImageElement | null {
    if (dataUrl === '') return null;
    const hit = this.imageCache.get(dataUrl);
    if (hit) return hit;
    if (typeof Image === 'undefined') return null; // テスト（DOM なし）では描かない
    const img = new Image();
    img.addEventListener('load', () => this.onImageLoad?.());
    img.src = dataUrl;
    this.imageCache.set(dataUrl, img);
    return img;
  }

  /**
   * 寸法。引出線・寸法線は実線で、**矢印は塗りつぶし**、寸法値は文字として描く。
   * 幾何は毎フレーム `dimGeometry` が作る（計測点を動かせば値も追従する）。
   */
  private drawDim(e: DimEntity, view: CadView, color: string): void {
    const g = dimGeometry(e);
    if (!g) return;
    const ctx = this.ctx;

    // 寸法の線は線種の刻みを持たない（AutoCAD も寸法線は実線で引く）
    ctx.setLineDash([]);
    for (const [a, b] of g.lines) {
      this.strokePath([view.toScreen(a), view.toScreen(b)], false);
    }

    for (const tri of g.arrows) {
      const p = tri.map((q) => view.toScreen(q));
      ctx.beginPath();
      ctx.moveTo(p[0]!.x, p[0]!.y);
      for (let i = 1; i < p.length; i++) ctx.lineTo(p[i]!.x, p[i]!.y);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    }

    if (g.text !== '') {
      this.drawTextAt(
        g.text,
        view.toScreen(g.textPos),
        view.toScreenLen(g.textHeight),
        g.textAngle,
        'center',
        'bottom',
        color,
      );
    }
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
