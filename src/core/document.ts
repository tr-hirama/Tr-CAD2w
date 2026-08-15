/**
 * 図面（図形の集合・画層・選択・Undo）。
 *
 * Undo は**スナップショット方式**（図形配列の複製を積む）。図形数が数万に届く
 * までは十分速く、コマンド追加のたびに逆操作を書く必要がない。
 */

import type { Aabb, Vec2 } from './geometry.js';
import { EMPTY_AABB, aabbUnion } from './geometry.js';
import type { Entity, EntityColor, LineStyleName, NewEntity } from './entity.js';
import { cloneEntity, entityBounds, hitTest } from './entity.js';
import { LayerTable, STANDARD_LAYERS, type Layer } from './layer.js';
import { SpatialIndex } from './spatial-index.js';
import type { LayoutSpace } from './layout.js';

/** 保存形式のバージョン。**破壊的変更のときだけ上げる。** */
export const FILE_FORMAT_VERSION = 1;

export interface DocumentJson {
  format: 'tr-cad2w';
  version: number;
  /** 線種尺度（AutoCAD の LTSCALE 相当）。新規図面は 500。 */
  lineTypeScale: number;
  layers: Layer[];
  entities: Entity[];
  /**
   * 用紙空間（レイアウト）。**省略可**。
   * 無いファイル（この機能より前に保存したもの）も読めるよう任意にしてある
   * ので、`FILE_FORMAT_VERSION` は上げていない。
   */
  layouts?: LayoutSpace[];
}

export const DEFAULT_LINETYPE_SCALE = 500;

/** Undo / Redo で積む状態。**モデル空間と用紙空間の両方**を持つ。 */
interface Snapshot {
  entities: Entity[];
  layouts: LayoutSpace[];
}

/** レイアウトの複製（図形と窓の参照を共有しない）。 */
export function cloneLayout(l: LayoutSpace): LayoutSpace {
  return {
    ...l,
    entities: l.entities.map(cloneEntity),
    viewports: l.viewports.map((v) => ({ ...v, paperRect: { ...v.paperRect }, center: { ...v.center } })),
  };
}

export class CadDocument {
  private entityList: Entity[] = [];
  private nextId = 1;
  private index: SpatialIndex = new SpatialIndex();
  private indexDirty = true;

  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private static readonly UNDO_LIMIT = 200;

  readonly selection = new Set<number>();
  layers = new LayerTable(STANDARD_LAYERS);
  lineTypeScale = DEFAULT_LINETYPE_SCALE;
  /**
   * 用紙空間（レイアウト）。**モデル空間とは線種尺度が別**（用紙側は 5）。
   * 同じ尺度だと A4 より長い破線になって実線に見えてしまう。
   */
  layouts: LayoutSpace[] = [];

  get entities(): readonly Entity[] {
    return this.entityList;
  }

  get count(): number {
    return this.entityList.length;
  }

  /**
   * 変更の直前に呼ぶ。ここで積んだ状態が Undo の戻り先になる。
   *
   * **モデル空間の図形だけでなく用紙空間（レイアウト）も一緒に積む。**
   * 別にすると、用紙空間での作図やビューポートの変更が Undo で戻らない。
   */
  beginEdit(): void {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > CadDocument.UNDO_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  private snapshot(): Snapshot {
    return {
      entities: this.entityList.map(cloneEntity),
      layouts: this.layouts.map(cloneLayout),
    };
  }

  private restore(s: Snapshot): void {
    this.entityList = s.entities;
    this.layouts = s.layouts;
    this.afterMutate();
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(this.snapshot());
    this.restore(prev);
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.snapshot());
    this.restore(next);
    return true;
  }

