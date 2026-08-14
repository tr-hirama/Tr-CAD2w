import { describe, expect, it } from 'vitest';
import type { Aabb } from '../src/core/geometry.js';
import {
  DEFAULT_PRINT,
  MAX_CANVAS_AREA,
  MAX_CANVAS_EDGE,
  MAX_PAGES,
  clampMargin,
  effectiveDpi,
  formatScale,
  mmToPx,
  pageLayout,
  paperByName,
  paperExtent,
  paperPerWorld,
  paperPixels,
  printableArea,
  scaleDenominator,
  worldPerPage,
  type PrintSettings,
} from '../src/print/paper.js';

function settings(over: Partial<PrintSettings> = {}): PrintSettings {
  return { ...DEFAULT_PRINT, ...over };
}

/** 図面の範囲（mm）。 */
function box(w: number, h: number, x = 0, y = 0): Aabb {
  return { minX: x, minY: y, maxX: x + w, maxY: y + h };
}

const EMPTY: Aabb = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

describe('用紙', () => {
  it('A4 は 210×297mm。横向きで入れ替わる', () => {
    expect(paperByName('A4')).toMatchObject({ width: 210, height: 297 });
    expect(paperExtent(settings({ paper: 'A4', orientation: 'portrait' }))).toEqual({ width: 210, height: 297 });
    expect(paperExtent(settings({ paper: 'A4', orientation: 'landscape' }))).toEqual({ width: 297, height: 210 });
  });

  it('未知の用紙名は先頭（A4）に倒す', () => {
    expect(paperByName('存在しない').name).toBe('A4');
  });

  it('印刷可能領域は余白を四辺から引く', () => {
    expect(printableArea(settings({ paper: 'A4', orientation: 'landscape', margin: 10 }))).toEqual({
      width: 277,
      height: 190,
    });
  });

  it('余白が用紙より大きいときはクランプして印刷可能領域を残す', () => {
    // A4 の短辺 210mm → 余白は 104mm まで。全面が余白になると全ページ白紙になる
    const a = printableArea(settings({ paper: 'A4', orientation: 'landscape', margin: 500 }));
    expect(a.width).toBe(297 - 104 * 2);
    expect(a.height).toBe(210 - 104 * 2);
  });
});

describe('尺度', () => {
  it('1:1 は等倍。図面 100mm が紙 100mm になる', () => {
    // 受け入れ条件（issue #14）: A4 横 1:1 で 図面上 100mm の線が紙の上でも 100mm
    const s = settings({ paper: 'A4', orientation: 'landscape', scale: { kind: 'ratio', denominator: 1 } });
    expect(paperPerWorld(s, box(100, 50))).toBe(1);
    const paperMm = 100 * paperPerWorld(s, box(100, 50));
    expect(paperMm).toBe(100);
  });

  it('1:250 は 図面 250mm が紙 1mm', () => {
    const s = settings({ scale: { kind: 'ratio', denominator: 250 } });
    expect(paperPerWorld(s, box(1000, 1000))).toBe(1 / 250);
    expect(250 * paperPerWorld(s, box(1000, 1000))).toBe(1);
  });

  it('不正な分母（0 以下）は等倍に倒す', () => {
    expect(paperPerWorld(settings({ scale: { kind: 'ratio', denominator: 0 } }), box(10, 10))).toBe(1);
  });

  it('ページに合わせる（fit）は厳しい方の辺で決まる', () => {
    // A4 横・余白 0 → 印刷可能領域 297×210。図面 594×210 なら幅で決まって 1/2
    const s = settings({ paper: 'A4', orientation: 'landscape', margin: 0, scale: { kind: 'fit' } });
    expect(paperPerWorld(s, box(594, 210))).toBe(0.5);
    // 図面 297×420 なら高さで決まって 0.5
    expect(paperPerWorld(s, box(297, 420))).toBe(0.5);
  });

  it('空の図面は等倍にする（0 除算を作らない）', () => {
    expect(paperPerWorld(settings({ scale: { kind: 'fit' } }), EMPTY)).toBe(1);
    expect(paperPerWorld(settings({ scale: { kind: 'fit' } }), box(0, 0))).toBe(1);
  });

  it('尺度の分母は 1/縮尺', () => {
    const s = settings({ paper: 'A4', orientation: 'landscape', margin: 0, scale: { kind: 'fit' } });
    expect(scaleDenominator(s, box(594, 210))).toBe(2);
  });

  it('表示は 1:N の形', () => {
    const bounds = box(1000, 500);
    expect(formatScale(settings({ scale: { kind: 'ratio', denominator: 1 } }), bounds)).toBe('1:1（等倍）');
    expect(formatScale(settings({ scale: { kind: 'ratio', denominator: 250 } }), bounds)).toBe('1:250');
    // 拡大側は N:1
    expect(formatScale(settings({ scale: { kind: 'ratio', denominator: 0.5 } }), bounds)).toBe('2:1');
  });
});

