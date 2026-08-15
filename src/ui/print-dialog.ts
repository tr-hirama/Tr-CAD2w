/**
 * 印刷プレビュー（設定 + ページ送り + 印刷）。
 *
 * **プレビューは画面用の低い解像度で描く。** 用紙解像度の canvas は 1 枚で
 * 数百 MB になることがあり、設定を変えるたびに全ページ作るとタブが落ちる。
 * 印刷解像度で描くのは「印刷」を押したときだけ、しかも 1 枚ずつ。
 */

import type { CadDocument } from '../core/document.js';
import {
  DEFAULT_PRINT,
  PAPER_SIZES,
  clampMargin,
  effectiveDpi,
  formatScale,
  pageLayout,
  type Orientation,
  type PrintSettings,
} from '../print/paper.js';
import {
  createLayoutPageRenderer,
  createPageRenderer,
  printPages,
  releaseCanvas,
  removePrintArtifacts,
} from '../print/print-job.js';
import type { LayoutSpace } from '../core/layout.js';

/** プレビューの解像度（dpi）。画面で見えれば足りる。 */
const PREVIEW_DPI = 96;

export interface PrintDialogHost {
  doc: CadDocument;
  /**
   * いま開いている用紙空間（無ければ `null`）。
   * **開いていればそのレイアウトを 1 ページとして刷る。**
   */
  activeLayout?: () => LayoutSpace | null;
  /** 設定が変わったら呼ぶ（アプリ側に持ち帰って次回の既定にする）。 */
  onSettingsChange?: (settings: PrintSettings) => void;
  /** 閉じたときに呼ぶ（アプリ側の参照を捨てる）。 */
  onClose?: () => void;
}

export class PrintDialog {
  private settings: PrintSettings;
  private pageIndex = 0;
  private pageCount = 0;
  private previewCanvas: HTMLCanvasElement | null = null;
  private rerenderTimer = 0;
  private closed = false;

  private readonly overlay: HTMLElement;
  private readonly preview: HTMLElement;
  private readonly pageLabel: HTMLElement;
  private readonly scaleLabel: HTMLElement;
  private readonly noteLabel: HTMLElement;
  private readonly printButton: HTMLButtonElement;

  constructor(
    private readonly host: PrintDialogHost,
    settings: PrintSettings = DEFAULT_PRINT,
  ) {
    this.settings = { ...settings };
    this.overlay = document.createElement('div');
    this.overlay.className = 'print-overlay';
    this.overlay.innerHTML = `
      <div class="print-dialog" role="dialog" aria-label="印刷プレビュー">
        <header>
          <strong>印刷 / PDF出力</strong>
          <button type="button" data-act="close" title="閉じる (Esc)">✕</button>
        </header>
        <div class="print-body">
          <div class="print-settings">
            <label>用紙
              <select data-field="paper">
                ${PAPER_SIZES.map((p) => `<option value="${p.name}">${p.name}</option>`).join('')}
              </select>
            </label>
            <label>向き
              <select data-field="orientation">
                <option value="landscape">横</option>
                <option value="portrait">縦</option>
              </select>
            </label>
            <label>色
              <select data-field="color">
                <option value="color">カラー</option>
                <option value="mono">モノクロ</option>
              </select>
            </label>
            <label>尺度
              <select data-field="scaleKind">
                <option value="fit">ページに合わせる</option>
                <option value="ratio">1:N を指定</option>
              </select>
            </label>
            <label class="ratio-only">1:
              <input type="number" data-field="denominator" min="0.01" step="1" />
            </label>
            <label>余白(mm)
              <input type="number" data-field="margin" min="0" max="100" step="1" />
            </label>
            <label class="check">
              <input type="checkbox" data-field="multiPage" />
              複数ページに分割
            </label>
            <label>解像度
              <select data-field="dpi">
                <option value="150">150 dpi</option>
                <option value="300">300 dpi</option>
                <option value="600">600 dpi</option>
              </select>
            </label>
            <p class="print-scale" data-role="scale"></p>
            <p class="print-note" data-role="note"></p>
            <p class="print-hint">PDF は印刷ダイアログで「PDF に保存」を選んでください。</p>
          </div>
          <div class="print-preview" data-role="preview"></div>
        </div>
        <footer>
          <button type="button" data-act="prev" title="前のページ">◀</button>
          <span data-role="page"></span>
          <button type="button" data-act="next" title="次のページ">▶</button>
          <span class="spacer"></span>
          <button type="button" data-act="print" class="primary">印刷</button>
        </footer>
      </div>`;

    this.preview = this.q('[data-role="preview"]');
    this.pageLabel = this.q('[data-role="page"]');
    this.scaleLabel = this.q('[data-role="scale"]');
    this.noteLabel = this.q('[data-role="note"]');
    this.printButton = this.q<HTMLButtonElement>('[data-act="print"]');

    this.bind();
    this.syncControls();
  }

