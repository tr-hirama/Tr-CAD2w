/**
 * 用紙・尺度・ページ割付の純ロジック（UI から独立）。
 *
 * 単位はすべて **mm**。ワールドも mm なので、尺度 1:1 では
 * **図面上 100mm の線が紙の上でも 100mm** になる。
 *
 * | 尺度の指定 | 意味 |
 * |---|---|
 * | `fit` | 図面全体が 1 ページの印刷可能領域に収まる倍率 |
 * | `ratio` (1:N) | 紙 1mm = 図面 N mm。1:1 は等倍 |
 */

import type { Aabb } from '../core/geometry.js';

export interface PaperSize {
  name: string;
  /** 縦向きのときの幅（mm）。 */
  width: number;
  /** 縦向きのときの高さ（mm）。 */
  height: number;
}

/** 用紙サイズ（縦向きの寸法）。 */
export const PAPER_SIZES: readonly PaperSize[] = [
  { name: 'A4', width: 210, height: 297 },
  { name: 'A3', width: 297, height: 420 },
  { name: 'A2', width: 420, height: 594 },
  { name: 'A1', width: 594, height: 841 },
  { name: 'A0', width: 841, height: 1189 },
  { name: 'B4', width: 257, height: 364 },
  { name: 'B3', width: 364, height: 515 },
  { name: 'Letter', width: 216, height: 279 },
];

export type Orientation = 'portrait' | 'landscape';

export type PrintScale = { kind: 'fit' } | { kind: 'ratio'; denominator: number };

export interface PrintSettings {
  /** 用紙名（`PAPER_SIZES` の `name`）。 */
  paper: string;
  orientation: Orientation;
  /** カラー / モノクロ。 */
  color: 'color' | 'mono';
  scale: PrintScale;
  /** 余白（mm）。四辺とも同じ。 */
  margin: number;
  /** 図面が 1 ページに収まらないとき、複数ページへ分割するか。 */
  multiPage: boolean;
  /** 印刷解像度（dpi）。画面の canvas をそのまま伸ばすと線が粗くなるので描き直す。 */
  dpi: number;
}

export const DEFAULT_PRINT: PrintSettings = {
  paper: 'A4',
  orientation: 'landscape',
  color: 'color',
  scale: { kind: 'fit' },
  margin: 5,
  multiPage: false,
  dpi: 300,
};

/**
 * canvas の上限。**超えると描画が黙って無視され、`toDataURL` が `data:,` を返す**
 * （例外は出ない）。そのまま印刷すると真っ白な紙が出る。
 * Chromium の面積上限は 2^28 px、1 辺は 16384 px。安全側に少し余裕を取る。
 */
export const MAX_CANVAS_EDGE = 16384;
export const MAX_CANVAS_AREA = 2.4e8;

/** 1 回の印刷で許すページ数の上限。これを超える設定は割付を作らない。 */
export const MAX_PAGES = 200;

export function paperByName(name: string): PaperSize {
  return PAPER_SIZES.find((p) => p.name === name) ?? PAPER_SIZES[0]!;
}

/**
 * 実際に使える dpi。
 *
 * 指定 dpi のままだと canvas の上限を超える場合（A0 600dpi など）に**自動で落とす**。
 * 落としたことは呼び出し側が利用者に伝える。
 */
export function effectiveDpi(settings: PrintSettings): number {
  const dpi = Number.isFinite(settings.dpi) && settings.dpi > 0 ? settings.dpi : DEFAULT_PRINT.dpi;
  const e = paperExtent(settings);
  const w = mmToPx(e.width, dpi);
  const h = mmToPx(e.height, dpi);
  if (w <= 0 || h <= 0) return dpi;
  const k = Math.min(1, MAX_CANVAS_EDGE / Math.max(w, h), Math.sqrt(MAX_CANVAS_AREA / (w * h)));
  return k >= 1 ? dpi : Math.max(36, Math.floor(dpi * k));
}