describe('1 ページに映る範囲', () => {
  it('印刷可能領域 ÷ 縮尺', () => {
    const s = settings({ paper: 'A4', orientation: 'landscape', margin: 0, scale: { kind: 'ratio', denominator: 4 } });
    // 297×210 の紙に 1:4 → 図面 1188×840 が入る
    expect(worldPerPage(s, box(100, 100))).toEqual({ width: 1188, height: 840 });
  });
});

describe('ページ割付', () => {
  const base = settings({ paper: 'A4', orientation: 'landscape', margin: 0, scale: { kind: 'ratio', denominator: 1 } });

  it('分割しない設定なら常に 1 ページで、図面の中心が紙の中心に来る', () => {
    const layout = pageLayout({ ...base, multiPage: false }, box(1000, 1000));
    expect(layout.pages).toHaveLength(1);
    expect(layout.cols).toBe(1);
    expect(layout.rows).toBe(1);
    const p = layout.pages[0]!;
    expect((p.worldBox.minX + p.worldBox.maxX) / 2).toBe(500);
    expect((p.worldBox.minY + p.worldBox.maxY) / 2).toBe(500);
    // 1 ページに映るのは 297×210 ぶんだけ（はみ出しは切れる）
    expect(p.worldBox.maxX - p.worldBox.minX).toBe(297);
  });

  it('分割する設定なら格子に並ぶ（行は下から上）', () => {
    // 図面 594×420 は A4 横 1:1 でちょうど 2×2
    const layout = pageLayout({ ...base, multiPage: true }, box(594, 420));
    expect([layout.cols, layout.rows]).toEqual([2, 2]);
    expect(layout.pages).toHaveLength(4);
    expect(layout.pages[0]).toMatchObject({ index: 0, col: 0, row: 0 });
    expect(layout.pages[0]!.worldBox).toEqual({ minX: 0, minY: 0, maxX: 297, maxY: 210 });
    expect(layout.pages[3]!.worldBox).toEqual({ minX: 297, minY: 210, maxX: 594, maxY: 420 });
  });

  it('端数は切り上げる', () => {
    const layout = pageLayout({ ...base, multiPage: true }, box(300, 100));
    expect([layout.cols, layout.rows]).toEqual([2, 1]);
  });

  it('ちょうど割り切れるときに 1 ページ余らせない（浮動小数の丸め）', () => {
    // 297×3 = 891。誤差で 4 ページになりやすいところ
    const layout = pageLayout({ ...base, multiPage: true }, box(891, 210));
    expect(layout.cols).toBe(3);
    expect(layout.pages).toHaveLength(3);
  });

  it('空の図面でも 1 ページ返す', () => {
    const layout = pageLayout({ ...base, multiPage: true }, EMPTY);
    expect(layout.pages).toHaveLength(1);
  });

  it('割付の縮尺は paperPerWorld と一致する', () => {
    const s = { ...base, scale: { kind: 'fit' } as const };
    const bounds = box(1000, 400);
    expect(pageLayout(s, bounds).paperPerWorld).toBe(paperPerWorld(s, bounds));
  });
});

