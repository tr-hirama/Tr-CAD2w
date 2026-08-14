/**
 * 画層と、画層ごとの色・線種の定義。
 *
 * ここが**色と線種の唯一の置き場**（デスクトップ版 TrCad2D の `LayerStyle.cs` に対応）。
 * 描画側で色を直に書かず、必ず `effectiveColor()` を通す。
 *
 * 黒で見せたい画層は `VB_BLACK`（= 白 / AutoCAD の色 7）として持つ。
 * 明るい背景では黒、暗い背景では白で描かれる（反転は `effectiveColor` の仕事）。
 */

import type { Entity, LineStyleName } from './entity.js';

/** AutoCAD 色 7 相当。明背景では黒・暗背景では白に反転して描く。 */
export const VB_BLACK = '#ffffff';

export interface Layer {
  name: string;
  color: string;
  lineStyle: LineStyleName;
  visible: boolean;
  /** 線幅（mm）。0 は極細。 */
  lineWidth: number;
}

export function makeLayer(name: string, color: string, lineStyle: LineStyleName = 'solid'): Layer {
  return { name, color, lineStyle, visible: true, lineWidth: 0 };
}

/**
 * 標準の画層定義。測量の語彙はデスクトップ版に合わせている。
 * 新しい画層を足すときはここだけを直す。
 */
export const STANDARD_LAYERS: readonly Layer[] = [
  makeLayer('0', VB_BLACK),
  makeLayer('境界', '#0000ff', 'dashdot'),
  makeLayer('道路', VB_BLACK),
  makeLayer('家屋', '#008000', 'dashed'),
  makeLayer('隣接', '#008000', 'dashed'),
  makeLayer('電柱', '#6699cc'),
  makeLayer('設備', VB_BLACK),
  makeLayer('外構', VB_BLACK),
  makeLayer('予備', '#a52a2a'),
  makeLayer('三斜', VB_BLACK, 'dashdot'),
  makeLayer('点番', VB_BLACK),
];

/**
 * 点番の先頭アルファベット → 画層名。
 * デスクトップ版 `LayerStyle.NameOfLetter` と同じ対応。
 */
export const LAYER_OF_LETTER: Readonly<Record<string, string>> = {
  K: '境界',
  R: '道路',
  O: '道路',
  H: '家屋',
  I: '隣接',
  D: '電柱',
  M: '設備',
  G: '外構',
  J: '外構',
  Q: '予備',
  P: '予備',
  U: '外構',
};

/** 点番（例 `K12`）から画層名を引く。対応が無ければ画層 `0`。 */
export function layerOfPointName(pointName: string): string {
  const head = pointName.trim().charAt(0).toUpperCase();
  return LAYER_OF_LETTER[head] ?? '0';
}

export class LayerTable {
  private readonly map = new Map<string, Layer>();

  constructor(layers: readonly Layer[] = STANDARD_LAYERS) {
    for (const l of layers) this.map.set(l.name, { ...l });
  }

  get(name: string): Layer | undefined {
    return this.map.get(name);
  }

  /** 無ければ既定の属性で作って返す（外部データ読込で未知の画層が来たとき）。 */
  ensure(name: string): Layer {
    const found = this.map.get(name);
    if (found) return found;
    const created = makeLayer(name, VB_BLACK);
    this.map.set(name, created);
    return created;
  }

  set(layer: Layer): void {
    this.map.set(layer.name, layer);
  }

  remove(name: string): boolean {
    if (name === '0') return false; // 画層 0 は消せない
    return this.map.delete(name);
  }

  all(): Layer[] {
    return [...this.map.values()];
  }

  isVisible(name: string): boolean {
    return this.map.get(name)?.visible ?? true;
  }
}

export interface ColorContext {
  layers: LayerTable;
  /** 背景色（`#rrggbb`）。無彩色の反転判定に使う。 */
  background: string;
  /** 暗背景で有彩色を持ち上げる量（0〜1）。 */
  darkBoost: number;
}

/**
 * 図形の実効色。**描画側はこれを必ず通す。**
 *
 * - 無彩色（白／黒）は背景に応じて反転する
 * - 有彩色は暗背景では `darkBoost` の分だけ持ち上げる
 */
export function effectiveColor(e: Entity, ctx: ColorContext): string {
  const base = e.color ?? ctx.layers.get(e.layer)?.color ?? VB_BLACK;
  const rgb = parseColor(base);
  if (!rgb) return base;

  const light = isLightBackground(ctx.background);
  const achromatic = rgb.r === rgb.g && rgb.g === rgb.b;

  if (achromatic) {
    return light ? formatColor({ r: 255 - rgb.r, g: 255 - rgb.g, b: 255 - rgb.b }) : base;
  }
  if (!light && ctx.darkBoost > 0) {
    const k = Math.min(1, Math.max(0, ctx.darkBoost));
    return formatColor({
      r: Math.round(rgb.r + (255 - rgb.r) * k),
      g: Math.round(rgb.g + (255 - rgb.g) * k),
      b: Math.round(rgb.b + (255 - rgb.b) * k),
    });
  }
  return base;
}

/** 図形の実効線種（ByLayer なら画層の線種）。 */
export function effectiveLineStyle(e: Entity, layers: LayerTable): LineStyleName {
  return e.lineStyle === 'solid' ? (layers.get(e.layer)?.lineStyle ?? 'solid') : e.lineStyle;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function parseColor(c: string): Rgb | null {
  const m = /^#([0-9a-f]{6})$/i.exec(c.trim());
  if (m) {
    const v = Number.parseInt(m[1]!, 16);
    return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
  }
  const s = /^#([0-9a-f]{3})$/i.exec(c.trim());
  if (s) {
    const h = s[1]!;
    const d = (i: number): number => Number.parseInt(h[i]!.repeat(2), 16);
    return { r: d(0), g: d(1), b: d(2) };
  }
  return null;
}

export function formatColor(c: Rgb): string {
  const h = (v: number): string => Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/** 背景が明るいか（輝度 ≧ 0.5）。 */
export function isLightBackground(background: string): boolean {
  const rgb = parseColor(background);
  if (!rgb) return true;
  const lum = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return lum >= 0.5;
}
