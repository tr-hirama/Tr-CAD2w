/**
 * 2次元ベクトルと基本幾何。ワールド座標は Y 上向き（数学と同じ向き）。
 * 画面は Y 下向きなので、変換は CadView が一手に引き受ける（ここでは扱わない）。
 */

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export function vec(x: number, y: number): Vec2 {
  return { x, y };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function mul(a: Vec2, k: number): Vec2 {
  return { x: a.x * k, y: a.y * k };
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

export function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x;
}

export function len(a: Vec2): number {
  return Math.hypot(a.x, a.y);
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function mid(a: Vec2, b: Vec2): Vec2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function normalize(a: Vec2): Vec2 {
  const l = len(a);
  return l === 0 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

/** a を原点 c まわりに ang（ラジアン、反時計回り）回す。 */
export function rotate(a: Vec2, ang: number, c: Vec2 = { x: 0, y: 0 }): Vec2 {
  const s = Math.sin(ang);
  const co = Math.cos(ang);
  const dx = a.x - c.x;
  const dy = a.y - c.y;
  return { x: c.x + dx * co - dy * s, y: c.y + dx * s + dy * co };
}

export function deg(rad: number): number {
  return (rad * 180) / Math.PI;
}

export function rad(degree: number): number {
  return (degree * Math.PI) / 180;
}

/** 点 p から線分 ab への最短距離。 */
export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  return dist(p, closestOnSegment(p, a, b));
}

/** 線分 ab 上で点 p に最も近い点。 */
export function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 === 0) return a;
  const t = Math.min(1, Math.max(0, dot(sub(p, a), ab) / l2));
  return add(a, mul(ab, t));
}

/** 軸平行な矩形（ワールド座標。min ≦ max を保証して作る）。 */
export interface Aabb {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export function aabbOf(points: readonly Vec2[]): Aabb {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function aabbFromCorners(a: Vec2, b: Vec2): Aabb {
  return {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y),
  };
}

export function aabbUnion(a: Aabb, b: Aabb): Aabb {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

export function aabbExpand(a: Aabb, m: number): Aabb {
  return { minX: a.minX - m, minY: a.minY - m, maxX: a.maxX + m, maxY: a.maxY + m };
}

export function aabbIntersects(a: Aabb, b: Aabb): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

export function aabbContainsAabb(outer: Aabb, inner: Aabb): boolean {
  return (
    outer.minX <= inner.minX &&
    outer.minY <= inner.minY &&
    outer.maxX >= inner.maxX &&
    outer.maxY >= inner.maxY
  );
}

export function aabbContainsPoint(a: Aabb, p: Vec2): boolean {
  return p.x >= a.minX && p.x <= a.maxX && p.y >= a.minY && p.y <= a.maxY;
}

export function aabbIsEmpty(a: Aabb): boolean {
  return !(a.minX <= a.maxX && a.minY <= a.maxY);
}

export const EMPTY_AABB: Aabb = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