  /** 画面に出す。 */
  open(): void {
    if (this.overlay.isConnected) return; // 二重に開かない
    document.body.append(this.overlay);
    // capture で先に受けて、アプリ側のショートカット（Del や Ctrl+Z）へ渡さない
    window.addEventListener('keydown', this.onKeyDown, { capture: true });
    this.rerender();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    window.clearTimeout(this.rerenderTimer);
    window.removeEventListener('keydown', this.onKeyDown, { capture: true });
    releaseCanvas(this.previewCanvas);
    this.previewCanvas = null;
    removePrintArtifacts();
    this.overlay.remove();
    this.host.onClose?.();
  }

  private readonly onKeyDown = (ev: KeyboardEvent): void => {
    // ダイアログが出ている間は図面側のキー操作を通さない
    ev.stopImmediatePropagation();
    if (ev.key === 'Escape') {
      ev.preventDefault();
      this.close();
      return;
    }
    if (ev.key === 'ArrowRight' || ev.key === 'PageDown') {
      ev.preventDefault();
      this.step(1);
    }
    if (ev.key === 'ArrowLeft' || ev.key === 'PageUp') {
      ev.preventDefault();
      this.step(-1);
    }
  };

  private q<T extends HTMLElement>(selector: string): T {
    const el = this.overlay.querySelector<T>(selector);
    if (!el) throw new Error(`印刷ダイアログの要素が見つかりません: ${selector}`);
    return el;
  }

  private bind(): void {
    this.overlay.addEventListener('click', (ev) => {
      const target = ev.target as HTMLElement;
      if (target === this.overlay) {
        this.close();
        return;
      }
      switch (target.closest('button')?.dataset['act']) {
        case 'close':
          this.close();
          break;
        case 'prev':
          this.step(-1);
          break;
        case 'next':
          this.step(1);
          break;
        case 'print':
          void this.print();
          break;
      }
    });

    this.overlay.addEventListener('change', (ev) => {
      const el = ev.target as HTMLInputElement | HTMLSelectElement;
      const field = el.dataset['field'];
      if (!field) return;
      this.applyField(field, el);
      this.host.onSettingsChange?.(this.settings);
      this.pageIndex = 0;
      this.syncControls();
      // 続けて設定をいじったときに描き直しを重ねない
      window.clearTimeout(this.rerenderTimer);
      this.rerenderTimer = window.setTimeout(() => this.rerender(), 120);
    });
  }

  private applyField(field: string, el: HTMLInputElement | HTMLSelectElement): void {
    switch (field) {
      case 'paper':
        this.settings.paper = el.value;
        // 用紙が小さくなると余白の上限も下がる
        this.settings.margin = clampMargin(this.settings.paper, this.settings.orientation, this.settings.margin);
        break;
      case 'orientation':
        this.settings.orientation = el.value as Orientation;
        break;
      case 'color':
        this.settings.color = el.value === 'mono' ? 'mono' : 'color';
        break;
      case 'scaleKind':
        this.settings.scale =
          el.value === 'ratio'
            ? { kind: 'ratio', denominator: currentDenominator(this.settings, this.host.doc) }
            : { kind: 'fit' };
        break;
      case 'denominator': {
        const v = Number.parseFloat(el.value);
        if (Number.isFinite(v) && v > 0) this.settings.scale = { kind: 'ratio', denominator: v };
        break;
      }
      case 'margin': {
        const v = Number.parseFloat(el.value);
        this.settings.margin = clampMargin(this.settings.paper, this.settings.orientation, v);
        break;
      }
      case 'multiPage':
        this.settings.multiPage = (el as HTMLInputElement).checked;
        break;
      case 'dpi': {
        const v = Number.parseInt(el.value, 10);
        if (Number.isFinite(v) && v > 0) this.settings.dpi = v;
        break;
      }
    }
  }

  /** コントロールの表示を settings に合わせる。 */
  private syncControls(): void {
    this.q<HTMLSelectElement>('[data-field="paper"]').value = this.settings.paper;
    this.q<HTMLSelectElement>('[data-field="orientation"]').value = this.settings.orientation;
    this.q<HTMLSelectElement>('[data-field="color"]').value = this.settings.color;
    this.q<HTMLSelectElement>('[data-field="scaleKind"]').value = this.settings.scale.kind;
    this.q<HTMLInputElement>('[data-field="denominator"]').value = String(
      currentDenominator(this.settings, this.host.doc),
    );
    this.q<HTMLInputElement>('[data-field="margin"]').value = String(this.settings.margin);
    this.q<HTMLInputElement>('[data-field="multiPage"]').checked = this.settings.multiPage;
    this.q<HTMLSelectElement>('[data-field="dpi"]').value = String(this.settings.dpi);
    this.overlay.querySelector<HTMLElement>('.ratio-only')!.style.display =
      this.settings.scale.kind === 'ratio' ? '' : 'none';
  }

