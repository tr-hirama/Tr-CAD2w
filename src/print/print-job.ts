/**
 * 印刷 / PDF 出力。
 *
 * **画面の canvas を引き伸ばさない。** 用紙解像度（既定 300dpi）の canvas を
 * 別に作り、そこへ描き直す。引き伸ばすと線と文字が粗くなる。
 *
 * **ページは 1 枚ずつ作って捨てる。** A2 600dpi の canvas は 1 枚で 500MB を超える。
 * 全ページを同時に持つとタブが落ちるので、`PageRenderer` が要求されたページだけを
 * 描き、印刷時も 1 枚ずつ data URL にして canvas を解放する。
 *
 * PDF は**ブラウザの印刷ダイアログで「PDF に保存」**を選んで得る。PDF を自前で
 * 生成すると日本語フォントの埋め込みが要るうえ、実行時依存ゼロの方針にも反する。
 */

import type { CadDocument } from '../core/document.js';
import { CadView } from '../core/view.js';
import { Renderer, DEFAULT_RENDER } from '../render/renderer.js';
import {
  effectiveDpi,
  mmToPx,
  pageLayout,
  paperExtent,
  paperPixels,
  printableArea,
  type PageLayout,
  type PageSpec,
  type PrintSettings,
} from './paper.js';

/**
 * 1 ページを用紙解像度の canvas に描く。**呼び出し側が使い終わったら解放する**
 * （`releaseCanvas`）。
 *
 * `paperPerWorld`（紙 mm / 図面 mm）は `pageLayout` が返す値をそのまま渡す。
 * ここで独自に計算すると割付とずれる。
 */
export function renderPage(
  doc: CadDocument,
  page: PageSpec,
  settings: PrintSettings,
  paperPerWorld: number,
): HTMLCanvasElement | null {
  const canvas = document.createElement('canvas');
  const px = paperPixels(settings);
  canvas.width = px.width;
  canvas.height = px.height;
  // 上限を超えた canvas は width/height が 0 に落ちる（または描画が無視される）
  if (canvas.width !== px.width || canvas.height !== px.height) return null;

  let renderer: Renderer;
  try {
    renderer = new Renderer(canvas);
  } catch {
    return null; // コンテキストを取れない（メモリ不足など）
  }
  // renderer.resize は CSS 寸法 × dpr で実解像度を決めるので、
  // 用紙 px をそのまま渡して dpr=1 にする
  renderer.resize(px.width, px.height, 1);

  const dpi = effectiveDpi(settings);
  const view = new CadView();
  view.resize(px.width, px.height);
  const box = page.worldBox;
  view.center = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
  // 図面 1mm が紙で paperPerWorld mm。それを印刷解像度の px に換算する
  view.setScale(mmToPx(paperPerWorld, dpi));

  renderer.draw(doc, view, {
    ...DEFAULT_RENDER,
    background: '#ffffff', // 紙は白。無彩色は effectiveColor が黒へ反転する
    showGrid: false, // グリッドと原点軸は印刷しない
    showAxis: false,
    monochrome: settings.color === 'mono',
    // 線幅は紙の実寸で描く。画面の 1px をそのまま使うと 300dpi では
    // 0.085mm の極細になり、アンチエイリアスに溶けて灰色の線になる
    lineWidthPxPerMm: dpi / 25.4,
  });

  maskMargins(canvas, settings, dpi);
  return canvas;
}

/**
 * 余白を白で塗る。
 *
 * canvas は用紙全体なので、そのまま描くと**余白にも図面がはみ出す**
 * （ページに映る範囲は印刷可能領域ぶんしか割り当てていない）。
 */
function maskMargins(canvas: HTMLCanvasElement, settings: PrintSettings, dpi: number): void {
  const e = paperExtent(settings);
  const printable = printableArea(settings);
  const mx = (e.width - printable.width) / 2;
  const my = (e.height - printable.height) / 2;
  if (mx <= 0 && my <= 0) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  // 端数を切り上げないと、アンチエイリアスの 1px が余白に残る。
  // ただし用紙の半分は超えない（超えると全面が白くなる）
  const mpxX = Math.min(Math.ceil(mmToPx(mx, dpi)), Math.floor(canvas.width / 2));
  const mpxY = Math.min(Math.ceil(mmToPx(my, dpi)), Math.floor(canvas.height / 2));
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#ffffff';
  if (mpxY > 0) {
    ctx.fillRect(0, 0, canvas.width, mpxY);
    ctx.fillRect(0, canvas.height - mpxY, canvas.width, mpxY);
  }
  if (mpxX > 0) {
    ctx.fillRect(0, 0, mpxX, canvas.height);
    ctx.fillRect(canvas.width - mpxX, 0, mpxX, canvas.height);
  }
  ctx.restore();
}

