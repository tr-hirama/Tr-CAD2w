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
import { CadDocument, type DocumentJson } from '../core/document.js';
import {
  Renderer,
  DEFAULT_RENDER,
  paperExtentOf,
  type RenderOptions,
  type RenderStats,
} from '../render/renderer.js';
import {
  fitScaleDenominator,
  makeLayout,
  makeViewport,
  viewportCorners,
  type LayoutSpace,
  type Viewport,
} from '../core/layout.js';
import { DEFAULT_SNAP, SNAP_LABEL, applyGrid, findSnap, type SnapResult, type SnapSettings } from '../core/snap.js';
import {
  EMPTY_AABB,
  aabbFromCorners,
  aabbUnion,
  deg,
  dist,
  distToSegment,
  rad,
  sub,
  vec,
  type Vec2,
} from '../core/geometry.js';
import {
  DEFAULT_HATCH_STYLE,
  cloneEntity,
  entityArea,
  entityBounds,
  entityLength,
  flatten,
  pointInPolygon,
  hitTest,
  translateEntity,
  type DimEntity,
  type Entity,
  type HatchPattern,
  type NewEntity,
} from '../core/entity.js';
import { STANDARD_COMMENTS, findStandardComment } from '../core/comments.js';
import { KYOKAI_KINDS, fileNameBaseOf, isProjectEmpty } from '../core/project-info.js';
import { HATCH_PATTERN_LABEL, boundaryOf } from '../core/hatch.js';
import { makeBlock } from '../core/block.js';
import { POINT_MODE_CHOICES, normalizeMode, pointModeLabel } from '../core/point-style.js';
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
import { ErrorGuard } from './error-guard.js';
import { InkPad } from './ink-pad.js';
import { calcLevel, summarizeLevel } from '../survey/level.js';
import { LINE_STYLE_LABEL } from '../render/linetype.js';
import { formatBenchResult, runRenderBench, type BenchResult } from '../render/bench.js';
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
import { defaultDxfFileName, documentToDxf, documentToDxfBytes } from '../io/dxf-write.js';
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
      /** 空間（モデル / レイアウト）の切替タブ。 */
      layoutTabs: HTMLElement;
      /** レベル（水準）の枠（無い図面では隠す）。 */
      levelPanel: HTMLElement;
      levelList: HTMLElement;
    },
  ) {
    this.renderer = new Renderer(canvas);
    // 画像は復号が終わってから描ける。終わったら描き直す
    // （繋がないと、置いた画像が次の操作まで画面に出ない）
    this.renderer.onImageLoad = () => this.markDirty();
    this.bindPointer();
    this.bindKeyboard();
    this.bindToolbar();
    this.bindDragAndDrop();
    this.buildLayerList();
    this.buildLevelList();
    this.buildLayoutTabs();

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
    const layout = this.activeLayout();
    if (layout) {
      // 用紙空間は「紙が画面に収まる」ことを全体表示とする
      const size = paperExtentOf(layout);
      this.view.zoomToFit({ minX: 0, minY: 0, maxX: size.width, maxY: size.height });
      this.markDirty();
      return;
    }
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
    const layout = this.activeLayout();
    if (layout) {
      // 用紙空間では、そのレイアウトの図形とビューポートを消す
      this.doc.beginEdit();
      const before = layout.entities.length + layout.viewports.length;
      const target = this.activeLayout()!;
      target.entities = target.entities.filter((e) => !this.doc.selection.has(e.id));
      target.viewports = target.viewports.filter((v) => !this.doc.selection.has(v.id));
      const n = before - (target.entities.length + target.viewports.length);
      this.doc.selection.clear();
      this.setStatus(`${n} 個削除しました`);
      this.markDirty();
      return;
    }
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
    for (const e of this.spaceEntities()) {
      if (this.doc.layers.isVisible(e.layer)) this.doc.selection.add(e.id);
    }
    this.markDirty();
  }

  save(): void {
    downloadText(this.saveNameOf(defaultFileName(new Date())), serialize(this.doc.toJson()));
    this.setStatus('図面を保存しました');
  }

  /**
   * 保存名。**概要コード（無ければ現場名）があればそれを使う**
   * （デスクトップ版が `GaiyoCD` を保存名の既定にしているのに合わせる）。
   * 概要が空なら日時つきの既定名のまま。
   */
  private saveNameOf(fallback: string): string {
    const base = fileNameBaseOf(this.doc.info.project);
    if (base === null) return fallback;
    const ext = fallback.slice(fallback.lastIndexOf('.'));
    return `${base}${ext}`;
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

  /**
   * Shift-JIS（`ANSI_932`）で DXF を書き出す。**旧 AutoCAD / ZWCAD 向け**（issue #4）。
   *
   * R2007 は UTF-8 前提なので、こちらは R2000（AC1015）で出す。Shift-JIS に無い
   * 文字は `?` へ落ちるので、**落ちたときは何が落ちたかを画面に出す**。
   */
  exportDxfSjis(): void {
    if (this.doc.count === 0) {
      this.setStatus('書き出す図形がありません');
      return;
    }
    const r = documentToDxfBytes(this.doc.toJson(), { encoding: 'shift_jis' });
    downloadBytes(defaultDxfFileName(new Date()), r.bytes, 'application/dxf');
    const lost =
      r.unmapped === 0
        ? ''
        : `／${r.unmapped} 文字が Shift-JIS に無く ? になりました: ${r.unmappedChars.slice(0, 8).join('')}`;
    this.setStatus(`DXF で書き出しました（${this.doc.count} 図形・Shift-JIS / R2000）${lost}`);
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
        // 用紙空間を開いていれば、そのレイアウトをそのまま 1 ページとして刷る
        activeLayout: () => this.activeLayout(),
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
      this.buildLevelList();
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
      downloadBytes(this.saveNameOf(defaultTc2FileName(new Date())), bytes, 'application/zip');
      this.setStatus(`.tc2 で書き出しました（${this.doc.count} 図形・${bytes.length} バイト）`);
    } catch (err) {
      this.setStatus(`.tc2 を書き出せませんでした: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- 概要・注記文・境界コメント・メモ ------------------------------------

  /** 概要（現場名・概要コード・作業者・備考）。**概要コードは保存名の既定にも使う。** */
  editProject(): void {
    const p = this.doc.info.project;
    const name = window.prompt('現場名', p.name);
    if (name === null) return;
    const code = window.prompt('概要コード（保存名の既定になります）', p.code);
    if (code === null) return;
    const worker = window.prompt('作業者', p.worker);
    if (worker === null) return;
    const note = window.prompt('備考', p.note);
    if (note === null) return;
    this.doc.info.project = { name, code, worker, note };
    this.setStatus(
      isProjectEmpty(this.doc.info.project) ? '概要を空にしました' : `概要: ${name || '(現場名なし)'}／${code || '(コードなし)'}`,
    );
    this.updateTitle();
  }

  /**
   * 標準注記文の選択。番号（`1,3,5` の形）で選ぶ。
   * すでに選ばれているものは外れ、**編集済みの本文はそのまま残す**。
   */
  editComments(): void {
    const checked = this.doc.info.comments.filter((c) => c.checked).map((c) => c.key);
    const list = STANDARD_COMMENTS.map((c) => `${c.key}: ${c.summary.slice(0, 40)}`).join('\n');
    const input = window.prompt(`入れる注記文の番号をカンマ区切りで\n\n${list}`, checked.join(','));
    if (input === null) return;

    const keys = input
      .split(/[,、\s]+/)
      .map((s) => s.trim())
      .filter((s) => s !== '');
    const unknown = keys.filter((k) => !findStandardComment(k));
    if (unknown.length > 0) {
      this.setStatus(`知らない番号があります: ${unknown.join(', ')}`);
      return;
    }

    // 編集済みの本文は残したいので、既存の項目を引き継ぐ
    const existing = new Map(this.doc.info.comments.map((c) => [c.key, c]));
    this.doc.info.comments = STANDARD_COMMENTS.filter((c) => keys.includes(c.key) || existing.has(c.key)).map((c) => {
      const prev = existing.get(c.key);
      return { key: c.key, checked: keys.includes(c.key), text: prev?.text ?? c.text };
    });
    this.setStatus(`注記文を ${keys.length} 件選びました`);
  }

  /** 選んだ注記文の本文を書き換える（`|` が改行）。 */
  editCommentText(): void {
    const chosen = this.doc.info.comments.filter((c) => c.checked);
    if (chosen.length === 0) {
      this.setStatus('先に「注記文」で番号を選んでください');
      return;
    }
    const keyText = window.prompt(`本文を直す注記文の番号（${chosen.map((c) => c.key).join(',')}）`, chosen[0]!.key);
    if (keyText === null) return;
    const target = this.doc.info.comments.find((c) => c.key === keyText.trim());
    if (!target) {
      this.setStatus(`選ばれていない番号です: ${keyText}`);
      return;
    }
    const text = window.prompt('本文（| が改行）', target.text);
    if (text === null) return;
    target.text = text;
    this.setStatus(`注記文 ${target.key} の本文を直しました`);
  }

  /** 境界コメント（境界番号と境界標の種類）を 1 件足す。 */
  addKyokaiComment(): void {
    const name = window.prompt('境界番号', '');
    if (name === null || name.trim() === '') return;
    const kind = window.prompt(`境界標の種類\n（${KYOKAI_KINDS.join(' / ')}）`, KYOKAI_KINDS[0]!);
    if (kind === null) return;
    this.doc.info.kyokai.push({ name: name.trim(), kind: kind.trim() });
    this.setStatus(`境界コメントを足しました（計 ${this.doc.info.kyokai.length} 件）`);
  }

  /** メモ（テキスト）。**手書きメモは Web で描けないので触らない。** */
  editMemo(): void {
    const text = window.prompt('メモ', this.doc.info.memoText);
    if (text === null) return;
    this.doc.info.memoText = text;
    const strokes = this.doc.info.memoStrokes;
    this.setStatus(
      strokes.length === 0
        ? 'メモを更新しました'
        : `メモを更新しました（手書き ${strokes.length} 本はそのまま残ります）`,
    );
  }

  /**
   * 手書きメモを描く（issue #39・案 B）。
   *
   * 画面いっぱいのオーバーレイを開き、点列として保存する。**ISF は持たない**ので、
   * ここで描いたものがそのまま `.tc2` の `MemoStrokes` になる。
   */
  editMemoInk(): void {
    if (this.inkPad) return; // 二重に開かない
    this.inkPad = new InkPad(this.doc.info.memoStrokes, {
      onSave: (strokes) => {
        this.doc.info.memoStrokes = strokes;
        this.setStatus(
          strokes.length === 0
            ? '手書きメモを消しました'
            : `手書きメモを保存しました（${strokes.length} 本）`,
        );
      },
      onClose: () => {
        this.inkPad = null;
      },
    });
    this.setStatus('手書きメモ: ペンで描き、消しゴムで消します（Esc で閉じる）');
  }

  /** 開いている手書きメモの面（二重に開かないため）。 */
  private inkPad: InkPad | null = null;

  /** 概要を画面のタイトルへ出す（デスクトップ版はタイトルバーに出す）。 */
  private updateTitle(): void {
    const p = this.doc.info.project;
    const label = [p.code, p.name].filter((s) => s !== '').join(' ');
    document.title = label === '' ? 'Tr-CAD2w' : `${label} - Tr-CAD2w`;
  }

  // ---- ハッチ・ブロック・画像 --------------------------------------------

  /** 次に作るハッチのパターンと間隔（ツールバーから変える）。 */
  hatchStyle = { ...DEFAULT_HATCH_STYLE };

  /** 挿入するブロックの名前（`insert` ツールが使う）。 */
  currentBlock = '';

  /**
   * 閉じた図形をクリックして塗る。
   * 境界は図形の折れ線展開から採る（矩形・円・閉じた連続線・ハッチ）。
   */
  private handleHatchClick(p: Vec2): void {
    // 線の上を押しても、囲まれた内側を押しても塗れるようにする
    const hit = this.doc.pick(p, this.view.toWorldLen(6)) ?? this.enclosingShape(p);
    if (!hit) {
      this.setStatus('塗る図形をクリックしてください');
      return;
    }
    const boundary = boundaryOf(hit.kind === 'hatch' ? [hit.points] : flatten(hit, 96));
    if (!boundary) {
      this.setStatus(`${TOOL_LABEL['hatch']}にできない図形です（閉じた矩形・円・連続線を選んでください）`);
      return;
    }
    this.doc.beginEdit();
    const created = this.doc.add({
      layer: this.attrs.layer,
      color: this.attrs.color,
      lineStyle: this.attrs.lineStyle,
      lineWidth: this.attrs.lineWidth,
      kind: 'hatch',
      points: boundary,
      pattern: this.hatchStyle.pattern,
      spacing: this.hatchStyle.spacing,
    });
    // 塗りは境界の下に置く（線を隠さない）
    this.doc.sendToBack([created.id]);
    this.doc.selection.clear();
    this.doc.selection.add(created.id);
    this.setStatus(
      `${HATCH_PATTERN_LABEL[this.hatchStyle.pattern]}で塗りました（間隔 ${this.hatchStyle.spacing}mm・計 ${this.doc.count} 図形）`,
    );
    this.markDirty();
  }

  /**
   * 点の表示スタイル（形とサイズ）を決める。**図面全体に効く**（`PDMODE` / `PDSIZE`）。
   * サイズ 0 は画面固定、正の値ならワールド寸法なのでズームに追従する。
   */
  editPointStyle(): void {
    const choices = POINT_MODE_CHOICES.map((c) => `${c.mode}=${c.label}`).join(' / ');
    const modeText = window.prompt(`点の形\n${choices}`, String(this.doc.pointStyle.mode));
    if (modeText === null) return;
    const sizeText = window.prompt('点の大きさ（mm。0 は画面固定でズームに追従しない）', String(this.doc.pointStyle.size));
    if (sizeText === null) return;
    const mode = Number(modeText);
    const size = Number(sizeText);
    if (!Number.isFinite(mode) || mode < 0 || !Number.isFinite(size) || size < 0) {
      this.setStatus('形は 0 以上の整数、大きさは 0 以上の数値で入れてください');
      return;
    }
    this.doc.pointStyle = { mode: normalizeMode(mode), size };
    this.setStatus(
      `点の表示: ${pointModeLabel(this.doc.pointStyle.mode)}・${
        size > 0 ? `${size}mm（ズームに追従）` : '画面固定'
      }`,
    );
    this.markDirty();
  }

  /**
   * 点を囲んでいる閉じた図形のうち、いちばん手前のもの。
   * 塗るときに「囲まれた中を押す」操作を通すために使う。
   */
  private enclosingShape(p: Vec2): Entity | undefined {
    const candidates = this.doc.visibleIn({ minX: p.x, minY: p.y, maxX: p.x, maxY: p.y });
    for (let i = candidates.length - 1; i >= 0; i--) {
      const e = candidates[i]!;
      if (e.kind === 'polyline' && !e.closed) continue;
      const ring = e.kind === 'hatch' ? e.points : boundaryOf(flatten(e, 96));
      if (ring && pointInPolygon(ring, p)) return e;
    }
    return undefined;
  }

  // ---- 用紙空間（レイアウト） --------------------------------------------

  /**
   * いま開いている空間。`null` はモデル空間、数値は `doc.layouts` の位置。
   * **用紙空間ではワールドが「紙 mm・原点は紙の左下」に変わる。**
   */
  private layoutIndex: number | null = null;

  activeLayout(): LayoutSpace | null {
    if (this.layoutIndex === null) return null;
    return this.doc.layouts[this.layoutIndex] ?? null;
  }

  get spaceName(): string {
    return this.activeLayout()?.name ?? 'モデル';
  }

  /** モデル空間（`null`）／レイアウトを切り替える。 */
  switchSpace(index: number | null): void {
    if (index !== null && !this.doc.layouts[index]) return;
    this.layoutIndex = index;
    this.doc.selection.clear();
    this.tool.reset();
    this.moveBase = null;
    this.zoomFit();
    this.buildLayoutTabs();
    this.setStatus(index === null ? 'モデル空間へ切り替えました' : `「${this.spaceName}」へ切り替えました`);
    this.markDirty();
  }

  /** レイアウトを 1 つ足して、そこへ切り替える。 */
  addLayout(): void {
    const name = `レイアウト${this.doc.layouts.length + 1}`;
    this.doc.beginEdit();
    this.doc.layouts.push(makeLayout(name, this.printSettings.paper, this.printSettings.orientation));
    this.switchSpace(this.doc.layouts.length - 1);
    this.setStatus(`「${name}」を作りました（用紙 ${this.printSettings.paper}）。ビューポートで図面を映せます`);
  }

  /** いま開いているレイアウトを削除する。 */
  removeLayout(): void {
    const i = this.layoutIndex;
    if (i === null) {
      this.setStatus('モデル空間は削除できません');
      return;
    }
    const name = this.spaceName;
    this.doc.beginEdit();
    this.doc.layouts.splice(i, 1);
    this.switchSpace(this.doc.layouts.length > 0 ? Math.min(i, this.doc.layouts.length - 1) : null);
    this.setStatus(`「${name}」を削除しました`);
  }

  /** ビューポート（紙に開ける窓）を 2 クリックの矩形で作る。 */
  private handleViewportClick(p: Vec2): void {
    const layout = this.activeLayout();
    if (!layout) {
      this.setStatus('先にレイアウトへ切り替えてください');
      return;
    }
    if (this.viewportCorner === null) {
      this.viewportCorner = p;
      this.setStatus('窓の対角をクリックしてください');
      this.markDirty();
      return;
    }
    const a = this.viewportCorner;
    this.viewportCorner = null;
    const rect = {
      x: Math.min(a.x, p.x),
      y: Math.min(a.y, p.y),
      width: Math.abs(p.x - a.x),
      height: Math.abs(p.y - a.y),
    };
    if (rect.width < 1 || rect.height < 1) {
      this.setStatus('窓が小さすぎます（1mm 以上の矩形をとってください）');
      return;
    }

    // 図面全体がちょうど収まる縮尺と中心を初期値にする
    const b = this.doc.printBounds();
    const hasDrawing = b.minX <= b.maxX;
    const center = hasDrawing ? vec((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2) : vec(0, 0);
    const denom = hasDrawing ? fitScaleDenominator(rect, b.maxX - b.minX, b.maxY - b.minY) : 100;

    this.doc.beginEdit();
    const vp = makeViewport(this.doc.reserveId(), rect, center, denom);
    layout.viewports.push(vp);
    this.doc.selection.clear();
    this.doc.selection.add(vp.id);
    this.setStatus(`ビューポートを作りました（縮尺 1:${formatDenominator(vp.scaleDenominator)}）`);
    this.markDirty();
  }

  /** ビューポート作成の 1 点目。 */
  private viewportCorner: Vec2 | null = null;

  /** 選択中のビューポート（無ければ `null`）。 */
  private selectedViewport(): Viewport | null {
    const layout = this.activeLayout();
    if (!layout) return null;
    return layout.viewports.find((v) => this.doc.selection.has(v.id)) ?? null;
  }

  /** 選択中のビューポートの縮尺・回転を変える。 */
  editViewport(): void {
    const vp = this.selectedViewport();
    if (!vp) {
      this.setStatus('先にビューポートの枠をクリックして選んでください');
      return;
    }
    const denomText = window.prompt('縮尺の分母（1:N の N）', formatDenominator(vp.scaleDenominator));
    if (denomText === null) return;
    const rotText = window.prompt('窓の中の回転角（度・反時計回り）', String(Math.round(deg(vp.rotation))));
    if (rotText === null) return;
    const denom = Number(denomText);
    const rot = Number(rotText);
    if (!Number.isFinite(denom) || denom <= 0 || !Number.isFinite(rot)) {
      this.setStatus('縮尺は正の数、回転角は数値で入れてください');
      return;
    }
    this.doc.beginEdit();
    vp.scaleDenominator = denom;
    vp.rotation = rad(rot);
    this.setStatus(`ビューポート: 縮尺 1:${formatDenominator(denom)}・回転 ${rot}°`);
    this.markDirty();
  }

  /** 選択中のビューポートに、図面全体が収まるよう縮尺と中心を合わせる。 */
  fitViewport(): void {
    const vp = this.selectedViewport();
    if (!vp) {
      this.setStatus('先にビューポートの枠をクリックして選んでください');
      return;
    }
    const b = this.doc.printBounds();
    if (!(b.minX <= b.maxX)) {
      this.setStatus('モデル空間に図形がありません');
      return;
    }
    this.doc.beginEdit();
    vp.center = vec((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
    vp.scaleDenominator = fitScaleDenominator(vp.paperRect, b.maxX - b.minX, b.maxY - b.minY);
    this.setStatus(`窓に図面を合わせました（縮尺 1:${formatDenominator(vp.scaleDenominator)}）`);
    this.markDirty();
  }

  /**
   * いま開いている空間へ図形を足す。
   * モデル空間なら図面へ、用紙空間ならそのレイアウトへ（座標は紙 mm）。
   */
  private addToSpace(list: readonly NewEntity[]): Entity[] {
    const layout = this.activeLayout();
    if (!layout) return this.doc.addAll(list);
    const made = list.map((e) => ({ ...e, id: this.doc.reserveId() }) as Entity);
    layout.entities.push(...made);
    return made;
  }

  /** いま開いている空間の図形（描画・選択・情報表示で使う）。 */
  private spaceEntities(): readonly Entity[] {
    return this.activeLayout()?.entities ?? this.doc.entities;
  }

  /** いま開いている空間で選ばれている図形。 */
  private selectedInSpace(): Entity[] {
    return this.spaceEntities().filter((e) => this.doc.selection.has(e.id));
  }

  /**
   * いま開いている空間で点に当たるもの。
   * 用紙空間では**ビューポートの枠**も掴める（枠を選んで縮尺を変えるため）。
   */
  private pickInSpace(p: Vec2, tol: number): Entity | Viewport | undefined {
    const layout = this.activeLayout();
    if (!layout) return this.doc.pick(p, tol);
    for (let i = layout.entities.length - 1; i >= 0; i--) {
      const e = layout.entities[i]!;
      if (this.doc.layers.isVisible(e.layer) && hitTest(e, p, tol)) return e;
    }
    for (let i = layout.viewports.length - 1; i >= 0; i--) {
      const vp = layout.viewports[i]!;
      if (polylineNear(viewportCorners(vp), p, tol)) return vp;
    }
    return undefined;
  }

  /** ハッチのパターンを順に切り替える。 */
  cycleHatchPattern(): void {
    const order: HatchPattern[] = ['solid', 'line45', 'line135', 'cross', 'grid'];
    const i = order.indexOf(this.hatchStyle.pattern);
    const next = order[(i + 1) % order.length]!;
    this.hatchStyle = { ...this.hatchStyle, pattern: next };
    this.setStatus(`ハッチのパターン: ${HATCH_PATTERN_LABEL[next]}`);
    this.updateToolbar();
  }

  /**
   * 別図面（`.tc2w` / `.tc2` / DXF）をブロックとして読み込む。
   * 読んだ中身は**挿入点を原点に寄せて**ブロック定義にする。
   */
  async importBlock(): Promise<void> {
    const picked = await pickFile();
    if (!picked) return;
    try {
      const json = await readAnyDrawing(picked);
      if (json.entities.length === 0) throw new Error('読める図形がありませんでした');
      // 図面の左下が原点に来るよう寄せる（挿入点が図形の隅になって扱いやすい）
      let box = EMPTY_AABB;
      for (const e of json.entities) box = aabbUnion(box, entityBounds(e));
      const d = vec(-box.minX, -box.minY);
      const entities = json.entities.map((e: Entity) => translateEntity(cloneEntity(e), d));
      const name = picked.name.replace(/\.[^.]+$/, '');
      this.doc.beginEdit();
      this.doc.setBlock(makeBlock(name, entities));
      this.currentBlock = name;
      this.setTool('insert');
      this.setStatus(`ブロック「${name}」を読み込みました（${entities.length} 図形）。置く位置をクリックしてください`);
    } catch (err) {
      this.setStatus(`ブロックを読めませんでした: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.markDirty();
  }

  /** ブロックを置く。倍率・回転はその場で聞く。 */
  private handleInsertClick(p: Vec2): void {
    const names = this.doc.blocks.map((b) => b.name);
    if (names.length === 0) {
      this.setStatus('先に「ブロック読込」で別図面を読み込んでください');
      return;
    }
    const name = names.includes(this.currentBlock) ? this.currentBlock : names[0]!;
    const scaleText = window.prompt(`「${name}」の倍率`, '1');
    if (scaleText === null) return;
    const rotText = window.prompt('回転角（度・反時計回り）', '0');
    if (rotText === null) return;
    const scale = Number(scaleText);
    const rotation = Number(rotText);
    if (!Number.isFinite(scale) || scale === 0 || !Number.isFinite(rotation)) {
      this.setStatus('倍率と回転角は数値で入れてください（倍率 0 は不可）');
      return;
    }

    this.doc.beginEdit();
    const created = this.doc.add({
      layer: this.attrs.layer,
      color: this.attrs.color,
      lineStyle: this.attrs.lineStyle,
      lineWidth: this.attrs.lineWidth,
      kind: 'insert',
      blockName: name,
      at: p,
      scale,
      scaleY: 0, // 0 = X と同じ（等倍）
      rotation: rad(rotation),
    });
    this.doc.selection.clear();
    this.doc.selection.add(created.id);
    this.setStatus(`ブロック「${name}」を置きました（${this.doc.explode(created).length} 図形に展開）`);
    this.markDirty();
  }

  /**
   * 画像を選んで、次の 2 クリックで置く矩形を決める。
   * **バイト列は図面に埋め込む**ので、元のファイルが無くても開ける。
   */
  async pickImage(): Promise<void> {
    const picked = await pickFile('image/*');
    if (!picked) return;
    const mime = mimeOfImageName(picked.name);
    if (!mime) {
      this.setStatus('PNG / JPEG / GIF / WebP の画像を選んでください');
      return;
    }
    this.pendingImage = { dataUrl: `data:${mime};base64,${base64OfBytes(picked.bytes)}`, name: picked.name };
    this.setTool('image');
    this.setStatus(`${picked.name} を置きます。2 点で配置する矩形をクリックしてください`);
  }

  /** 配置待ちの画像（`pickImage` で選び、2 クリックで確定する）。 */
  private pendingImage: { dataUrl: string; name: string } | null = null;

  private handleImageClick(p: Vec2): void {
    if (!this.pendingImage) {
      void this.pickImage();
      return;
    }
    // 1 点目を覚え、2 点目で矩形を決める
    if (this.imageCorners.length === 0) {
      this.imageCorners = [p];
      this.setStatus('対角をクリックしてください');
      this.markDirty();
      return;
    }
    const a = this.imageCorners[0]!;
    this.imageCorners = [];
    if (Math.abs(p.x - a.x) < 1e-9 || Math.abs(p.y - a.y) < 1e-9) {
      this.setStatus('つぶれた矩形には置けません。離れた 2 点をクリックしてください');
      return;
    }
    const img = this.pendingImage;
    this.pendingImage = null;
    this.doc.beginEdit();
    const created = this.doc.add({
      layer: this.attrs.layer,
      color: this.attrs.color,
      lineStyle: this.attrs.lineStyle,
      lineWidth: this.attrs.lineWidth,
      kind: 'image',
      a,
      b: p,
      dataUrl: img.dataUrl,
      opacity: 1,
    });
    // 画像は常に最背面
    this.doc.sendToBack([created.id]);
    this.doc.selection.clear();
    this.doc.selection.add(created.id);
    this.setStatus(`${img.name} を置きました（${Math.round(img.dataUrl.length / 1024)}KB を図面に埋め込み）`);
    this.markDirty();
  }

  /** 画像ツールの 1 点目（2 点目が来たら矩形にする）。 */
  private imageCorners: Vec2[] = [];

  /** 画面下のレイアウトタブを作り直す。 */
  private buildLayoutTabs(): void {
    const host = this.ui.layoutTabs;
    if (!host) return;
    host.textContent = '';

    const tab = (label: string, index: number | null): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.className = this.layoutIndex === index ? 'tab active' : 'tab';
      b.addEventListener('click', () => this.switchSpace(index));
      return b;
    };

    host.append(tab('モデル', null));
    this.doc.layouts.forEach((l, i) => host.append(tab(l.name, i)));

    const add = document.createElement('button');
    add.type = 'button';
    add.textContent = '＋';
    add.title = 'レイアウトを追加';
    add.className = 'tab add';
    add.addEventListener('click', () => this.addLayout());
    host.append(add);
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

  /**
   * 描画の計測（開発者コンソールから `TrCad2w.bench()`）。
   *
   * **WebGL 化の可否はこの数値を見てから決める**（issue #16）。
   * いまの図面は壊さない（計測用の図面を別に作って描く）。
   */
  bench(count = 30_000): BenchResult {
    const result = runRenderBench(
      this.renderer,
      { width: this.view.width, height: this.view.height },
      { count, render: { background: this.render.background, darkBoost: this.render.darkBoost } },
    );
    // 計測で画面が計測用の図面になっているので、元の図面を描き直す
    this.markDirty();
    this.drawNow();
    // eslint-disable-next-line no-console -- 計測結果はコンソールで見るためのもの
    console.log(formatBenchResult(result));
    this.setStatus(
      `計測: ${result.entities.toLocaleString()} 図形 → ` +
        result.cases.map((c) => `${c.name} ${c.msMedian}ms`).join(' / '),
    );
    return result;
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

    if (this.tool.name === 'viewport') {
      this.handleViewportClick(p);
      return;
    }

    if (this.tool.name === 'select') {
      const hit = this.pickInSpace(p, this.view.toWorldLen(6));
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

    if (this.tool.name === 'hatch') {
      this.handleHatchClick(p);
      return;
    }
    if (this.tool.name === 'insert') {
      this.handleInsertClick(p);
      return;
    }
    if (this.tool.name === 'image') {
      this.handleImageClick(p);
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
      const created = this.addToSpace(step.created);
      this.setStatus(
        `${TOOL_LABEL[this.tool.name]}を作図しました（${this.spaceName}・計 ${this.spaceEntities().length} 図形）`,
      );
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
    const layout = this.activeLayout();
    this.doc.beginEdit();
    if (this.tool.name === 'move') {
      if (layout) {
        // 用紙空間: 図形は移動、ビューポートは窓ごと動かす
        layout.entities = layout.entities.map((e) =>
          this.doc.selection.has(e.id) ? (translateEntity(e, d) as Entity) : e,
        );
        for (const vp of layout.viewports) {
          if (!this.doc.selection.has(vp.id)) continue;
          vp.paperRect = { ...vp.paperRect, x: vp.paperRect.x + d.x, y: vp.paperRect.y + d.y };
        }
      } else {
        for (const e of this.doc.selectedEntities()) this.doc.replace(translateEntity(e, d) as Entity);
      }
      this.setStatus(`${this.doc.selection.size} 個を移動しました`);
      this.moveBase = null;
      this.markDirty();
      return;
    }
    {
      const copies = this.selectedInSpace().map((e) => {
        const moved = translateEntity(cloneEntity(e), d);
        const { id: _id, ...rest } = moved;
        return rest as NewEntity;
      });
      const added = this.addToSpace(copies);
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
        case 'export-dxf-sjis':
          this.exportDxfSjis();
          break;
        case 'export-tc2':
          void this.exportTc2();
          break;
        case 'print':
          this.openPrintDialog();
          break;
        case 'project':
          this.editProject();
          break;
        case 'comments':
          this.editComments();
          break;
        case 'comment-text':
          this.editCommentText();
          break;
        case 'kyokai':
          this.addKyokaiComment();
          break;
        case 'memo':
          this.editMemo();
          break;
        case 'memo-ink':
          this.editMemoInk();
          break;
        case 'hatch-pattern':
          this.cycleHatchPattern();
          break;
        case 'import-block':
          void this.importBlock();
          break;
        case 'pick-image':
          void this.pickImage();
          break;
        case 'point-style':
          this.editPointStyle();
          break;
        case 'vp-scale':
          this.editViewport();
          break;
        case 'vp-fit':
          this.fitViewport();
          break;
        case 'layout-remove':
          this.removeLayout();
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

  /**
   * レベル（水準）の一覧（**表示だけ**。issue #29 の 1/3）。
   *
   * `.tc2` から読んだ入力を器高式で解いて、測点・後視・前視・地盤高を並べる。
   * **解けなかった行は数と理由を出す**（黙って消すと、入力の取りこぼしに気づけない）。
   * レベルが無い図面では枠ごと隠す。
   */
  private buildLevelList(): void {
    const panel = this.ui.levelPanel;
    const host = this.ui.levelList;
    if (!panel || !host) return;
    panel.hidden = this.doc.level.length === 0;
    if (panel.hidden) return;

    host.textContent = '';
    const calc = calcLevel(this.doc.level);

    const t = document.createElement('table');
    t.className = 'level-table';
    const head = document.createElement('tr');
    for (const label of ['測点', '後視', '前視', '地盤高']) {
      const th = document.createElement('th');
      th.textContent = label;
      head.append(th);
    }
    t.append(head);
    for (const row of calc.rows) {
      const tr = document.createElement('tr');
      if (row.kind === 'instrument') tr.className = 'instrument';
      const cells = [row.name, fmt(row.bs), fmt(row.fs), fmt(row.gh)];
      for (const v of cells) {
        const td = document.createElement('td');
        td.textContent = v;
        tr.append(td);
      }
      t.append(tr);
    }
    host.append(t);

    const s = summarizeLevel(calc);
    const sum = document.createElement('p');
    sum.className = 'level-note';
    sum.textContent = `後視計 ${fmt(s.totalBs)} ／ 前視計 ${fmt(s.totalFs)} ／ 高低差 ${fmt(s.difference)}（${s.resolved} 点）`;
    host.append(sum);

    if (calc.unresolved.length > 0) {
      const warn = document.createElement('p');
      warn.className = 'level-note warn';
      const first = calc.unresolved[0]!;
      warn.textContent =
        calc.unresolved.length === 1
          ? `解けない行が 1 件: ${first.name} — ${first.reason}`
          : `解けない行が ${calc.unresolved.length} 件（例: ${first.name} — ${first.reason}）`;
      host.append(warn);
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

  /**
   * 描画ループ。**例外が出ても次のフレームを必ず予約する。**
   *
   * ここで例外が抜けると `requestAnimationFrame` の再帰が途切れ、以後いっさい
   * 描画されない（画面が固まったまま戻らない。issue #34）。握りつぶすのではなく、
   * **初出はコンソールとステータスバーに必ず出す**。同じ例外は 60fps で出続けるので
   * `ErrorGuard` が 2 回目以降を黙らせる。
   */
  private frame(): void {
    try {
      if (this.dirty) this.drawNow();
    } catch (err) {
      const first = this.errors.report(err);
      if (first) {
        console.error('[Tr-CAD2w] 描画中に例外が出ました:', err);
        this.setStatus(`描画でエラーが出ました: ${first.message}（詳細はコンソール）`);
      }
      // 同じ状態で毎フレーム投げ直さないよう、要求は下ろす（次の操作で立て直る）
      this.dirty = false;
    }
    requestAnimationFrame(() => this.frame());
  }

  /** 描画で出た例外の受け皿（同じものを何度も報告しない）。 */
  private readonly errors = new ErrorGuard();

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

    const layout = this.activeLayout();
    this.lastStats = layout
      ? this.renderer.drawLayout(this.doc, layout, this.view, {
          ...this.render,
          // 紙の上にモデル空間のグリッドを出すと目盛りが噛み合わず読みにくい
          showGrid: false,
          showAxis: false,
          gridSize: this.snapSettings.gridSize,
          margin: this.printSettings.margin,
          preview: preview.length > 0 ? preview : undefined,
          snap: this.snap,
          selectionBox,
        })
      : this.renderer.draw(this.doc, this.view, {
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
      // **いま開いている空間から拾う。** モデル空間だけを見ると、用紙空間で
      // 図形を選んだときに undefined を掴んで落ちる（issue #40）
      const detail = selectionDetail(this.selectedInSpace()[0], this.selectedViewport());
      if (detail !== '') parts.push(detail);
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

/**
 * 図面ファイルを形式によらず読む（ブロック読込で使う）。
 * **形式は拡張子ではなく中身で見分ける**（`.tc2` は ZIP）。
 */
async function readAnyDrawing(picked: PickedFile): Promise<DocumentJson> {
  if (looksLikeZip(picked.bytes)) return (await readTc2(picked.bytes)).json;
  if (/\.dxf$/i.test(picked.name)) return readDxfBytes(picked.bytes).json;
  return deserialize(decodeUtf8(picked.bytes));
}

/** 画像のファイル名から MIME を決める。対応外は `null`。 */
export function mimeOfImageName(name: string): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    default:
      return null;
  }
}

/**
 * バイト列 → base64。
 *
 * `btoa(String.fromCharCode(...bytes))` は**引数が多すぎると落ちる**ので
 * （画像は数十万バイトになる）、小分けにして繋ぐ。
 */
export function base64OfBytes(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

/** 縮尺の分母の表示（`1:200` / `1:2.5`）。整数はそのまま、端数だけ小数で見せる。 */
export function formatDenominator(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');
}

/**
 * 選択が 1 つのときに情報行へ出す説明（issue #40）。
 *
 * **図形とビューポートは別物。** ビューポートは `Entity` ではないので
 * `entityLength` / `entityArea` に渡してはいけない。どちらも無ければ空文字。
 */
export function selectionDetail(entity: Entity | undefined, viewport: Viewport | null): string {
  if (entity) {
    const len = entityLength(entity);
    const area = entityArea(entity);
    const detail = [`種別 ${entity.kind}`];
    if (len > 0) detail.push(`長さ ${len.toFixed(1)}mm`);
    if (area > 0) detail.push(`面積 ${(area / 1_000_000).toFixed(3)}㎡`);
    return detail.join('  ');
  }
  if (viewport) {
    return `種別 ビューポート  縮尺 1:${formatDenominator(viewport.scaleDenominator)}  回転 ${Math.round(deg(viewport.rotation))}°`;
  }
  // 選択はあるが、いま開いている空間には無い（別の空間の図形）
  return '';
}

/** レベルの数値表示（m）。`null` は空欄。端数は 3 桁まで。 */
function fmt(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '';
  // 桁を揃える。帳票では 1.5 と 11.25 が並ぶより 1.500 / 11.250 の方が比べやすい
  return v.toFixed(3);
}

/** 閉じた点列の**辺の近く**か（ビューポートの枠を掴むのに使う）。 */
function polylineNear(points: readonly Vec2[], p: Vec2, tol: number): boolean {
  for (let i = 0; i < points.length; i++) {
    if (distToSegment(p, points[i]!, points[(i + 1) % points.length]!) <= tol) return true;
  }
  return false;
}