/** レビューで見つかった実害（白紙・ハング）を固定する。 */
describe('canvas とページ数の上限', () => {
  it('大判 × 高解像度では dpi を自動で落とす', () => {
    // A0 600dpi は 19866×28087 = 5.6億px。Chromium の上限（2^28px・1辺16384）を超え、
    // 描画が黙って無視されて白紙が刷られる
    const a0 = settings({ paper: 'A0', orientation: 'landscape', dpi: 600 });
    expect(effectiveDpi(a0)).toBeLessThan(600);
    const px = paperPixels(a0);
    expect(Math.max(px.width, px.height)).toBeLessThanOrEqual(MAX_CANVAS_EDGE);
    expect(px.width * px.height).toBeLessThanOrEqual(MAX_CANVAS_AREA);
  });

  it('収まる組み合わせでは dpi を落とさない', () => {
    expect(effectiveDpi(settings({ paper: 'A4', orientation: 'landscape', dpi: 600 }))).toBe(600);
    expect(effectiveDpi(settings({ paper: 'A3', dpi: 300 }))).toBe(300);
  });

  it('不正な dpi は既定に倒す', () => {
    expect(effectiveDpi(settings({ dpi: Number.NaN }))).toBe(DEFAULT_PRINT.dpi);
    expect(effectiveDpi(settings({ dpi: 0 }))).toBe(DEFAULT_PRINT.dpi);
  });

  it('ページ数が上限を超える設定では割付を作らない', () => {
    // A4 に 1:0.01（100倍拡大）で 1000×1000mm を刷ろうとすると数万ページになる
    const s = settings({ multiPage: true, scale: { kind: 'ratio', denominator: 0.01 } });
    const layout = pageLayout(s, box(1000, 1000));
    expect(layout.tooManyPages).toBe(true);
    expect(layout.pages).toHaveLength(0);
    expect(layout.requestedPages).toBeGreaterThan(MAX_PAGES);
  });

  it('上限以内なら普通に作る', () => {
    const layout = pageLayout(settings({ multiPage: true, margin: 0, scale: { kind: 'ratio', denominator: 1 } }), box(594, 420));
    expect(layout.tooManyPages).toBeUndefined();
    expect(layout.pages).toHaveLength(4);
  });

  it('分母が 0 や NaN でもページ数が発散しない', () => {
    for (const denominator of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const layout = pageLayout(settings({ multiPage: true, scale: { kind: 'ratio', denominator } }), box(1000, 1000));
      expect(layout.pages.length + (layout.tooManyPages ? 1 : 0)).toBeGreaterThan(0);
      expect(layout.pages.length).toBeLessThanOrEqual(MAX_PAGES);
    }
  });
});

describe('余白の上限', () => {
  it('用紙の短辺の半分未満にクランプする', () => {
    // A4（短辺 210mm）に余白 200mm を指定すると印刷可能領域が消える
    expect(clampMargin('A4', 'landscape', 200)).toBe(104);
    expect(clampMargin('A4', 'landscape', 5)).toBe(5);
    expect(clampMargin('A4', 'landscape', -10)).toBe(0);
    expect(clampMargin('A4', 'landscape', Number.NaN)).toBe(0);
  });

  it('過大な余白でも印刷可能領域が残る', () => {
    const a = printableArea(settings({ paper: 'A4', orientation: 'landscape', margin: 500 }));
    expect(a.width).toBeGreaterThan(0);
    expect(a.height).toBeGreaterThan(0);
  });
});

describe('解像度', () => {
  it('mm → px は dpi 換算（1 inch = 25.4mm）', () => {
    expect(mmToPx(25.4, 300)).toBe(300);
    expect(mmToPx(25.4, 150)).toBe(150);
  });

  it('A4 横 300dpi の用紙は 3508×2480 px 相当', () => {
    const px = paperPixels(settings({ paper: 'A4', orientation: 'landscape', dpi: 300 }));
    expect(px).toEqual({ width: 3508, height: 2480 });
  });
});