  /** 図形・ビューポートに使う次の id（**両者で重複させない**）。 */
  reserveId(): number {
    return this.nextId++;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** id を採番して追加する。`beginEdit()` は呼び出し側の責任。 */
  add(e: NewEntity): Entity {
    const created = { ...e, id: this.nextId++ } as Entity;
    this.entityList.push(created);
    this.indexDirty = true;
    return created;
  }

  addAll(list: readonly NewEntity[]): Entity[] {
    return list.map((e) => this.add(e));
  }

  get(id: number): Entity | undefined {
    return this.entityList.find((e) => e.id === id);
  }

  replace(e: Entity): void {
    const i = this.entityList.findIndex((x) => x.id === e.id);
    if (i < 0) return;
    this.entityList[i] = e;
    this.indexDirty = true;
  }

  remove(ids: Iterable<number>): number {
    const del = new Set(ids);
    if (del.size === 0) return 0;
    const before = this.entityList.length;
    this.entityList = this.entityList.filter((e) => !del.has(e.id));
    for (const id of del) this.selection.delete(id);
    this.indexDirty = true;
    return before - this.entityList.length;
  }

  /** 新規図面。**画層と線種尺度も既定へ戻す**（前の図面の設定を持ち越さない）。 */
  clear(): void {
    this.entityList = [];
    this.layouts = [];
    this.selection.clear();
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.nextId = 1;
    this.layers = new LayerTable(STANDARD_LAYERS);
    this.lineTypeScale = DEFAULT_LINETYPE_SCALE;
    this.afterMutate();
  }

  /** 重ね順: 最前面へ（後に描かれるものほど前面）。 */
  bringToFront(ids: Iterable<number>): void {
    const set = new Set(ids);
    const moved = this.entityList.filter((e) => set.has(e.id));
    this.entityList = [...this.entityList.filter((e) => !set.has(e.id)), ...moved];
    this.indexDirty = true;
  }

  /** 重ね順: 最背面へ。 */
  sendToBack(ids: Iterable<number>): void {
    const set = new Set(ids);
    const moved = this.entityList.filter((e) => set.has(e.id));
    this.entityList = [...moved, ...this.entityList.filter((e) => !set.has(e.id))];
    this.indexDirty = true;
  }

  /** 画面内（範囲内）の描画候補。表示 OFF の画層は外す。 */
  visibleIn(box: Aabb): Entity[] {
    const ids = new Set(this.spatialIndex().query(box));
    // 描画順（配列順）を保つため配列側を走査する
    return this.entityList.filter((e) => ids.has(e.id) && this.layers.isVisible(e.layer));
  }

  /** 点に当たる図形のうち最前面のもの。`tol` はワールド単位。 */
  pick(p: Vec2, tol: number): Entity | undefined {
    const box: Aabb = { minX: p.x - tol, minY: p.y - tol, maxX: p.x + tol, maxY: p.y + tol };
    const candidates = this.visibleIn(box);
    for (let i = candidates.length - 1; i >= 0; i--) {
      const e = candidates[i]!;
      if (hitTest(e, p, tol)) return e;
    }
    return undefined;
  }

  /**
   * 矩形選択。`crossing` が true なら交差選択（触れていれば選ぶ）、
   * false なら窓選択（完全に内側だけ）。
   */
  pickBox(box: Aabb, crossing: boolean): Entity[] {
    return this.visibleIn(box).filter((e) => {
      const b = entityBounds(e);
      if (crossing) return true; // visibleIn が既に重なり判定済み
      return b.minX >= box.minX && b.minY >= box.minY && b.maxX <= box.maxX && b.maxY <= box.maxY;
    });
  }

  /** 図面全体の外接矩形。空図面なら空の範囲。 */
  bounds(): Aabb {
    let box = EMPTY_AABB;
    for (const e of this.entityList) box = aabbUnion(box, entityBounds(e));
    return box;
  }

  /**
   * **印刷に出る範囲**（表示 ON の画層だけ）。
   *
   * `bounds()` は非表示の画層も含むので、印刷の尺度やページ数をそれで決めると
   * 刷られない図形にページを割いてしまう（白紙が混ざる・図面が小さく刷られる）。
   */
  printBounds(): Aabb {
    let box = EMPTY_AABB;
    for (const e of this.entityList) {
      if (this.layers.isVisible(e.layer)) box = aabbUnion(box, entityBounds(e));
    }
    return box;
  }

  selectedEntities(): Entity[] {
    return this.entityList.filter((e) => this.selection.has(e.id));
  }

  /** 選択図形へ属性を一括適用。`beginEdit()` は呼び出し側の責任。 */
  applyAttributes(attrs: {
    color?: EntityColor;
    layer?: string;
    lineStyle?: LineStyleName;
    lineWidth?: number;
  }): number {
    let n = 0;
    this.entityList = this.entityList.map((e) => {
      if (!this.selection.has(e.id)) return e;
      n++;
      return { ...e, ...attrs };
    });
    if (n > 0) this.indexDirty = true;
    return n;
  }

  spatialIndex(): SpatialIndex {
    if (this.indexDirty) {
      this.index.rebuild(this.entityList.map((e) => ({ id: e.id, bounds: entityBounds(e) })));
      this.indexDirty = false;
    }
    return this.index;
  }

  toJson(): DocumentJson {
    const json: DocumentJson = {
      format: 'tr-cad2w',
      version: FILE_FORMAT_VERSION,
      lineTypeScale: this.lineTypeScale,
      layers: this.layers.all(),
      entities: this.entityList.map(cloneEntity),
    };
    // レイアウトが無い図面には layouts を出さない（古い読み手を驚かせない）
    if (this.layouts.length > 0) json.layouts = this.layouts.map(cloneLayout);
    return json;
  }

  /**
   * JSON から読み直す（前の図面・選択・Undo はすべて捨てる）。
   *
   * **中身をすべて組み立ててから差し替える。** 途中で例外が出ても
   * いま開いている図面を壊さない（`clear()` を先に呼ぶと、壊れたファイルで
   * 図面が消える）。
   */
  loadJson(json: DocumentJson): void {
    if (json.format !== 'tr-cad2w') throw new Error('図面形式が違います（format が tr-cad2w ではありません）');
    if (json.version > FILE_FORMAT_VERSION) {
      throw new Error(`このファイルは新しい形式です（version ${json.version}）。アプリを更新してください`);
    }
    if (!Array.isArray(json.entities)) throw new Error('図面ファイルの内容が壊れています（entities がありません）');

    // ---- ここから下は例外が出ても現状を壊さない（ローカルに組み立てるだけ）
    const layerList = Array.isArray(json.layers) && json.layers.length > 0 ? json.layers : STANDARD_LAYERS;
    const layers = new LayerTable(layerList);
    const entities = json.entities.map(cloneEntity);
    const layouts = (json.layouts ?? []).map((l) => {
      if (!Array.isArray(l.entities) || !Array.isArray(l.viewports)) {
        throw new Error('図面ファイルの内容が壊れています（レイアウトが不正です）');
      }
      return cloneLayout(l);
    });
    const lineTypeScale =
      Number.isFinite(json.lineTypeScale) && json.lineTypeScale > 0 ? json.lineTypeScale : DEFAULT_LINETYPE_SCALE;

    // ---- ここから差し替え
    this.clear();
    this.layers = layers;
    this.lineTypeScale = lineTypeScale;
    this.entityList = entities;
    this.layouts = layouts;
    // id は用紙空間の図形・ビューポートとも重ならないよう、全体の最大から続ける
    const maxId = [
      ...this.entityList,
      ...this.layouts.flatMap((l) => l.entities),
      ...this.layouts.flatMap((l) => l.viewports),
    ].reduce((m, e) => Math.max(m, e.id), 0);
    this.nextId = maxId + 1;
    for (const e of this.entityList) this.layers.ensure(e.layer);
    for (const l of this.layouts) for (const e of l.entities) this.layers.ensure(e.layer);
    this.afterMutate();
  }

  private afterMutate(): void {
    this.indexDirty = true;
    for (const id of [...this.selection]) {
      if (!this.entityList.some((e) => e.id === id)) this.selection.delete(id);
    }
  }
}
