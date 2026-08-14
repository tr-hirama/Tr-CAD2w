import { describe, expect, it } from 'vitest';
import { dashArrayPx, lineWidthPx, patternInMm } from '../src/render/linetype.js';

describe('線種の刻み', () => {
  it('刻みは図面寸法（mm）× 線種尺度で決まる', () => {
    // 新規図面の尺度 500 での破線 = 線 250 / 空き 125（デスクトップ版と同じ値）
    expect(patternInMm('dashed', 500)).toEqual([250, 125]);
    expect(patternInMm('dashdot', 500)).toEqual([250, 125, 0, 125]);
    expect(patternInMm('center', 500)).toEqual([625, 125, 125, 125]);
  });

  it('実線は空配列', () => {
    expect(patternInMm('solid', 500)).toEqual([]);
    expect(dashArrayPx('solid', 500, 1)).toEqual([]);
  });

  it('縮小しすぎた破線は実線に落とす', () => {
    // 尺度 500・倍率 0.001 なら刻みは 0.375px 相当 → 実線
    expect(dashArrayPx('dashed', 500, 0.001)).toEqual([]);
  });

  it('拡大時は px の刻みが出る', () => {
    expect(dashArrayPx('dashed', 500, 0.1)).toEqual([25, 12.5]);
  });
});

describe('線幅', () => {
  it('0 は極細（1px）', () => {
    expect(lineWidthPx(0, 1)).toBe(1);
  });

  it('太い線は mm に比例する（ズームには追従しない）', () => {
    expect(lineWidthPx(0.5, 1)).toBe(1);
    expect(lineWidthPx(2, 1)).toBe(4);
  });
});
