/**
 * アプリ本体。入力の解釈・ツールの駆動・描画ループ・UI の配線。
 *
 * マウスの割当はデスクトップ版 TrCad2D に合わせている。
 *
 * | 操作 | 挙動 |
 * |---|---|
 * | ホイール | カーソル固定ズーム |
 * | 中／右ドラッグ | パン |
 * | 選択ツールで空白から左ドラッグ | 矩形選択（右→左は交差選択） |
 * | 右クリック（ドラッグでない） | 連続線の確定／ツールの取消 |
 */

import { CadView } from '../core/view.js';
import { CadDocument } from '../core/document.js';
import { Renderer, DEFAULT_RENDER, type RenderOptions, type RenderStats } from '../render/renderer.js';
import { DEFAULT_SNAP, SNAP_LABEL, applyGrid, findSnap, type SnapResult, type SnapSettings } from '../core/snap.js';
import { aabbFromCorners, dist, sub, vec, type Vec2 } from '../core/geometry.js';
import {
  cloneEntity,
  entityArea,
  entityLength,
  translateEntity,
  type DimEntity,
  type Entity,
  type NewEntity,
} from '../core/entity.js';
import {
  DEFAULT_DRAW_ATTRS,
  DrawTool,
  TOOL_KEYS,
  TOOL_LABEL,
  buildRadialDim,
  promptFor,
  type DrawAttrs,
  type ToolName,
} from './tools.js';
import { LINE_STYLE_LABEL } from '../render/linetype.js';
import {
  decodeUtf8,
  defaultFileName,
  deserialize,
  downloadBytes,
  downloadText,
  pickFile,
  readFile,
  serialize,
  type PickedFile,
} from '../core/file.js';
import { readDxfBytes } from '../io/dxf.js';
import { defaultDxfFileName, documentToDxf } from '../io/dxf-write.js';
import { defaultTc2FileName, readTc2, writeTc2 } from '../io/tc2.js';
import { looksLikeZip } from '../io/zip.js';
import { PrintDialog } from './print-dialog.js';
import { DEFAULT_PRINT, type PrintSettings } from '../print/paper.js';

interface Pointer {
  /** 押した画面座標。 */
  downAt: Vec2;
  button: number;
  /** ドラッグとみなせるほど動いたか。 */
  dragged: boolean;
  /** 直前の画面座標（パンの差分計算用）。 */
  lastAt: Vec2;
}

export class CadApp {
  readonly view = new CadView();
  readonly doc = new CadDocument();
  private readonly renderer: Renderer;

  private tool = new DrawTool('select', () => this.attrs);
  attrs: DrawAttrs = { ...DEFAULT_DRAW_ATTRS };
  snapSettings: SnapSettings = { ...DEFAULT_SNAP };
  render: RenderOptions = { ...DEFAULT_RENDER };
  /** 印刷設定。ダイアログで変えた値を次回の既定として持ち回る。 */
  printSettings: PrintSettings = { ...DEFAULT_PRINT };
  /** 開いている印刷ダイアログ（同時に 1 つだけ）。 */
  private printDialog: PrintDialog | null = null;

