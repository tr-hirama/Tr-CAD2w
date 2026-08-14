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

/** 保存形式のバージョン。**破壊的変更のときだけ上げる。** */
export const FILE_FORMAT_VERSION = 1;

export interface DocumentJson {
  format: 'tr-cad2w';
  version: number;
  /** 線種尺度（AutoCAD の LTSCALE 相当）。新規図面は 500。 */
  lineTypeScale: number;
  layers: Layer[];
  entities: Entity[];
}

export const DEFAULT_LINETYPE_SCALE = 500;

export class CadDocument {
  private entityList: Entity[] = [];
  private nextId = 1;
  private index: SpatialIndex = new SpatialIndex();
  private indexDirty = true;

  private undoStack: Entity[][] = [];
  private redoStack: Entity[][] = [];
  private static readonly UNDO_LIMIT = 200;

  readonly selection = new Set<number>();
  layers = new LayerTable(STANDARD_LAYERS);
  lineTypeScale = DEFAULT_LINETYPE_SCALE;

  get entities(): readonly Entity[] {
    return this.entityList;
  }

  get count(): number {
    return this.entityList.length;
  }

  /** 変更の直前に呼ぶ。ここで積んだ状態が Undo の戻り先になる。 */
  beginEdit(): void {
    this.undoStack.push(this.entityList.map(cloneEntity));
    if (this.undoStack.length > CadDocument.UNDO_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(this.entityList.map(cloneEntity));
    this.entityList = prev;
    this.afterMutate();
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.entityList.map(cloneEntity));
    this.entityList = next;
    this.afterMutate();
    return true;
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

  clear(): void {
    this.entityList = [];
    this.selection.clear();
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.nextId = 1;
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
    return {
      format: 'tr-cad2w',
      version: FILE_FORMAT_VERSION,
      lineTypeScale: this.lineTypeScale,
      layers: this.layers.all(),
      entities: this.entityList.map(cloneEntity),
    };
  }

  /** JSON から読み直す（前の図面・選択・Undo はすべて捨てる）。 */
  loadJson(json: DocumentJson): void {
    if (json.format !== 'tr-cad2w') throw new Error('図面形式が違います（format が tr-cad2w ではありません）');
    if (json.version > FILE_FORMAT_VERSION) {
      throw new Error(`このファイルは新しい形式です（version ${json.version}）。アプリを更新してください`);
    }
    this.clear();
    this.layers = new LayerTable(json.layers.length > 0 ? json.layers : STANDARD_LAYERS);
    this.lineTypeScale = json.lineTypeScale > 0 ? json.lineTypeScale : DEFAULT_LINETYPE_SCALE;
    this.entityList = json.entities.map(cloneEntity);
    this.nextId = this.entityList.reduce((m, e) => Math.max(m, e.id), 0) + 1;
    for (const e of this.entityList) this.layers.ensure(e.layer);
    this.afterMutate();
  }

  private afterMutate(): void {
    this.indexDirty = true;
    for (const id of [...this.selection]) {
      if (!this.entityList.some((e) => e.id === id)) this.selection.delete(id);
    }
  }
}
