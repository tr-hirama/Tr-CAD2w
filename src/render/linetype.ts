/**
 * 線種の刻み。
 *
 * **刻みは図面の寸法（mm）で決まる**（AutoCAD と同じ）。ズームすると画面上の
 * 破線の本数が変わり、印刷でも縮尺どおりの長さになる。
 * 実際の刻み = 線種定義 × 線種尺度（LTSCALE 相当。新規図面は 500）。
 *
 * **線幅だけは画面固定**（ズーム非依存）。これはデスクトップ版 TrCad2D に
 * 合わせた意図的な非対称。
 */

import type { LineStyleName } from '../core/entity.js';

/** 線種定義（線種尺度 1 のときの mm 列。線→空き→線→空き…）。 */
const PATTERNS: Record<LineStyleName, number[]> = {
  solid: [],
  dashed: [0.5, 0.25],
  dotted: [0, 0.25],
  dashdot: [0.5, 0.25, 0, 0.25],
  center: [1.25, 0.25, 0.25, 0.25],
};

export const LINE_STYLE_LABEL: Record<LineStyleName, string> = {
  solid: '実線',
  dashed: '破線',
  dotted: '点線',
  dashdot: '一点鎖線',
  center: '中心線',
};

/** 図面上の刻み（mm）。線種尺度を掛けた値。 */
export function patternInMm(style: LineStyleName, lineTypeScale: number): number[] {
  return PATTERNS[style].map((v) => v * lineTypeScale);
}

/**
 * Canvas の `setLineDash` に渡す画面 px の刻み。
 * 空配列なら実線。刻みが 0.5px を切ると実線に見えるので、その手前で実線に落とす
 * （破線を細かく描き続けても見た目が変わらないうえ遅い）。
 */
export function dashArrayPx(style: LineStyleName, lineTypeScale: number, scale: number): number[] {
  const mm = patternInMm(style, lineTypeScale);
  if (mm.length === 0) return [];
  const px = mm.map((v) => v * scale);
  const total = px.reduce((a, b) => a + b, 0);
  if (total < 1.5) return []; // 縮小しすぎ → 実線に見える
  // 「点」は 0 だと Canvas が描かないので極小の長さを与える
  return px.map((v) => (v === 0 ? Math.max(0.5, 0.15 * scale * lineTypeScale) : v));
}

/** 線幅（mm）→ 画面 px。0 は極細（1px）。画面固定なのでズームには追従しない。 */
export function lineWidthPx(lineWidthMm: number, devicePixelRatio: number): number {
  if (lineWidthMm <= 0) return 1;
  // mm を「1mm ≒ 2px」の目安で画面幅に換算する（デスクトップ版の見た目に寄せた係数）
  return Math.max(1, lineWidthMm * 2 * Math.max(1, devicePixelRatio)) / Math.max(1, devicePixelRatio);
}

/**
 * 極細（線幅 0）を紙に出すときの太さ（mm）。ISO の細線に合わせた値。
 *
 * **画面の 1px をそのまま印刷に使ってはいけない。** 300dpi では 1px = 0.085mm で、
 * アンチエイリアスに溶けて灰色の線になる（黒で出ない）。
 */
export const HAIRLINE_MM = 0.18;

/**
 * 線幅（mm）→ 印刷 px。**紙の上で実寸になる**。
 * `pxPerMm` は `dpi / 25.4`。
 */
export function printLineWidthPx(lineWidthMm: number, pxPerMm: number): number {
  const mm = lineWidthMm > 0 ? lineWidthMm : HAIRLINE_MM;
  return Math.max(1, mm * pxPerMm);
}