/** 余白の上限（用紙の短辺の半分未満）。これを超えると印刷可能領域が消える。 */
export function clampMargin(paper: string, orientation: Orientation, margin: number): number {
  const p = paperByName(paper);
  const shorter = Math.min(p.width, p.height);
  void orientation; // 向きを変えても短辺は同じ
  const max = Math.max(0, shorter / 2 - 1);
  if (!Number.isFinite(margin) || margin < 0) return 0;
  return Math.min(margin, max);
}

/** 向きを考えた用紙寸法（mm）。 */
export function paperExtent(settings: PrintSettings): { width: number; height: number } {
  const p = paperByName(settings.paper);
  return settings.orientation === 'landscape'
    ? { width: p.height, height: p.width }
    : { width: p.width, height: p.height };
}

/**
 * 余白を除いた印刷可能領域（mm）。
 * 余白は用紙の短辺の半分未満にクランプする（過大な余白で全面が余白になるのを防ぐ）。
 */
export function printableArea(settings: PrintSettings): { width: number; height: number } {
  const e = paperExtent(settings);
  const m = clampMargin(settings.paper, settings.orientation, settings.margin);
  return {
    width: Math.max(1, e.width - m * 2),
    height: Math.max(1, e.height - m * 2),
  };
}

/**
 * 縮尺（**紙 mm / 図面 mm**）。1:100 なら 0.01。
 * `fit` は図面全体が 1 ページに収まる値。空の図面は 1（等倍）。
 */
export function paperPerWorld(settings: PrintSettings, bounds: Aabb): number {
  if (settings.scale.kind === 'ratio') {
    const n = settings.scale.denominator;
    // 極小・極大・NaN の分母をそのまま通すと、1 ページの world 幅が 0 になって
    // ページ数が発散する
    return Number.isFinite(n) && n > 0 ? 1 / n : 1;
  }
  const area = printableArea(settings);
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  if (!(w >= 0 && h >= 0) || (w === 0 && h === 0)) return 1;
  const sx = w === 0 ? Infinity : area.width / w;
  const sy = h === 0 ? Infinity : area.height / h;
  const s = Math.min(sx, sy);
  return Number.isFinite(s) && s > 0 ? s : 1;
}

/** 尺度の分母（1:N の N）。表示用。 */
export function scaleDenominator(settings: PrintSettings, bounds: Aabb): number {
  const s = paperPerWorld(settings, bounds);
  return s > 0 ? 1 / s : 1;
}

/** 1 ページに映る図面の範囲（ワールド mm）。 */
export function worldPerPage(settings: PrintSettings, bounds: Aabb): { width: number; height: number } {
  const area = printableArea(settings);
  const s = paperPerWorld(settings, bounds);
  return { width: area.width / s, height: area.height / s };
}

export interface PageSpec {
  /** 0 始まりの通し番号。 */
  index: number;
  col: number;
  row: number;
  /** このページに映る図面の範囲（ワールド）。 */
  worldBox: Aabb;
}

export interface PageLayout {
  cols: number;
  rows: number;
  pages: PageSpec[];
  /** 紙 mm / 図面 mm。 */
  paperPerWorld: number;
  /**
   * ページ数が `MAX_PAGES` を超えたので**割付を作らなかった**。
   * 尺度か用紙を見直してもらう（作ると数千枚の canvas でタブが落ちる）。
   */
  tooManyPages?: boolean;
  /** 上限を超えたときに本来必要だったページ数。 */
  requestedPages?: number;
}

/**
 * ページ割付。
 *
 * - `multiPage: false` は**常に 1 ページ**。図面の中心を紙の中心に合わせる
 *   （収まらない分は切れる）
 * - `multiPage: true` は左下から右上へ格子状に分割する。**行は下から上**
 *   （ワールドが Y 上向きなので、1 ページ目が図面の左下になる）
 */
