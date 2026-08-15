/**
 * 手書きメモの入力面（issue #39）。
 *
 * 画面いっぱいのオーバーレイに `<canvas>` を敷き、ポインタの軌跡を拾って
 * 点列（`InkStroke`）にする。**座標はメモ領域に対する相対値（0〜1）**で持つので、
 * 画面の大きさが変わっても同じ形で描き直せる。
 *
 * 図面のキャンバスとは別の面。開いている間は図面の操作を受けない。
 */

import {
  DEFAULT_INK_COLOR,
  DEFAULT_INK_WIDTH,
  cloneStrokes,
  eraseAt,
  pointCount,
  simplifyStroke,
  type InkPoint,
  type InkStroke,
} from '../core/ink.js';

/** 消しゴムの半径（メモ領域の幅に対する比）。 */
const ERASER_RADIUS = 0.02;

export interface InkPadOptions {
  /** 「保存」を押したとき。 */
  onSave: (strokes: InkStroke[]) => void;
  /** 閉じたとき（保存の有無に関わらず呼ぶ）。 */
  onClose?: () => void;
}

/**
 * 手書きの入力面。`open` で開き、「保存」か「閉じる」で終わる。
 *
 * **開いたときの点列を複製して編集する。** 途中で閉じても元は変わらない
 * （保存を押したときだけ呼び出し側へ渡す）。
 */
export class InkPad {
  private readonly root: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly status: HTMLSpanElement;
  private strokes: InkStroke[];
  private drawing: InkPoint[] | null = null;
  private mode: 'pen' | 'eraser' = 'pen';
  private color = DEFAULT_INK_COLOR;
  private closed = false;

  constructor(
    initial: readonly InkStroke[],
    private readonly options: InkPadOptions,
  ) {
    this.strokes = cloneStrokes(initial);

    this.root = document.createElement('div');
    this.root.className = 'ink-pad';

    const bar = document.createElement('div');
    bar.className = 'ink-bar';

    const penBtn = this.button('ペン', () => this.setMode('pen'));
    const eraserBtn = this.button('消しゴム', () => this.setMode('eraser'));
    penBtn.classList.add('active');

    const colors = ['#1b1b1b', '#c0392b', '#2980b9', '#27ae60'];
    const colorBtns = colors.map((c) =>
      this.button('', () => {
        this.color = c;
        for (const b of colorBtns) b.classList.toggle('active', b.dataset['color'] === c);
      }),
    );
    colorBtns.forEach((b, i) => {
      b.dataset['color'] = colors[i]!;
      b.className = 'ink-color';
      b.style.background = colors[i]!;
      if (i === 0) b.classList.add('active');
    });

    this.status = document.createElement('span');
    this.status.className = 'ink-status';

    bar.append(penBtn, eraserBtn, ...colorBtns, this.status);
    bar.append(
      this.button('すべて消す', () => {
        this.strokes = [];
        this.redraw();
      }),
      this.button('保存', () => this.save()),
      this.button('閉じる', () => this.close()),
    );

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ink-canvas';
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D コンテキストを取得できません');
    this.ctx = ctx;

    this.root.append(bar, this.canvas);
    document.body.append(this.root);

    this.bind();
    this.resize();
    this.setMode('pen');

    // 図面と同じで、面の大きさが変わったら描き直す
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas.parentElement ?? this.canvas);
  }

  private readonly resizeObserver: ResizeObserver;

  private button(label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  private setMode(mode: 'pen' | 'eraser'): void {
    this.mode = mode;
    for (const b of this.root.querySelectorAll('.ink-bar button')) {
      if (b.textContent === 'ペン') b.classList.toggle('active', mode === 'pen');
      if (b.textContent === '消しゴム') b.classList.toggle('active', mode === 'eraser');
    }
    this.canvas.style.cursor = mode === 'pen' ? 'crosshair' : 'cell';
    this.updateStatus();
  }

  private bind(): void {
    this.canvas.addEventListener('pointerdown', (e) => {
      this.canvas.setPointerCapture(e.pointerId);
      const at = this.toRelative(e);
      if (this.mode === 'eraser') {
        this.strokes = eraseAt(this.strokes, at, ERASER_RADIUS);
        this.redraw();
        return;
      }
      this.drawing = [{ ...at, p: pressureOf(e) }];
      this.redraw();
    });

    this.canvas.addEventListener('pointermove', (e) => {
      const at = this.toRelative(e);
      if (this.mode === 'eraser') {
        // 押しながらなぞっている間だけ消す
        if (e.buttons !== 0) {
          this.strokes = eraseAt(this.strokes, at, ERASER_RADIUS);
          this.redraw();
        }
        return;
      }
      if (!this.drawing) return;
      this.drawing.push({ ...at, p: pressureOf(e) });
      this.redraw();
    });

    const finish = (): void => {
      if (!this.drawing) return;
      // **保存する前に間引く。** ポインタは 1 秒に何十点も来るので、そのまま
      // 持つとファイルが膨らむ
      const points = simplifyStroke(this.drawing);
      this.drawing = null;
      if (points.length > 0) this.strokes.push({ points, color: this.color, width: DEFAULT_INK_WIDTH });
      this.redraw();
    };
    this.canvas.addEventListener('pointerup', finish);
    this.canvas.addEventListener('pointercancel', finish);
    this.canvas.addEventListener('pointerleave', finish);

    this.keyHandler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') this.close();
    };
    window.addEventListener('keydown', this.keyHandler);
  }

  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  /** 画面の座標 → メモ領域の相対座標（0〜1）。 */
  private toRelative(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: r.width === 0 ? 0 : (e.clientX - r.left) / r.width,
      y: r.height === 0 ? 0 : (e.clientY - r.top) / r.height,
    };
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.redraw();
  }

  private redraw(): void {
    const { width, height } = this.canvas;
    this.ctx.clearRect(0, 0, width, height);
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';

    const all = this.drawing
      ? [...this.strokes, { points: this.drawing, color: this.color, width: DEFAULT_INK_WIDTH }]
      : this.strokes;

    for (const s of all) {
      if (s.points.length === 0) continue;
      this.ctx.strokeStyle = s.color;
      this.ctx.lineWidth = Math.max(1, s.width * width);
      this.ctx.beginPath();
      const first = s.points[0]!;
      this.ctx.moveTo(first.x * width, first.y * height);
      if (s.points.length === 1) {
        // 点を打っただけのときも見えるように、ごく短い線を引く
        this.ctx.lineTo(first.x * width + 0.01, first.y * height);
      } else {
        for (const p of s.points.slice(1)) this.ctx.lineTo(p.x * width, p.y * height);
      }
      this.ctx.stroke();
    }
    this.updateStatus();
  }

  private updateStatus(): void {
    const mode = this.mode === 'pen' ? 'ペン' : '消しゴム';
    this.status.textContent = `${mode}／${this.strokes.length} 本・${pointCount(this.strokes)} 点（Esc で閉じる）`;
  }

  private save(): void {
    this.options.onSave(cloneStrokes(this.strokes));
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.resizeObserver.disconnect();
    if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler);
    this.root.remove();
    this.options.onClose?.();
  }
}

/** 筆圧。取れない機器では 0.5（`pressure` は 0 で来ることがある）。 */
function pressureOf(e: PointerEvent): number {
  return e.pressure > 0 ? e.pressure : 0.5;
}