/** canvas を解放する（大きな canvas は参照を捨てるだけでは戻りが遅い）。 */
export function releaseCanvas(canvas: HTMLCanvasElement | null | undefined): void {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * ページを**必要になったときだけ**描くレンダラ。
 * プレビューは 1 枚しか要らないので、全ページを持たない。
 */
export interface PageRenderer {
  layout: PageLayout;
  /** そのページを描く。描けなかったら null。 */
  renderAt(index: number): HTMLCanvasElement | null;
}

export function createPageRenderer(doc: CadDocument, settings: PrintSettings, bounds = doc.bounds()): PageRenderer {
  const layout = pageLayout(settings, bounds);
  return {
    layout,
    renderAt(index: number): HTMLCanvasElement | null {
      const page = layout.pages[index];
      if (!page) return null;
      return renderPage(doc, page, settings, layout.paperPerWorld);
    },
  };
}

const PRINT_ROOT_ID = 'tr-cad2w-print-root';
const PRINT_STYLE_ID = 'tr-cad2w-print-style';

/** 印刷が走っている間は true。二重に走らせない。 */
let printing = false;

export interface PrintResult {
  ok: boolean;
  /** 失敗の理由（利用者に見せる）。 */
  message?: string;
  pages: number;
}

/**
 * ページをブラウザの印刷にかける。
 *
 * 印刷用の要素を body 直下に置き、`@media print` で**それだけを表示**する。
 * ページは 1 枚ずつ描いて data URL にし、canvas はすぐ解放する。
 */
export async function printPages(renderer: PageRenderer, settings: PrintSettings): Promise<PrintResult> {
  if (printing) return { ok: false, message: '印刷中です', pages: 0 };
  if (renderer.layout.tooManyPages) {
    return {
      ok: false,
      message: `${renderer.layout.requestedPages} ページになるため印刷できません。尺度か用紙を見直してください`,
      pages: 0,
    };
  }
  const total = renderer.layout.pages.length;
  if (total === 0) return { ok: false, message: '印刷するページがありません', pages: 0 };

  printing = true;
  removePrintArtifacts();

  const root = document.createElement('div');
  root.id = PRINT_ROOT_ID;
  try {
    for (let i = 0; i < total; i++) {
      const canvas = renderer.renderAt(i);
      if (!canvas) {
        return {
          ok: false,
          message: `${i + 1} ページ目を描けませんでした（用紙が大きすぎるか解像度が高すぎます）`,
          pages: 0,
        };
      }
      const url = canvas.toDataURL('image/png');
      releaseCanvas(canvas);
      // 上限を超えた canvas は例外を投げずに空の data URL を返す
      if (!url.startsWith('data:image/png')) {
        return { ok: false, message: '用紙が大きすぎて画像を作れませんでした。解像度を下げてください', pages: 0 };
      }
      const holder = document.createElement('div');
      holder.className = 'page';
      const img = document.createElement('img');
      img.src = url;
      holder.append(img);
      root.append(holder);
    }

    document.head.append(buildPrintStyle(settings));
    document.body.append(root);

    const loaded = await waitForImages(root);
    if (!loaded) {
      removePrintArtifacts();
      return { ok: false, message: 'ページ画像を読み込めませんでした', pages: 0 };
    }
    window.print();
    // 後片付けはダイアログが閉じたあと。print() の直後に消すと Chrome で白紙になる
    window.setTimeout(removePrintArtifacts, 1000);
    return { ok: true, pages: total };
  } catch (err) {
    removePrintArtifacts();
    return { ok: false, message: err instanceof Error ? err.message : String(err), pages: 0 };
  } finally {
    printing = false;
  }
}

function buildPrintStyle(settings: PrintSettings): HTMLStyleElement {
  const extent = paperExtent(settings);
  const style = document.createElement('style');
  style.id = PRINT_STYLE_ID;
  style.textContent = `
@page { size: ${extent.width}mm ${extent.height}mm; margin: 0; }
@media print {
  /* アプリ側の html,body{height:100%;overflow:hidden} を必ず打ち消す。
     残っていると body が 1 ページ分でクリップされ、2 ページ目以降が出ない */
  html, body {
    height: auto !important; min-height: 0 !important; overflow: visible !important;
    margin: 0 !important; padding: 0 !important; background: #fff !important;
  }
  #app, .print-overlay { display: none !important; }
  #${PRINT_ROOT_ID} { display: block !important; }
  #${PRINT_ROOT_ID} .page {
    width: ${extent.width}mm; height: ${extent.height}mm;
    page-break-after: always; break-after: page; overflow: hidden;
  }
  #${PRINT_ROOT_ID} .page:last-child { page-break-after: auto; break-after: auto; }
  #${PRINT_ROOT_ID} img { width: 100%; height: 100%; display: block; }
}
#${PRINT_ROOT_ID} { display: none; }
`;
  return style;
}

/** すべての画像が読めたら true。1 枚でも失敗したら false（白紙で刷らない）。 */
function waitForImages(root: HTMLElement): Promise<boolean> {
  const images = [...root.querySelectorAll('img')];
  return Promise.all(
    images.map(
      (img) =>
        new Promise<boolean>((resolve) => {
          if (img.complete) {
            resolve(img.naturalWidth > 0);
            return;
          }
          img.addEventListener('load', () => resolve(img.naturalWidth > 0), { once: true });
          img.addEventListener('error', () => resolve(false), { once: true });
        }),
    ),
  ).then((results) => results.every(Boolean));
}

/** 印刷用に置いた要素を消す。二重に印刷しても増えないように毎回呼ぶ。 */
export function removePrintArtifacts(): void {
  document.getElementById(PRINT_ROOT_ID)?.remove();
  document.getElementById(PRINT_STYLE_ID)?.remove();
}

/** 印刷中かどうか（テスト・UI の抑止用）。 */
export function isPrinting(): boolean {
  return printing;
}