  private pointer: Pointer | null = null;
  private cursorWorld: Vec2 = vec(0, 0);
  private snap: SnapResult | undefined;
  private dirty = true;
  private lastStats: RenderStats = { drawn: 0, total: 0, ms: 0 };
  /** 移動／複写の基点。 */
  private moveBase: Vec2 | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly ui: {
      toolbar: HTMLElement;
      status: HTMLElement;
      info: HTMLElement;
      layerList: HTMLElement;
    },
  ) {
    this.renderer = new Renderer(canvas);
    this.bindPointer();
    this.bindKeyboard();
    this.bindToolbar();
    this.bindDragAndDrop();
    this.buildLayerList();

    const ro = new ResizeObserver(() => this.handleResize());
    ro.observe(canvas.parentElement ?? canvas);
    this.handleResize();

    this.loadSample();
    this.zoomFit();
    requestAnimationFrame(() => this.frame());
  }

  // ---- 公開コマンド ------------------------------------------------------

  setTool(name: ToolName): void {
    this.tool = new DrawTool(name, () => this.attrs);
    this.moveBase = null;
    this.markDirty();
    this.updateToolbar();
  }

  get toolName(): ToolName {
    return this.tool.name;
  }

  zoomFit(): void {
    const b = this.doc.bounds();
    if (b.minX <= b.maxX) this.view.zoomToFit(b);
    else {
      this.view.center = vec(0, 0);
      this.view.setScale(0.05);
    }
    this.markDirty();
  }

  zoom(factor: number): void {
    this.view.zoomCenter(factor);
    this.markDirty();
  }

  /** 等倍（1 ワールド単位 = 1px）。 */
  zoomActual(): void {
    this.view.setScale(1);
    this.markDirty();
  }

  deleteSelection(): void {
    if (this.doc.selection.size === 0) return;
    this.doc.beginEdit();
    const n = this.doc.remove([...this.doc.selection]);
    this.setStatus(`${n} 個削除しました`);
    this.markDirty();
  }

  undo(): void {
    this.setStatus(this.doc.undo() ? '元に戻しました' : '元に戻せる操作はありません');
    this.markDirty();
  }

  redo(): void {
    this.setStatus(this.doc.redo() ? 'やり直しました' : 'やり直せる操作はありません');
    this.markDirty();
  }

  selectAll(): void {
    this.doc.selection.clear();
    for (const e of this.doc.entities) {
      if (this.doc.layers.isVisible(e.layer)) this.doc.selection.add(e.id);
    }
    this.markDirty();
  }

  save(): void {
    downloadText(defaultFileName(new Date()), serialize(this.doc.toJson()));
    this.setStatus('図面を保存しました');
  }

  /** DXF（UTF-8 / R2007）で書き出す。 */
  exportDxf(): void {
    if (this.doc.count === 0) {
      this.setStatus('書き出す図形がありません');
      return;
    }
    downloadText(defaultDxfFileName(new Date()), documentToDxf(this.doc.toJson()), 'application/dxf');
    this.setStatus(`DXF で書き出しました（${this.doc.count} 図形・UTF-8 / R2007）`);
  }

  /** 印刷プレビューを開く（PDF は印刷ダイアログの「PDF に保存」で得る）。 */
  openPrintDialog(): void {
    if (this.printDialog) return; // 二重に開かない（Ctrl+P 連打で重なると重い）
    if (this.doc.count === 0) {
      this.setStatus('印刷する図形がありません');
      return;
    }
    this.printDialog = new PrintDialog(
      {
        doc: this.doc,
        onSettingsChange: (s) => (this.printSettings = s),
        onClose: () => (this.printDialog = null),
      },
      this.printSettings,
    );
    this.printDialog.open();
    this.setStatus('印刷プレビューを開きました（←→ でページ送り・Esc で閉じる）');
  }

  async open(): Promise<void> {
    const picked = await pickFile();
    if (picked) this.loadPicked(picked);
  }

  /**
   * ファイルを図面として読む。`.dxf` は DXF、それ以外は `.tc2w`（JSON）。
   *
   * **読めなかったときは初期化せず、いま開いている図面をそのまま残す**
   * （デスクトップ版と同じ扱い）。`loadJson` の中で `clear()` する作りなので、
   * 解釈は必ず `loadJson` を呼ぶ前に済ませる。
   */
  private loadPicked(picked: PickedFile): void {
    // .tc2（ZIP）は伸長が非同期なので別経路。**判定は拡張子ではなく中身の先頭 2 バイト**
    if (looksLikeZip(picked.bytes)) {
      void this.loadTc2(picked);
      return;
    }
    try {
      if (/\.dxf$/i.test(picked.name)) {
        const res = readDxfBytes(picked.bytes);
        if (res.json.entities.length === 0) {
          throw new Error('読める図形がありませんでした（ENTITIES が空か、未対応の形式です）');
        }
        this.doc.loadJson(res.json);
        const skipped = Object.entries(res.skipped);
        const skipText =
          skipped.length > 0 ? `／未対応 ${skipped.map(([k, v]) => `${k}×${v}`).join(' ')}` : '';
        this.setStatus(
          `${picked.name} を開きました（${this.doc.count} 図形・${res.encoding}${skipText}）`,
        );
      } else {
        this.doc.loadJson(deserialize(decodeUtf8(picked.bytes)));
        this.setStatus(`${picked.name} を開きました（${this.doc.count} 図形）`);
      }
      this.buildLayerList();
      this.zoomFit();
    } catch (err) {
      this.setStatus(`${picked.name} を開けませんでした: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.markDirty();
  }

  /** デスクトップ版の `.tc2`（JSON を ZIP 圧縮）を読む。 */
  private async loadTc2(picked: PickedFile): Promise<void> {
    try {
      const res = await readTc2(picked.bytes);
      if (res.json.entities.length === 0) throw new Error('読める図形がありませんでした');
      this.doc.loadJson(res.json);

      const skipped = Object.entries(res.skipped);
      const notes: string[] = [];
      if (skipped.length > 0) notes.push(`未対応 ${skipped.map(([k, v]) => `${k}×${v}`).join(' ')}`);
      if (res.droppedSections.length > 0) notes.push(`取り込まず: ${res.droppedSections.join('・')}`);
      this.setStatus(
        `${picked.name} を開きました（${this.doc.count} 図形${notes.length > 0 ? '／' + notes.join('／') : ''}）`,
      );
      this.buildLayerList();
      this.zoomFit();
    } catch (err) {
      this.setStatus(`${picked.name} を開けませんでした: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.markDirty();
  }

  /** デスクトップ版の `.tc2` で書き出す。 */
  async exportTc2(): Promise<void> {
    if (this.doc.count === 0) {
      this.setStatus('書き出す図形がありません');
      return;
    }
    try {
      const bytes = await writeTc2(this.doc.toJson());
      downloadBytes(defaultTc2FileName(new Date()), bytes, 'application/zip');
      this.setStatus(`.tc2 で書き出しました（${this.doc.count} 図形・${bytes.length} バイト）`);
    } catch (err) {
      this.setStatus(`.tc2 を書き出せませんでした: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  newDocument(): void {
    this.doc.clear();
    this.buildLayerList();
    this.zoomFit();
    this.setStatus('新規図面');
    this.markDirty();
  }

  toggleObjectSnap(): void {
    this.snapSettings.objectSnap = !this.snapSettings.objectSnap;
    this.setStatus(`Obj吸着 ${this.snapSettings.objectSnap ? 'ON' : 'OFF'}`);
    this.updateToolbar();
    this.markDirty();
  }

  toggleGridSnap(): void {
    this.snapSettings.gridSnap = !this.snapSettings.gridSnap;
    this.setStatus(`Grid吸着 ${this.snapSettings.gridSnap ? 'ON' : 'OFF'}`);
    this.updateToolbar();
    this.markDirty();
  }

  toggleBackground(): void {
    const dark = this.render.background !== '#1e1e1e';
    this.render = { ...this.render, background: dark ? '#1e1e1e' : '#ffffff' };
    this.markDirty();
  }

  /** 動作確認用: 現在の描画を PNG のデータ URL で返す。 */
  snapshot(): string {
    this.drawNow();
    return this.renderer.toDataUrl();
  }

  // ---- 入力 --------------------------------------------------------------

  private bindPointer(): void {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    c.addEventListener('pointerdown', (ev) => {
      // 合成イベント（自動テスト）では捕捉できないことがある。捕捉の失敗で
      // 以降の処理を止めない
      try {
        c.setPointerCapture(ev.pointerId);
      } catch {
        /* 無視 */
      }
      const at = this.screenPoint(ev);
      this.pointer = { downAt: at, button: ev.button, dragged: false, lastAt: at };
    });

    c.addEventListener('pointermove', (ev) => {
      const at = this.screenPoint(ev);
      this.updateCursor(at);

      const p = this.pointer;
      if (!p) {
        this.markDirty();
        return;
      }
      if (!p.dragged && dist(p.downAt, at) > 3) p.dragged = true;

      const panning = p.button === 1 || p.button === 2;
      if (panning && p.dragged) {
        this.view.panByScreen(at.x - p.lastAt.x, at.y - p.lastAt.y);
      }
      p.lastAt = at;
      this.markDirty();
    });

    c.addEventListener('pointerup', (ev) => {
      const p = this.pointer;
      this.pointer = null;
      if (!p) return;
      const at = this.screenPoint(ev);

      if (p.button === 2 && !p.dragged) {
        this.handleRightClick();
        return;
      }
      if (p.button !== 0) return;

      if (p.dragged) {
        if (this.tool.name === 'select') this.commitBoxSelection(p.downAt, at);
        return;
      }
      this.handleLeftClick();
    });

    // 寸法をダブルクリックすると値を手で書き換えられる
    c.addEventListener('dblclick', (ev) => {
      const at = this.screenPoint(ev);
      this.updateCursor(at);
      const hit = this.doc.pick(this.cursorWorld, this.view.toWorldLen(6));
      if (!hit || hit.kind !== 'dim') return;
      ev.preventDefault();
      this.doc.selection.clear();
      this.doc.selection.add(hit.id);
      this.editDimText();
    });

    c.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        const at = this.screenPoint(ev);
        const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
        this.view.zoomAt(at, factor);
        this.updateCursor(at);
        this.markDirty();
      },
      { passive: false },
    );
  }

  /** 図面ファイルをキャンバスへドラッグ＆ドロップで開けるようにする。 */
  private bindDragAndDrop(): void {
    const host = this.canvas.parentElement ?? this.canvas;
    host.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
    });
    host.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const file = ev.dataTransfer?.files?.[0];
      if (!file) return;
      void readFile(file).then((picked) => this.loadPicked(picked));
    });
  }

  private bindKeyboard(): void {
    window.addEventListener('keydown', (ev) => {
      if (isTypingTarget(ev.target)) return;
      // モーダル（印刷プレビュー）が出ている間は図面のキー操作を通さない。
      // ダイアログ側も capture で止めているが、window へ直接 dispatch された
      // 合成イベントは AT_TARGET 扱いで登録順に走るので、ここでも見る
      if (this.printDialog) return;
      const key = ev.key.toLowerCase();

      if (ev.ctrlKey || ev.metaKey) {
        switch (key) {
          case 'z':
            ev.preventDefault();
            if (ev.shiftKey) this.redo();
            else this.undo();
            return;
          case 'y':
            ev.preventDefault();
            this.redo();
            return;
          case 'a':
            ev.preventDefault();
            this.selectAll();
            return;
          case 's':
            ev.preventDefault();
            this.save();
            return;
          case 'o':
            ev.preventDefault();
            void this.open();
            return;
          case 'p':
            // ブラウザ既定の印刷ではなく、図面用のプレビューを出す
            ev.preventDefault();
            this.openPrintDialog();
            return;
          default:
            return;
        }
      }

      switch (ev.key) {
        case 'Delete':
          this.deleteSelection();
          return;
        case 'Enter':
          this.finishTool();
          return;
        case 'Escape':
          this.cancelTool();
          return;
        case 'Home':
          this.zoomFit();
          return;
        case 'F2':
          ev.preventDefault();
          this.editDimText();
          return;
        case 'F3':
          ev.preventDefault();
          this.toggleObjectSnap();
          return;
        case '+':
          this.zoom(1.25);
          return;
        case '-':
          this.zoom(1 / 1.25);
          return;
      }

      if (key === 'g') {
        this.toggleGridSnap();
        return;
      }
      if (key === 'd') {
        this.setTool('point');
        return;
      }
      const t = TOOL_KEYS[key];
      if (t) this.setTool(t);
    });
  }

  private handleLeftClick(): void {
    const p = this.snap?.at ?? applyGrid(this.cursorWorld, this.snapSettings);

    if (this.tool.name === 'select') {
      const hit = this.doc.pick(p, this.view.toWorldLen(6));
      const additive = this.shiftHeld;
      if (!hit) {
        if (!additive) this.doc.selection.clear();
      } else if (additive) {
        if (this.doc.selection.has(hit.id)) this.doc.selection.delete(hit.id);
        else this.doc.selection.add(hit.id);
      } else {
        this.doc.selection.clear();
        this.doc.selection.add(hit.id);
      }
      this.markDirty();
      return;
    }

    if (this.tool.name === 'move' || this.tool.name === 'copy') {
      this.handleMoveClick(p);
      return;
    }

    if (this.tool.name === 'dim-radius' || this.tool.name === 'dim-diameter') {
      this.handleRadialDimClick(p);
      return;
    }

    if (this.tool.name === 'text' && this.tool.pointCount === 0) {
      const input = window.prompt('文字列', this.tool.pendingText || '');
      if (input === null || input === '') return;
      this.tool.pendingText = input;
    }

    const step = this.tool.click(p);
    if (step.created && step.created.length > 0) {
      this.doc.beginEdit();
      const created = this.doc.addAll(step.created);
      this.setStatus(`${TOOL_LABEL[this.tool.name]}を作図しました（計 ${this.doc.count} 図形）`);
      // 続けて同じツールで描けるようにツールは変えない
      this.doc.selection.clear();
      for (const e of created) this.doc.selection.add(e.id);
    }
    this.markDirty();
  }

  /**
   * 半径・直径の寸法。**円／弧をクリックすると中心と半径を図形から採って即作図する。**
   * 引き出す向きは押した位置（中心から見た方向）に追従する。
   */
  private handleRadialDimClick(p: Vec2): void {
    const dimType = this.tool.name === 'dim-diameter' ? 'diameter' : 'radius';
    // 吸着で中心へ寄ると向きが決まらないので、当たり判定にはカーソルの実位置を使う
    const raw = this.cursorWorld;
    const tol = this.view.toWorldLen(6);
    const hit = this.doc.pick(raw, tol) ?? this.doc.pick(p, tol);
    if (!hit || (hit.kind !== 'circle' && hit.kind !== 'arc')) {
      this.setStatus('円または円弧をクリックしてください');
      return;
    }
    const created = buildRadialDim(dimType, hit.center, hit.radius, raw, this.attrs);
    if (!created) return;
    this.doc.beginEdit();
    const added = this.doc.add(created);
    this.doc.selection.clear();
    this.doc.selection.add(added.id);
    this.setStatus(`${TOOL_LABEL[this.tool.name]}を作図しました（計 ${this.doc.count} 図形）`);
    this.markDirty();
  }

  /**
   * 寸法値の手動上書き（ダブルクリック／`F2`）。
   * 空欄に戻すと自動計測値、`<>` は計測値に置き換わる（`約<>cm` のように書ける）。
   */
  editDimText(): void {
    const dims = this.doc.selectedEntities().filter((e): e is DimEntity => e.kind === 'dim');
    if (dims.length === 0) {
      this.setStatus('寸法を選択してから実行してください（ダブルクリックでも開きます）');
      return;
    }
    const current = dims[0]!.text;
    const input = window.prompt('寸法値（空欄＝自動。<> は計測値に置き換わります）', current);
    if (input === null) return;
    this.doc.beginEdit();
    for (const d of dims) this.doc.replace({ ...d, text: input });
    this.setStatus(input === '' ? `${dims.length} 個を自動計測値に戻しました` : `${dims.length} 個の寸法値を変えました`);
    this.markDirty();
  }

  private handleMoveClick(p: Vec2): void {
    if (this.doc.selection.size === 0) {
      this.setStatus('先に図形を選択してください');
      return;
    }
    if (!this.moveBase) {
      this.moveBase = p;
      this.markDirty();
      return;
    }
    const d = sub(p, this.moveBase);
    this.doc.beginEdit();
    if (this.tool.name === 'move') {
      for (const e of this.doc.selectedEntities()) this.doc.replace(translateEntity(e, d) as Entity);
      this.setStatus(`${this.doc.selection.size} 個を移動しました`);
      this.moveBase = null;
    } else {
      const copies = this.doc.selectedEntities().map((e) => {
        const moved = translateEntity(cloneEntity(e), d);
        const { id: _id, ...rest } = moved;
        return rest as NewEntity;
      });
      const added = this.doc.addAll(copies);
      this.doc.selection.clear();
      for (const e of added) this.doc.selection.add(e.id);
      this.setStatus(`${added.length} 個を複写しました（続けて複写できます）`);
      this.moveBase = p;
    }
    this.markDirty();
  }

  private handleRightClick(): void {
    if (this.tool.name === 'polyline' && this.tool.pointCount >= 2) {
      this.finishTool();
      return;
    }
    this.cancelTool();
  }

  private finishTool(): void {
    const step = this.tool.finish();
    if (step.created && step.created.length > 0) {
      this.doc.beginEdit();
      const created = this.doc.addAll(step.created);
      this.doc.selection.clear();
      for (const e of created) this.doc.selection.add(e.id);
      this.setStatus(`${TOOL_LABEL[this.tool.name]}を作図しました（計 ${this.doc.count} 図形）`);
    }
    this.markDirty();
  }

  private cancelTool(): void {
    this.tool.reset();
    this.moveBase = null;
    if (this.tool.name === 'select') this.doc.selection.clear();
    this.setStatus('取消しました');
    this.markDirty();
  }

  private commitBoxSelection(downAt: Vec2, upAt: Vec2): void {
    const a = this.view.toWorld(downAt);
    const b = this.view.toWorld(upAt);
    const box = aabbFromCorners(a, b);
    // 右→左のドラッグは交差選択（AutoCAD と同じ）
    const crossing = upAt.x < downAt.x;
    if (!this.shiftHeld) this.doc.selection.clear();
    for (const e of this.doc.pickBox(box, crossing)) this.doc.selection.add(e.id);
    this.setStatus(`${this.doc.selection.size} 個選択（${crossing ? '交差' : '窓'}選択）`);
    this.markDirty();
  }

  private shiftHeld = false;

  private screenPoint(ev: MouseEvent | PointerEvent | WheelEvent): Vec2 {
    this.shiftHeld = ev.shiftKey;
    const r = this.canvas.getBoundingClientRect();
    return vec(ev.clientX - r.left, ev.clientY - r.top);
  }

  private updateCursor(screen: Vec2): void {
    this.cursorWorld = this.view.toWorld(screen);
    const tol = this.view.toWorldLen(this.snapSettings.pixelTolerance);
    this.snap = findSnap(this.doc, this.cursorWorld, tol, this.snapSettings);
    this.tool.moveCursor(this.snap?.at ?? applyGrid(this.cursorWorld, this.snapSettings));
  }

  // ---- UI ----------------------------------------------------------------

  private bindToolbar(): void {
    this.ui.toolbar.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest('button');
      if (!btn) return;
      const tool = btn.dataset['tool'];
      if (tool) {
        this.setTool(tool as ToolName);
        return;
      }
      switch (btn.dataset['cmd']) {
        case 'new':
          this.newDocument();
          break;
        case 'open':
          void this.open();
          break;
        case 'save':
          this.save();
          break;
        case 'export-dxf':
          this.exportDxf();
          break;
        case 'export-tc2':
          void this.exportTc2();
          break;
        case 'print':
          this.openPrintDialog();
          break;
        case 'dim-text':
          this.editDimText();
          break;
        case 'undo':
          this.undo();
          break;
        case 'redo':
          this.redo();
          break;
        case 'delete':
          this.deleteSelection();
          break;
        case 'zoom-in':
          this.zoom(1.25);
          break;
        case 'zoom-out':
          this.zoom(1 / 1.25);
          break;
        case 'zoom-fit':
          this.zoomFit();
          break;
        case 'zoom-actual':
          this.zoomActual();
          break;
        case 'osnap':
          this.toggleObjectSnap();
          break;
        case 'gsnap':
          this.toggleGridSnap();
          break;
        case 'bg':
          this.toggleBackground();
          break;
      }
    });
    this.updateToolbar();
  }

  private updateToolbar(): void {
    for (const btn of this.ui.toolbar.querySelectorAll('button')) {
      const tool = btn.dataset['tool'];
      if (tool) btn.classList.toggle('active', tool === this.tool.name);
      if (btn.dataset['cmd'] === 'osnap') btn.classList.toggle('active', this.snapSettings.objectSnap);
      if (btn.dataset['cmd'] === 'gsnap') btn.classList.toggle('active', this.snapSettings.gridSnap);
    }
  }

  private buildLayerList(): void {
    const host = this.ui.layerList;
    host.textContent = '';
    for (const layer of this.doc.layers.all()) {
      const row = document.createElement('label');
      row.className = 'layer-row';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = layer.visible;
      cb.addEventListener('change', () => {
        this.doc.layers.set({ ...layer, visible: cb.checked });
        this.markDirty();
      });

      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = layer.color;

      const name = document.createElement('span');
      name.className = 'layer-name';
      name.textContent = layer.name;

      const style = document.createElement('span');
      style.className = 'layer-style';
      style.textContent = LINE_STYLE_LABEL[layer.lineStyle];

      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'layer-use';
      use.textContent = '現在に';
      use.title = 'この画層を作図先にする';
      use.addEventListener('click', (ev) => {
        ev.preventDefault();
        this.attrs = { ...this.attrs, layer: layer.name };
        this.setStatus(`現在の画層: ${layer.name}`);
        this.markDirty();
      });

      row.append(cb, swatch, name, style, use);
      host.append(row);
    }
  }

  private setStatus(text: string): void {
    this.ui.status.textContent = text;
  }

  private handleResize(): void {
    const host = this.canvas.parentElement ?? this.canvas;
    const w = host.clientWidth;
    const h = host.clientHeight;
    this.view.resize(w, h);
    this.renderer.resize(w, h, window.devicePixelRatio);
    this.markDirty();
  }

  private markDirty(): void {
    this.dirty = true;
  }

  private frame(): void {
    if (this.dirty) this.drawNow();
    requestAnimationFrame(() => this.frame());
  }

  private drawNow(): void {
    this.dirty = false;
    const preview = [...this.tool.preview(), ...this.movePreview()];
    const pointerDragging = this.pointer?.dragged === true && this.pointer.button === 0;
    const selectionBox =
      pointerDragging && this.tool.name === 'select' && this.pointer
        ? {
            box: aabbFromCorners(this.view.toWorld(this.pointer.downAt), this.view.toWorld(this.pointer.lastAt)),
            crossing: this.pointer.lastAt.x < this.pointer.downAt.x,
          }
        : undefined;

    this.lastStats = this.renderer.draw(this.doc, this.view, {
      ...this.render,
      gridSize: this.snapSettings.gridSize,
      preview: preview.length > 0 ? preview : undefined,
      snap: this.snap,
      selectionBox,
    });
    this.updateInfo();
  }

  private movePreview(): Entity[] {
    if (!this.moveBase || (this.tool.name !== 'move' && this.tool.name !== 'copy')) return [];
    const d = sub(this.snap?.at ?? this.cursorWorld, this.moveBase);
    return this.doc.selectedEntities().map((e) => translateEntity(e, d) as Entity);
  }

  private updateInfo(): void {
    const cur = this.cursorWorld;
    const zoomPct = (this.view.scale * 100).toFixed(this.view.scale < 1 ? 2 : 0);
    const snapText = this.snap ? ` 吸着:${SNAP_LABEL[this.snap.kind]}` : '';
    const sel = this.doc.selection.size;

    const parts = [
      promptFor(this.tool.name, this.moveBase ? 1 : this.tool.pointCount),
      `X ${cur.x.toFixed(1)}  Y ${cur.y.toFixed(1)}`,
      `ズーム ${zoomPct}%`,
      `画層 ${this.attrs.layer}`,
      `選択 ${sel}/${this.doc.count}`,
      `描画 ${this.lastStats.drawn} (${this.lastStats.ms.toFixed(1)}ms)`,
    ];
    if (sel === 1) {
      const e = this.doc.selectedEntities()[0]!;
      const len = entityLength(e);
      const area = entityArea(e);
      const detail = [`種別 ${e.kind}`];
      if (len > 0) detail.push(`長さ ${len.toFixed(1)}mm`);
      if (area > 0) detail.push(`面積 ${(area / 1_000_000).toFixed(3)}㎡`);
      parts.push(detail.join('  '));
    }
    this.ui.info.textContent = parts.join('  |  ') + snapText;
  }

  /** 起動時のサンプル図形（空の画面だと操作の確かめようがないため）。 */
  private loadSample(): void {
    const b = { layer: '0', color: null, lineStyle: 'solid' as const, lineWidth: 0 };
    this.doc.addAll([
      { ...b, kind: 'rect', a: vec(0, 0), b: vec(10000, 6000) },
      { ...b, kind: 'circle', center: vec(5000, 3000), radius: 2000 },
      { ...b, layer: '境界', kind: 'polyline', points: [vec(0, 0), vec(10000, 0), vec(10000, 6000), vec(0, 6000)], closed: true },
      { ...b, layer: '点番', kind: 'text', at: vec(400, 6400), text: 'Tr-CAD2w', height: 500, rotation: 0, hAlign: 'left', vAlign: 'baseline' },
      { ...b, kind: 'line', a: vec(0, 0), b: vec(10000, 6000) },
      { ...b, kind: 'arc', center: vec(5000, 3000), radius: 3500, startAngle: 0, endAngle: Math.PI / 2 },
    ]);
  }
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
}
