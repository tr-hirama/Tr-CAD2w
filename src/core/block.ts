/**
 * ブロック挿入の展開。
 *
 * デスクトップ版 TrCad2D の `BlockEngine.cs` の移植。挿入点・倍率・回転を
 * 合成して、ブロック定義の中身をワールド座標の実体図形に変換する。
 *
 * - **入れ子（ブロックの中の挿入）も再帰的に展開する**
 * - **循環参照は展開中のブロック名の連鎖で見つけて打ち切る**（無限再帰を防ぐ）
 * - 展開して作った図形には `fromBlock` の印を付ける（測点の取得から外すため）
 */

import type { Vec2 } from './geometry.js';
import { vec } from './geometry.js';
import type { Entity, InsertEntity } from './entity.js';
import { cloneEntity } from './entity.js';

/** ブロック定義（名前と中身）。中身の座標は**ブロック内のローカル座標**。 */
export interface BlockDef {
  name: string;
  entities: Entity[];
}

/** 入れ子の深さの上限。これを超えたら展開を打ち切る。 */
export const MAX_BLOCK_DEPTH = 16;

export interface BlockSource {
  /** 名前からブロック定義を引く。無ければ `undefined`。 */
  getBlock(name: string): BlockDef | undefined;
}

/**
 * 挿入 1 件をワールド座標の図形列へ展開する。
 * 定義が無い・循環している場合は空を返す（例外にしない）。
 */
export function explodeInsert(src: BlockSource, insert: InsertEntity): Entity[] {
  return explode(src, insert, new Set<string>(), 0);
}

function explode(src: BlockSource, insert: InsertEntity, chain: Set<string>, depth: number): Entity[] {
  if (depth >= MAX_BLOCK_DEPTH) return [];
  const blk = src.getBlock(insert.blockName);
  if (!blk) return [];
  // 展開中の連鎖に同じ名前が再登場したら、その枝は展開しない
  if (chain.has(insert.blockName)) return [];
  const nextChain = new Set(chain).add(insert.blockName);

  const sx = insert.scale === 0 ? 1 : insert.scale;
  const sy = insert.scaleY === 0 ? sx : insert.scaleY; // 0 は X と同じ（等倍）
  const cos = Math.cos(insert.rotation);
  const sin = Math.sin(insert.rotation);
  const at = insert.at;

  const tr = (p: Vec2): Vec2 => {
    const x = p.x * sx;
    const y = p.y * sy;
    return vec(at.x + x * cos - y * sin, at.y + x * sin + y * cos);
  };

  const out: Entity[] = [];
  for (const e of blk.entities) {
    if (e.kind === 'insert') {
      // 入れ子: 内側の挿入へ外側の変換を合成してから展開する
      const inner: InsertEntity = {
        ...e,
        at: tr(e.at),
        scale: (e.scale === 0 ? 1 : e.scale) * sx,
        scaleY: e.scaleY === 0 ? 0 : e.scaleY * sy,
        rotation: e.rotation + insert.rotation,
      };
      for (const x of explode(src, inner, nextChain, depth + 1)) out.push(x);
      continue;
    }
    out.push(applyTransform(e, tr, sx, insert.rotation));
  }
  return out;
}

/**
 * 図形 1 つに挿入の変換を効かせる。
 *
 * **点だけを動かすと、円・弧・文字は大きさと向きが取り残される**ので、
 * 半径・文字高・角度は別に効かせる（デスクトップ版 `BlockEngine.Apply` と同じ）。
 * 非等倍は楕円になるが、円は X 倍率で丸いまま拡縮する（デスクトップ版と同じ割り切り）。
 */
function applyTransform(src: Entity, tr: (p: Vec2) => Vec2, sx: number, rot: number): Entity {
  const e = cloneEntity(src);
  const marked = { ...e, fromBlock: true } as Entity;
  switch (marked.kind) {
    case 'line':
      return { ...marked, a: tr(marked.a), b: tr(marked.b) };
    case 'rect': {
      // 回すと矩形でなくなるので、回転があるときは閉じた連続線にする
      const c = [
        vec(marked.a.x, marked.a.y),
        vec(marked.b.x, marked.a.y),
        vec(marked.b.x, marked.b.y),
        vec(marked.a.x, marked.b.y),
      ].map(tr);
      if (Math.abs(Math.sin(rot)) < 1e-12) {
        return { ...marked, a: c[0]!, b: c[2]! };
      }
      const { kind: _k, a: _a, b: _b, ...attrs } = marked;
      return { ...attrs, kind: 'polyline', points: c, closed: true };
    }
    case 'circle':
      return { ...marked, center: tr(marked.center), radius: marked.radius * Math.abs(sx) };
    case 'arc':
      return {
        ...marked,
        center: tr(marked.center),
        radius: marked.radius * Math.abs(sx),
        startAngle: marked.startAngle + rot,
        endAngle: marked.endAngle + rot,
      };
    case 'polyline':
      return { ...marked, points: marked.points.map(tr) };
    case 'point':
      return { ...marked, at: tr(marked.at) };
    case 'text':
      return { ...marked, at: tr(marked.at), height: marked.height * Math.abs(sx), rotation: marked.rotation + rot };
    case 'hatch':
      return { ...marked, points: marked.points.map(tr), spacing: marked.spacing * Math.abs(sx) };
    case 'image': {
      const c = [vec(marked.a.x, marked.a.y), vec(marked.b.x, marked.b.y)].map(tr);
      return { ...marked, a: c[0]!, b: c[1]! };
    }
    case 'insert':
      // 呼び出し側で先に処理している（ここへは来ない）
      return marked;
  }
}

/** ブロック定義を作る。中身は複製して持つ（元の図面を変えても影響しない）。 */
export function makeBlock(name: string, entities: readonly Entity[]): BlockDef {
  return { name, entities: entities.map(cloneEntity) };
}
