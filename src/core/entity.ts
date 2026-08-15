/**
 * 図形要素。
 *
 * 判別可能ユニオンで持ち、振る舞い（範囲・ヒットテスト・平行移動）は
 * この 1 ファイルの純関数に集める。**新しい図形を足すときはこのファイルの
 * すべての switch を埋める**（`kind` を網羅していないと型検査で落ちる）。
 */

import type { Aabb, Vec2 } from './geometry.js';
import { aabbFromCorners, aabbOf, add, dist, distToSegment, rotate, sub, vec } from './geometry.js';

/** 色。`null` は ByLayer（画層色に従う）。 */
export type EntityColor = string | null;

export type LineStyleName = 'solid' | 'dashed' | 'dotted' | 'dashdot' | 'center';

/** すべての図形が持つ属性。 */
export interface EntityBase {
  id: number;
  layer: string;
  color: EntityColor;
  lineStyle: LineStyleName;
  /** 線幅（mm）。0 は極細（常に 1px）。 */
  lineWidth: number;
  /**
   * ブロック挿入を展開して作った図形の印（デスクトップ版 `FromBlock` 相当）。
   * **測点の取得対象から外す**ために後で使う。省略＝素の図形。
   */
  fromBlock?: boolean;
}

export interface LineEntity extends EntityBase {
  kind: 'line';
  a: Vec2;
  b: Vec2;
}

export interface RectEntity extends EntityBase {
  kind: 'rect';
  a: Vec2;
  b: Vec2;
}

export interface CircleEntity extends EntityBase {
  kind: 'circle';
  center: Vec2;
  radius: number;
}

/** 円弧。start→end は常に反時計回り（DXF ARC と同じ約束）。角度はラジアン。 */
export interface ArcEntity extends EntityBase {
  kind: 'arc';
  center: Vec2;
  radius: number;
  startAngle: number;
  endAngle: number;
}

export interface PolylineEntity extends EntityBase {
  kind: 'polyline';
  points: Vec2[];
  closed: boolean;
}

export interface PointEntity extends EntityBase {
  kind: 'point';
  at: Vec2;
}

export interface TextEntity extends EntityBase {
  kind: 'text';
  at: Vec2;
  /** 改行を含む複数行テキスト。 */
  text: string;
  /** 文字高（mm）。 */
  height: number;
  /** 回転角（ラジアン、反時計回り）。 */
  rotation: number;
  hAlign: 'left' | 'center' | 'right';
  vAlign: 'baseline' | 'top' | 'middle' | 'bottom';
}

export type HatchPattern = 'solid' | 'line45' | 'line135' | 'cross' | 'grid';

/**
 * ハッチング（塗り）。**境界の点列だけを持ち、線分は `hatch.ts` が毎回作る。**
 * 点列は閉じているとみなす（最後の点と最初の点を結ぶ）。
 */
export interface HatchEntity extends EntityBase {
  kind: 'hatch';
  points: Vec2[];
  pattern: HatchPattern;
  /** パターン間隔（mm）。 */
  spacing: number;
}

/**
 * ブロック挿入。**中身は図面のブロック定義（`CadDocument.blocks`）が持ち、
 * ここは「どのブロックを・どこへ・どれだけ拡縮して・どれだけ回して置くか」だけ。**
 */
export interface InsertEntity extends EntityBase {
  kind: 'insert';
  blockName: string;
  at: Vec2;
  /** X 倍率。 */
  scale: number;
  /** Y 倍率。**0 は X と同じ**（等倍）。デスクトップ版と同じ約束。 */
  scaleY: number;
  /** 回転（ラジアン、反時計回り）。 */
  rotation: number;
}

/**
 * ラスタ画像。**バイト列を図面に埋め込んで自己完結させる**（外部ファイルに頼らない）。
 * 配置は矩形の対角 2 点で決める。
 */
export interface ImageEntity extends EntityBase {
  kind: 'image';
  a: Vec2;
  b: Vec2;
  /** 画像の中身。`data:image/png;base64,...` の形。 */
  dataUrl: string;
  /** 不透明度 0..1。 */
  opacity: number;
}

export type Entity =
  | LineEntity
  | RectEntity
  | CircleEntity
  | ArcEntity
  | PolylineEntity
  | PointEntity
  | TextEntity
  | HatchEntity
  | InsertEntity
  | ImageEntity;

export type EntityKind = Entity['kind'];

