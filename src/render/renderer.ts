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
import type { Entity, HatchEntity, ImageEntity, TextEntity } from '../core/entity.js';
import { TEXT_LINE_GAP, angleToPoint, flatten, rectCorners } from '../core/entity.js';
import { hatchSegments } from '../core/hatch.js';
import { effectiveColor, effectiveLineStyle, isLightBackground, type ColorContext } from '../core/layer.js';
import { dashArrayPx, lineWidthPx, printLineWidthPx } from './linetype.js';
import type { SnapResult } from '../core/snap.js';

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

  private drawEntity(
    e: Entity,
    view: CadView,
    doc: CadDocument,
    colorCtx: ColorContext,
    highlight?: string,
    dashedPreview = false,
    lineWidthPxPerMm?: number,
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
      dashedPreview ? [4, 4] : dashArrayPx(effectiveLineStyle(e, doc.layers), doc.lineTypeScale, view.scale),
    );

    switch (e.kind) {
      case 'point':
        this.drawPointMarker(view.toScreen(e.at));
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