  private step(delta: number): void {
    const next = Math.min(this.pageCount - 1, Math.max(0, this.pageIndex + delta));
    if (next === this.pageIndex) return;
    this.pageIndex = next;
    this.showPage();
  }

  /**
   * いま刷る対象。用紙空間を開いていればそのレイアウト、そうでなければモデル空間。
   * **レイアウトは紙に描いてあるものがそのまま 1 枚**になる。
   */
  private targetLayout(): LayoutSpace | null {
    return this.host.activeLayout?.() ?? null;
  }

  /** 設定に合わせて割付を取り直し、いま見ているページだけ描く。 */
  private rerender(): void {
    if (this.closed) return;

    const space = this.targetLayout();
    if (space) {
      this.pageCount = 1;
      this.pageIndex = 0;
      this.scaleLabel.textContent = `「${space.name}」を 1 ページ（用紙 ${space.paper}・${
        space.orientation === 'landscape' ? '横' : '縦'
      }・紙のまま 1:1）`;
      this.noteLabel.textContent = '用紙空間を開いているので、レイアウトの内容をそのまま刷ります';
      this.noteLabel.style.display = '';
      this.printButton.disabled = false;
      this.showPage();
      return;
    }

    const bounds = this.host.doc.printBounds();
    const layout = pageLayout(this.settings, bounds);
    this.pageCount = layout.pages.length;
    this.pageIndex = Math.min(this.pageIndex, Math.max(0, this.pageCount - 1));

    this.scaleLabel.textContent = `尺度 ${formatScale(this.settings, bounds)} ／ ${layout.cols}×${layout.rows} ページ`;

    const notes: string[] = [];
    const dpi = effectiveDpi(this.settings);
    if (dpi < this.settings.dpi) {
      notes.push(`この用紙では ${this.settings.dpi}dpi が大きすぎるため ${dpi}dpi で出力します`);
    }
    if (layout.tooManyPages) {
      notes.push(`${layout.requestedPages} ページになるため印刷できません。尺度か用紙を見直してください`);
    }
    this.noteLabel.textContent = notes.join(' / ');
    this.noteLabel.style.display = notes.length > 0 ? '' : 'none';
    this.printButton.disabled = layout.tooManyPages === true || this.pageCount === 0;

    this.showPage();
  }

  /** プレビューは画面用の解像度で 1 枚だけ描く。 */
  private showPage(): void {
    releaseCanvas(this.previewCanvas);
    this.previewCanvas = null;
    this.preview.textContent = '';

    if (this.pageCount > 0) {
      const space = this.targetLayout();
      const previewRenderer = space
        ? createLayoutPageRenderer(this.host.doc, space, { ...this.settings, dpi: PREVIEW_DPI })
        : createPageRenderer(
            this.host.doc,
            { ...this.settings, dpi: PREVIEW_DPI },
            this.host.doc.printBounds(),
          );
      const canvas = previewRenderer.renderAt(this.pageIndex);
      if (canvas) {
        // canvas をそのまま置く（toDataURL するとビットマップが二重に載る）
        canvas.style.maxWidth = '100%';
        canvas.style.maxHeight = '100%';
        this.previewCanvas = canvas;
        this.preview.append(canvas);
      } else {
        this.preview.textContent = 'このページは描けませんでした（用紙が大きすぎます）';
      }
    }
    this.pageLabel.textContent = `${this.pageCount === 0 ? 0 : this.pageIndex + 1} / ${this.pageCount} ページ`;
  }

  private async print(): Promise<void> {
    this.printButton.disabled = true;
    const previous = this.noteLabel.textContent;
    this.noteLabel.textContent = '印刷用のページを作っています…';
    this.noteLabel.style.display = '';
    try {
      const space = this.targetLayout();
      const renderer = space
        ? createLayoutPageRenderer(this.host.doc, space, this.settings)
        : createPageRenderer(this.host.doc, this.settings, this.host.doc.printBounds());
      // レイアウトはそのレイアウト自身の用紙・向きで刷る
      const settings = space
        ? { ...this.settings, paper: space.paper, orientation: space.orientation }
        : this.settings;
      const result = await printPages(renderer, settings);
      this.noteLabel.textContent = result.ok ? '' : (result.message ?? '印刷できませんでした');
      this.noteLabel.style.display = result.ok ? 'none' : '';
      if (result.ok) this.noteLabel.textContent = previous ?? '';
    } finally {
      if (!this.closed) this.printButton.disabled = false;
    }
  }
}

function currentDenominator(settings: PrintSettings, doc: CadDocument): number {
  if (settings.scale.kind === 'ratio') return settings.scale.denominator;
  // 「ページに合わせる」から 1:N へ切り替えたときの初期値は今の実効尺度
  const s = pageLayout(settings, doc.printBounds()).paperPerWorld;
  const n = s > 0 ? 1 / s : 1;
  return Math.max(0.01, Math.round(n * 100) / 100);
}