/**
 * id を採番する前の図形。
 *
 * `Omit<Entity, 'id'>` と書くとユニオンに分配されず共通プロパティだけの型に
 * 潰れてしまう（`kind: 'line'` なのに `a` を渡せない）。分配して Omit する。
 */
export type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

export type NewEntity = DistributiveOmit<Entity, 'id'>;

export const DEFAULT_ATTRS: Omit<EntityBase, 'id'> = {
  layer: '0',
  color: null,
  lineStyle: 'solid',
  lineWidth: 0,
};

/** ハッチの既定値。 */
export const DEFAULT_HATCH_STYLE = {
  pattern: 'line45' as HatchPattern,
  /** mm。図面の縮尺に合わせて調整する。 */
  spacing: 200,
};

/** 図形の複製。参照を共有しない（Undo のスナップショットとコピペで使う）。 */
export function cloneEntity(e: Entity): Entity {
  switch (e.kind) {
    case 'polyline':
      return { ...e, points: e.points.map((p) => vec(p.x, p.y)) };
    case 'hatch':
      // 配列を共有すると Undo で戻らず、コピーの境界を動かすと元も動く
      return { ...e, points: e.points.map((p) => vec(p.x, p.y)) };
    default:
      // Vec2 は読み取り専用なので浅いコピーで足りる
      return { ...e };
  }
}

/** 文字の行送り（文字高の倍数）。 */
export const TEXT_LINE_GAP = 1.3;

/** 図形の外接矩形（ワールド）。 */
export function entityBounds(e: Entity): Aabb {
  switch (e.kind) {
    case 'line':
      return aabbFromCorners(e.a, e.b);
    case 'rect':
      return aabbFromCorners(e.a, e.b);
    case 'circle':
      return {
        minX: e.center.x - e.radius,
        minY: e.center.y - e.radius,
        maxX: e.center.x + e.radius,
        maxY: e.center.y + e.radius,
      };
    case 'arc':
      return aabbOf(arcExtremePoints(e));
    case 'polyline':
      return aabbOf(e.points);
    case 'point':
      return aabbFromCorners(e.at, e.at);
    case 'text':
      return aabbOf(textCorners(e));
    case 'hatch':
      return aabbOf(e.points);
    case 'image':
      return aabbFromCorners(e.a, e.b);
    case 'insert':
      // 中身はブロック定義にあり、ここからは見えない。挿入点だけを返す
      // （実際の広がりは `CadDocument` が展開して求める）
      return aabbFromCorners(e.at, e.at);
  }
}

/**
 * 文字の外接矩形の 4 隅。字送りの実測はブラウザに聞かないと分からないので、
 * ここでは 1 文字あたり 0.6em の概算で持つ（ヒットテストと全体表示の用）。
 */
export function textCorners(e: TextEntity): Vec2[] {
  const lines = e.text.split('\n');
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
  const w = longest * e.height * 0.6;
  const h = e.height + (lines.length - 1) * e.height * TEXT_LINE_GAP;

  const left = e.hAlign === 'center' ? -w / 2 : e.hAlign === 'right' ? -w : 0;
  const bottom =
    e.vAlign === 'top' ? -h : e.vAlign === 'middle' ? -h / 2 : e.vAlign === 'bottom' ? 0 : -h + e.height * 0.8;

  const local: Vec2[] = [
    vec(left, bottom),
    vec(left + w, bottom),
    vec(left + w, bottom + h),
    vec(left, bottom + h),
  ];
  return local.map((p) => add(e.at, rotate(p, e.rotation)));
}

function arcExtremePoints(e: ArcEntity): Vec2[] {
  const pts: Vec2[] = [angleToPoint(e.center, e.radius, e.startAngle), angleToPoint(e.center, e.radius, e.endAngle)];
  // 弧に含まれる軸方向（0/90/180/270°）の点だけを足す
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    if (arcContainsAngle(e, a)) pts.push(angleToPoint(e.center, e.radius, a));
  }
  return pts;
}

export function angleToPoint(center: Vec2, radius: number, ang: number): Vec2 {
  return vec(center.x + radius * Math.cos(ang), center.y + radius * Math.sin(ang));
}

/** 角度 ang（ラジアン）が弧の内側か。start→end は反時計回り。 */
export function arcContainsAngle(e: ArcEntity, ang: number): boolean {
  const sweep = norm2pi(e.endAngle - e.startAngle);
  const t = norm2pi(ang - e.startAngle);
  return t <= (sweep === 0 ? Math.PI * 2 : sweep);
}