export function pageLayout(settings: PrintSettings, bounds: Aabb): PageLayout {
  const s = paperPerWorld(settings, bounds);
  const wpp = worldPerPage(settings, bounds);
  const empty = !(bounds.minX <= bounds.maxX && bounds.minY <= bounds.maxY);

  if (empty) {
    const box: Aabb = { minX: 0, minY: 0, maxX: wpp.width, maxY: wpp.height };
    return { cols: 1, rows: 1, paperPerWorld: s, pages: [{ index: 0, col: 0, row: 0, worldBox: box }] };
  }

  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;

  if (!settings.multiPage) {
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    const box: Aabb = {
      minX: cx - wpp.width / 2,
      minY: cy - wpp.height / 2,
      maxX: cx + wpp.width / 2,
      maxY: cy + wpp.height / 2,
    };
    return { cols: 1, rows: 1, paperPerWorld: s, pages: [{ index: 0, col: 0, row: 0, worldBox: box }] };
  }

  // 1 ページに映る範囲が 0 だと分割数が発散する
  if (!(wpp.width > 0 && wpp.height > 0)) {
    const box: Aabb = { minX: bounds.minX, minY: bounds.minY, maxX: bounds.minX, maxY: bounds.minY };
    return { cols: 1, rows: 1, paperPerWorld: s, pages: [{ index: 0, col: 0, row: 0, worldBox: box }] };
  }

  const cols = Math.max(1, Math.ceil(roundTiny(w / wpp.width)));
  const rows = Math.max(1, Math.ceil(roundTiny(h / wpp.height)));

  // 数千ページを作ると全ページぶんの canvas でタブが落ちる。作らずに知らせる
  if (cols * rows > MAX_PAGES) {
    return {
      cols,
      rows,
      pages: [],
      paperPerWorld: s,
      tooManyPages: true,
      requestedPages: cols * rows,
    };
  }

  const pages: PageSpec[] = [];
  let index = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const minX = bounds.minX + col * wpp.width;
      const minY = bounds.minY + row * wpp.height;
      pages.push({
        index: index++,
        col,
        row,
        worldBox: { minX, minY, maxX: minX + wpp.width, maxY: minY + wpp.height },
      });
    }
  }
  return { cols, rows, pages, paperPerWorld: s };
}

/**
 * 浮動小数の誤差で 1 ページ多く出るのを防ぐ。
 * （`3.0000000000000004 / 3` のような値を 3 に丸める）
 */
function roundTiny(v: number): number {
  const r = Math.round(v);
  return Math.abs(v - r) < 1e-9 ? r : v;
}

/** mm → 印刷解像度のピクセル。 */
export function mmToPx(mm: number, dpi: number): number {
  return (mm / 25.4) * dpi;
}

/**
 * 用紙 1 枚のピクセル寸法（印刷用 canvas の大きさ）。
 * **canvas の上限を超えないよう dpi を自動で落とす**（`effectiveDpi`）。
 */
export function paperPixels(settings: PrintSettings): { width: number; height: number } {
  const e = paperExtent(settings);
  const dpi = effectiveDpi(settings);
  return {
    width: Math.max(1, Math.round(mmToPx(e.width, dpi))),
    height: Math.max(1, Math.round(mmToPx(e.height, dpi))),
  };
}

/** 尺度の表示文字列。`1:250` / `1:1`（等倍）。 */
export function formatScale(settings: PrintSettings, bounds: Aabb): string {
  const n = scaleDenominator(settings, bounds);
  if (Math.abs(n - 1) < 1e-9) return '1:1（等倍）';
  if (n >= 1) return `1:${formatDenominator(n)}`;
  return `${formatDenominator(1 / n)}:1`;
}

function formatDenominator(n: number): string {
  if (n >= 100) return String(Math.round(n));
  // 末尾の 0 は繰り返し落とす（2.00 → 2、2.50 → 2.5）
  const digits = n >= 10 ? 1 : 2;
  return n.toFixed(digits).replace(/\.?0+$/, '');
}