function norm2pi(a: number): number {
  const t = a % (Math.PI * 2);
  return t < 0 ? t + Math.PI * 2 : t;
}

/**
 * 点が図形に当たっているか。`tol` はワールド単位の許容値
 * （呼び出し側が `view.toWorldLen(6)` のように画面 px から換算して渡す）。
 */
export function hitTest(e: Entity, p: Vec2, tol: number): boolean {
  switch (e.kind) {
    case 'line':
      return distToSegment(p, e.a, e.b) <= tol;
    case 'rect': {
      const c = rectCorners(e);
      return polylineHit(c, true, p, tol);
    }
    case 'circle':
      return Math.abs(dist(p, e.center) - e.radius) <= tol;
    case 'arc': {
      if (Math.abs(dist(p, e.center) - e.radius) > tol) return false;
      const ang = Math.atan2(p.y - e.center.y, p.x - e.center.x);
      return arcContainsAngle(e, ang);
    }
    case 'polyline':
      return polylineHit(e.points, e.closed, p, tol);
    case 'point':
      return dist(p, e.at) <= tol;
    case 'text': {
      const c = textCorners(e);
      return polylineHit(c, true, p, tol) || pointInPolygon(c, p);
    }
    case 'hatch':
      // 塗った内側のどこを押しても掴める（境界線だけだと選びにくい）
      return pointInPolygon(e.points, p) || polylineHit(e.points, true, p, tol);
    case 'image': {
      const c = rectCorners({ ...e, kind: 'rect' });
      return pointInPolygon(c, p) || polylineHit(c, true, p, tol);
    }
    case 'insert':
      // 中身を知らないので挿入点のまわりだけ。展開後の当たり判定は呼び出し側
      return dist(p, e.at) <= tol;
  }
}

export function rectCorners(e: RectEntity): Vec2[] {
  return [vec(e.a.x, e.a.y), vec(e.b.x, e.a.y), vec(e.b.x, e.b.y), vec(e.a.x, e.b.y)];
}

function polylineHit(points: readonly Vec2[], closed: boolean, p: Vec2, tol: number): boolean {
  if (points.length === 0) return false;
  if (points.length === 1) return dist(p, points[0]!) <= tol;
  for (let i = 0; i + 1 < points.length; i++) {
    if (distToSegment(p, points[i]!, points[i + 1]!) <= tol) return true;
  }
  if (closed && points.length > 2) {
    return distToSegment(p, points[points.length - 1]!, points[0]!) <= tol;
  }
  return false;
}

export function pointInPolygon(poly: readonly Vec2[], p: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** 図形を平行移動した複製を返す。 */
export function translateEntity(e: Entity, d: Vec2): Entity {
  switch (e.kind) {
    case 'line':
      return { ...e, a: add(e.a, d), b: add(e.b, d) };
    case 'rect':
      return { ...e, a: add(e.a, d), b: add(e.b, d) };
    case 'circle':
      return { ...e, center: add(e.center, d) };
    case 'arc':
      return { ...e, center: add(e.center, d) };
    case 'polyline':
      return { ...e, points: e.points.map((p) => add(p, d)) };
    case 'point':
      return { ...e, at: add(e.at, d) };
    case 'text':
      return { ...e, at: add(e.at, d) };
    case 'hatch':
      return { ...e, points: e.points.map((p) => add(p, d)) };
    case 'image':
      return { ...e, a: add(e.a, d), b: add(e.b, d) };
    case 'insert':
      return { ...e, at: add(e.at, d) };
  }
}

/** 図形を c まわりに ang（ラジアン）回した複製を返す。 */
export function rotateEntity(e: Entity, c: Vec2, ang: number): Entity {
  switch (e.kind) {
    case 'line':
      return { ...e, a: rotate(e.a, ang, c), b: rotate(e.b, ang, c) };
    case 'rect': {
      // 回した矩形は矩形でなくなるので閉じたポリラインへ変える
      const pts = rectCorners(e).map((p) => rotate(p, ang, c));
      const { kind: _kind, a: _a, b: _b, ...attrs } = e;
      return { ...attrs, kind: 'polyline', points: pts, closed: true };
    }
    case 'circle':
      return { ...e, center: rotate(e.center, ang, c) };
    case 'arc':
      return {
        ...e,
        center: rotate(e.center, ang, c),
        startAngle: e.startAngle + ang,
        endAngle: e.endAngle + ang,
      };
    case 'polyline':
      return { ...e, points: e.points.map((p) => rotate(p, ang, c)) };
    case 'point':
      return { ...e, at: rotate(e.at, ang, c) };
    case 'text':
      return { ...e, at: rotate(e.at, ang, c), rotation: e.rotation + ang };
    case 'hatch':
      return { ...e, points: e.points.map((p) => rotate(p, ang, c)) };
    case 'image': {
      // 回した矩形は軸平行でなくなる。**画像は軸平行のまま**、外接矩形へ収める
      const corners = rectCorners({ ...e, kind: 'rect' }).map((p) => rotate(p, ang, c));
      const b = aabbOf(corners);
      return { ...e, a: vec(b.minX, b.minY), b: vec(b.maxX, b.maxY) };
    }
    case 'insert':
      return { ...e, at: rotate(e.at, ang, c), rotation: e.rotation + ang };
  }
}

/** 図形を c 基準に k 倍した複製を返す。 */
export function scaleEntity(e: Entity, c: Vec2, k: number): Entity {
  const s = (p: Vec2): Vec2 => add(c, { x: (p.x - c.x) * k, y: (p.y - c.y) * k });
  switch (e.kind) {
    case 'line':
      return { ...e, a: s(e.a), b: s(e.b) };
    case 'rect':
      return { ...e, a: s(e.a), b: s(e.b) };
    case 'circle':
      return { ...e, center: s(e.center), radius: e.radius * Math.abs(k) };
    case 'arc':
      return { ...e, center: s(e.center), radius: e.radius * Math.abs(k) };
    case 'polyline':
      return { ...e, points: e.points.map(s) };
    case 'point':
      return { ...e, at: s(e.at) };
    case 'text':
      return { ...e, at: s(e.at), height: e.height * Math.abs(k) };
    case 'hatch':
      // 間隔も一緒に拡縮する（塗りの見た目を保つ）
      return { ...e, points: e.points.map(s), spacing: e.spacing * Math.abs(k) };
    case 'image':
      return { ...e, a: s(e.a), b: s(e.b) };
    case 'insert':
      return {
        ...e,
        at: s(e.at),
        scale: e.scale * Math.abs(k),
        // 0 は「X と同じ」の意味なので 0 のまま保つ
        scaleY: e.scaleY === 0 ? 0 : e.scaleY * Math.abs(k),
      };
  }
}

/** スナップ候補になる特徴点（端点・中心・頂点など）。 */
export function snapPoints(e: Entity): { kind: 'end' | 'mid' | 'center' | 'node'; at: Vec2 }[] {
  const out: { kind: 'end' | 'mid' | 'center' | 'node'; at: Vec2 }[] = [];
  const seg = (a: Vec2, b: Vec2): void => {
    out.push(
      { kind: 'end', at: a },
      { kind: 'end', at: b },
      { kind: 'mid', at: vec((a.x + b.x) / 2, (a.y + b.y) / 2) },
    );
  };

  switch (e.kind) {
    case 'line':
      seg(e.a, e.b);
      break;
    case 'rect': {
      const c = rectCorners(e);
      for (let i = 0; i < c.length; i++) seg(c[i]!, c[(i + 1) % c.length]!);
      break;
    }
    case 'circle':
      out.push({ kind: 'center', at: e.center });
      for (let k = 0; k < 4; k++) {
        out.push({ kind: 'end', at: angleToPoint(e.center, e.radius, (k * Math.PI) / 2) });
      }
      break;
    case 'arc':
      out.push(
        { kind: 'center', at: e.center },
        { kind: 'end', at: angleToPoint(e.center, e.radius, e.startAngle) },
        { kind: 'end', at: angleToPoint(e.center, e.radius, e.endAngle) },
        {
          kind: 'mid',
          at: angleToPoint(e.center, e.radius, e.startAngle + norm2pi(e.endAngle - e.startAngle) / 2),
        },
      );
      break;
    case 'polyline': {
      const n = e.points.length;
      for (let i = 0; i + 1 < n; i++) seg(e.points[i]!, e.points[i + 1]!);
      if (e.closed && n > 2) seg(e.points[n - 1]!, e.points[0]!);
      break;
    }
    case 'point':
      out.push({ kind: 'node', at: e.at });
      break;
    case 'text':
      out.push({ kind: 'node', at: e.at });
      break;
    case 'hatch': {
      const n = e.points.length;
      for (let i = 0; i < n; i++) seg(e.points[i]!, e.points[(i + 1) % n]!);
      break;
    }
    case 'image': {
      const c = rectCorners({ ...e, kind: 'rect' });
      for (let i = 0; i < c.length; i++) seg(c[i]!, c[(i + 1) % c.length]!);
      break;
    }
    case 'insert':
      out.push({ kind: 'node', at: e.at });
      break;
  }
  return out;
}

/** 図形を折れ線群へ展開する（描画・交点計算・出力の共通土台）。円弧は近似。 */
export function flatten(e: Entity, segmentsPerCircle = 64): Vec2[][] {
  switch (e.kind) {
    case 'line':
      return [[e.a, e.b]];
    case 'rect': {
      const c = rectCorners(e);
      return [[...c, c[0]!]];
    }
    case 'circle': {
      const pts: Vec2[] = [];
      for (let i = 0; i <= segmentsPerCircle; i++) {
        pts.push(angleToPoint(e.center, e.radius, (i / segmentsPerCircle) * Math.PI * 2));
      }
      return [pts];
    }
    case 'arc': {
      const sweep = norm2pi(e.endAngle - e.startAngle) || Math.PI * 2;
      const n = Math.max(2, Math.ceil((sweep / (Math.PI * 2)) * segmentsPerCircle));
      const pts: Vec2[] = [];
      for (let i = 0; i <= n; i++) pts.push(angleToPoint(e.center, e.radius, e.startAngle + (sweep * i) / n));
      return [pts];
    }
    case 'polyline': {
      if (e.points.length < 2) return [];
      return [e.closed ? [...e.points, e.points[0]!] : [...e.points]];
    }
    case 'point':
      return [];
    case 'text':
      return [];
    case 'hatch': {
      if (e.points.length < 3) return [];
      // 境界だけを返す（塗りの線分は `hatch.ts` の持ち分）
      return [[...e.points, e.points[0]!]];
    }
    case 'image': {
      const c = rectCorners({ ...e, kind: 'rect' });
      return [[...c, c[0]!]];
    }
    case 'insert':
      // 中身はブロック定義にある。展開は `block.ts`
      return [];
  }
}

/** 選択の当たり判定に使う「見た目の中心」。情報表示や基点の初期値に使う。 */
export function entityAnchor(e: Entity): Vec2 {
  switch (e.kind) {
    case 'line':
      return vec((e.a.x + e.b.x) / 2, (e.a.y + e.b.y) / 2);
    case 'rect':
      return vec((e.a.x + e.b.x) / 2, (e.a.y + e.b.y) / 2);
    case 'circle':
    case 'arc':
      return e.center;
    case 'polyline':
    case 'hatch':
    case 'image': {
      const b = entityBounds(e);
      return vec((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
    }
    case 'point':
    case 'text':
    case 'insert':
      return e.at;
  }
}

/** 図形の長さ（線状のもののみ。面や文字は 0）。 */
export function entityLength(e: Entity): number {
  switch (e.kind) {
    case 'circle':
      return 2 * Math.PI * e.radius;
    case 'arc':
      return e.radius * (norm2pi(e.endAngle - e.startAngle) || Math.PI * 2);
    case 'point':
    case 'text':
      return 0;
    default: {
      let total = 0;
      for (const path of flatten(e)) {
        for (let i = 0; i + 1 < path.length; i++) total += dist(path[i]!, path[i + 1]!);
      }
      return total;
    }
  }
}

/** 閉じた図形の面積（符号なし）。開いた図形は 0。 */
export function entityArea(e: Entity): number {
  switch (e.kind) {
    case 'circle':
      return Math.PI * e.radius * e.radius;
    case 'rect':
      return Math.abs((e.b.x - e.a.x) * (e.b.y - e.a.y));
    case 'polyline': {
      if (!e.closed || e.points.length < 3) return 0;
      let s = 0;
      for (let i = 0; i < e.points.length; i++) {
        const a = e.points[i]!;
        const b = e.points[(i + 1) % e.points.length]!;
        s += a.x * b.y - b.x * a.y;
      }
      return Math.abs(s) / 2;
    }
    default:
      return 0;
  }
}

/** 2 点間の方向（ワールド）。ラジアン。 */
export function angleOf(a: Vec2, b: Vec2): number {
  const d = sub(b, a);
  return Math.atan2(d.y, d.x);
}
