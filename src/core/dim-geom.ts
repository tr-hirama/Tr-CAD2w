/**
 * 寸法（`dim`）の幾何生成。
 *
 * デスクトップ版 TrCad2D の `DimGeom.cs` の移植。**種類ごとに `points` の意味が
 * 変わる**（同じ配列を使い回すのはデスクトップ版と `.tc2` の `Pts` に合わせるため）:
 *
 * | 種類 | `points` | 値 |
 * |---|---|---|
 * | `linear` | `[0],[1]`=計測2点、`[2]`=寸法線が通る点 | 2 点間の実距離 |
 * | `radius` | `[0]`=中心、`[1]`=円周上の点 | 半径（接頭 `R`） |
 * | `diameter` | 同上 | 直径（接頭 `Ø`） |
 * | `angular` | `[0]`=頂点、`[1]`=辺1上の点、`[2]`=辺2上の点、`[3]`=弧の通過点（任意） | なす角（接尾 `°`） |
 *
 * 描画・ヒットテスト・DXF 分解でこの 1 ファイルを共用する。
 * **角度はラジアン**（デスクトップ版は度。Web 版は `arc` や `text` と揃える）。
 */

import type { Vec2 } from './geometry.js';
import { add, len, mul, sub, vec } from './geometry.js';
import type { DimEntity, NewEntity } from './entity.js';

export interface DimGeometry {
  /** 引出線・寸法線（角度は弧を線分近似したもの）。 */
  lines: [Vec2, Vec2][];
  /** 矢印（三角形の 3 頂点）。 */
  arrows: Vec2[][];
  /** 表示する寸法値。 */
  text: string;
  textPos: Vec2;
  /** 文字の回転（ラジアン、反時計回り）。 */
  textAngle: number;
  /** 文字高（mm）。`height` が 0 のときは種類ごとの自動値。 */
  textHeight: number;
}

/** 寸法の幾何。点が足りない・退化しているときは `null`。 */
export function dimGeometry(e: DimEntity): DimGeometry | null {
  switch (e.dimType) {
    case 'radius':
      return radial(e, false);
    case 'diameter':
      return radial(e, true);
    case 'angular':
      return angular(e);
    default:
      return linear(e);
  }
}

/**
 * 寸法値の文字列。
 *
 * `text` が空なら「接頭＋計測値＋接尾」、空でなければ手動上書きで、
 * その中の `<>` を計測値に置き換える（`約<>cm` のように書ける）。
 */
export function resolveDimText(e: DimEntity, value: number, prefix: string, suffix: string): string {
  const dec = Math.min(8, Math.max(0, Math.round(e.decimals)));
  const num = value.toFixed(dec);
  if (e.text === '') return prefix + num + suffix;
  return e.text.split('<>').join(num);
}

/** 文字高。0 は「種類ごとの自動値」。 */
function heightOf(e: DimEntity, fallback: number): number {
  return e.height > 0 ? e.height : Math.max(fallback, 1e-6);
}

/** 矢印の長さ。0 は文字高の 1.2 倍。 */
function arrowLenOf(e: DimEntity, h: number): number {
  return e.arrow > 0 ? e.arrow : h * 1.2;
}

/** 先端 `tip` から `into` 向きに伸びる三角形。`nrm` は幅方向。 */
function arrowTriangle(tip: Vec2, into: Vec2, nrm: Vec2, aLen: number, aWidth: number): Vec2[] {
  const b = add(tip, mul(into, aLen));
  return [tip, add(b, mul(nrm, aWidth / 2)), sub(b, mul(nrm, aWidth / 2))];
}

/**
 * 文字が上下逆さにならないよう、角度を (-90°, 90°] に折り返す。
 *
 * デスクトップ版は 1 回だけ 180° を足すので、真横（180°）が 360° になる。
 * 見た目は同じだが値として扱いにくいので、こちらは範囲へ収める。
 */
function uprightAngle(ang: number): number {
  const half = Math.PI / 2;
  let a = ang;
  while (a > half) a -= Math.PI;
  while (a <= -half) a += Math.PI;
  return a;
}

/** 計測値に掛ける倍率（0 は 1 とみなす）。 */
function measureScaleOf(e: DimEntity): number {
  return e.measureScale === 0 ? 1 : e.measureScale;
}

// ---- 直線寸法 -------------------------------------------------------------

function linear(e: DimEntity): DimGeometry | null {
  if (e.points.length < 3) return null;
  const p1 = e.points[0]!;
  const p2 = e.points[1]!;
  const pp = e.points[2]!;
  const dv = sub(p2, p1);
  const length = len(dv);
  if (length < 1e-9) return null;

  const dir = mul(dv, 1 / length);
  const nrm = vec(-dir.y, dir.x);
  // 寸法線位置は「計測線からの垂直距離」で表す（3 点目のどこを押しても同じ寸法になる）
  const off = (pp.x - p1.x) * nrm.x + (pp.y - p1.y) * nrm.y;
  const sgn = off >= 0 ? 1 : -1;
  const dp1 = add(p1, mul(nrm, off));
  const dp2 = add(p2, mul(nrm, off));

  const h = heightOf(e, length * 0.05);
  const aLen = arrowLenOf(e, h);
  const gap = h * 0.5;
  const ext = h * 0.6;
  const aWidth = aLen * 0.5;

  const lines: [Vec2, Vec2][] = [
    [add(p1, mul(nrm, sgn * gap)), add(dp1, mul(nrm, sgn * ext))],
    [add(p2, mul(nrm, sgn * gap)), add(dp2, mul(nrm, sgn * ext))],
    [dp1, dp2],
  ];
  const arrows = [
    arrowTriangle(dp1, dir, nrm, aLen, aWidth),
    arrowTriangle(dp2, mul(dir, -1), nrm, aLen, aWidth),
  ];

  const text = resolveDimText(e, length * measureScaleOf(e), '', e.suffix);
  const center = mul(add(dp1, dp2), 0.5);
  return {
    lines,
    arrows,
    text,
    textPos: add(center, mul(nrm, sgn * gap)),
    textAngle: uprightAngle(Math.atan2(dir.y, dir.x)),
    textHeight: h,
  };
}

// ---- 半径・直径 -----------------------------------------------------------

function radial(e: DimEntity, diameter: boolean): DimGeometry | null {
  if (e.points.length < 2) return null;
  const c = e.points[0]!;
  const edge = e.points[1]!;
  const r = len(sub(edge, c));
  if (r < 1e-9) return null;
  const dir = mul(sub(edge, c), 1 / r);
  const nrm = vec(-dir.y, dir.x);

  const h = heightOf(e, r * 0.1);
  const aLen = arrowLenOf(e, h);
  const aWidth = aLen * 0.5;

  const lines: [Vec2, Vec2][] = [];
  const arrows: Vec2[][] = [];
  let center: Vec2;
  if (diameter) {
    const pa = add(c, mul(dir, r));
    const pb = sub(c, mul(dir, r));
    lines.push([pb, pa]);
    arrows.push(arrowTriangle(pa, mul(dir, -1), nrm, aLen, aWidth));
    arrows.push(arrowTriangle(pb, dir, nrm, aLen, aWidth));
    center = c;
  } else {
    lines.push([c, edge]);
    arrows.push(arrowTriangle(edge, mul(dir, -1), nrm, aLen, aWidth));
    center = add(c, mul(dir, r * 0.5));
  }

  const value = (diameter ? 2 * r : r) * measureScaleOf(e);
  return {
    lines,
    arrows,
    text: resolveDimText(e, value, diameter ? 'Ø' : 'R', e.suffix),
    textPos: add(center, mul(nrm, h * 0.5)),
    textAngle: uprightAngle(Math.atan2(dir.y, dir.x)),
    textHeight: h,
  };
}

// ---- 角度 -----------------------------------------------------------------

function angular(e: DimEntity): DimGeometry | null {
  if (e.points.length < 3) return null;
  const v = e.points[0]!;
  const a = e.points[1]!;
  const b = e.points[2]!;
  const va = sub(a, v);
  const vb = sub(b, v);
  const ra = len(va);
  const rb = len(vb);
  if (ra < 1e-9 || rb < 1e-9) return null;

  const a1 = Math.atan2(va.y, va.x);
  const a2 = Math.atan2(vb.y, vb.x);
  let d = a2 - a1;
  while (d <= -Math.PI) d += 2 * Math.PI;
  while (d > Math.PI) d -= 2 * Math.PI; // 最短回り (-π, π]
  // 4 点目（弧の通過点）が最短回りの反対側にあれば優角（>180°）を測る
  if (e.points.length >= 4) {
    const mid0 = a1 + d * 0.5;
    const mdir0 = vec(Math.cos(mid0), Math.sin(mid0));
    const lv = sub(e.points[3]!, v);
    if (lv.x * mdir0.x + lv.y * mdir0.y < 0) d -= (d >= 0 ? 1 : -1) * 2 * Math.PI;
  }
  const sweep = Math.abs(d);

  const arcR = Math.min(ra, rb) * 0.7;
  const h = heightOf(e, arcR * 0.15);
  const aLen = arrowLenOf(e, h);
  const aWidth = aLen * 0.5;

  const lines: [Vec2, Vec2][] = [];
  const d1 = mul(va, 1 / ra);
  const d2 = mul(vb, 1 / rb);
  lines.push([v, add(v, mul(d1, arcR * 1.15))]);
  lines.push([v, add(v, mul(d2, arcR * 1.15))]);

  // 弧は線分近似（6° ごと・最低 6 分割）
  const n = Math.max(6, Math.floor((sweep * 180) / Math.PI / 6));
  const arcPt = (t: number): Vec2 => {
    const ang = a1 + d * t;
    return add(v, mul(vec(Math.cos(ang), Math.sin(ang)), arcR));
  };
  let prev = arcPt(0);
  for (let i = 1; i <= n; i++) {
    const cur = arcPt(i / n);
    lines.push([prev, cur]);
    prev = cur;
  }

  // 弧端の矢印（接線方向）
  const s = Math.sign(d) === 0 ? 1 : Math.sign(d);
  const t0 = mul(vec(-Math.sin(a1), Math.cos(a1)), s);
  const t1 = mul(vec(-Math.sin(a2), Math.cos(a2)), -s);
  const arrows = [
    arrowTriangle(arcPt(0), t0, vec(-t0.y, t0.x), aLen, aWidth),
    arrowTriangle(arcPt(1), t1, vec(-t1.y, t1.x), aLen, aWidth),
  ];

  const midAng = a1 + d * 0.5;
  const mdir = vec(Math.cos(midAng), Math.sin(midAng));
  return {
    lines,
    arrows,
    text: resolveDimText(e, (sweep * 180) / Math.PI, '', '°'),
    textPos: add(v, mul(mdir, arcR + h * 0.6)),
    textAngle: 0, // 角度値は水平表示（デスクトップ版と同じ）
    textHeight: h,
  };
}

// ---- 分解 -----------------------------------------------------------------

/**
 * DXF 出力用に、寸法を線分・矢印（閉じた連続線）・文字へ分解する。
 *
 * DXF の `DIMENSION` は寸法スタイル（`DIMSTYLE`）に依存して見た目が変わるため、
 * **見たままを渡せる線分・文字へ落とす**（デスクトップ版 `DimGeom.Explode` と同じ判断）。
 */
export function dimExplode(e: DimEntity): NewEntity[] {
  const g = dimGeometry(e);
  if (!g) return [];
  const attrs = { layer: e.layer, color: e.color, lineStyle: e.lineStyle, lineWidth: e.lineWidth };
  const out: NewEntity[] = [];
  for (const [a, b] of g.lines) out.push({ ...attrs, kind: 'line', a, b });
  for (const tri of g.arrows) out.push({ ...attrs, kind: 'polyline', points: [...tri], closed: true });
  if (g.text !== '') {
    out.push({
      ...attrs,
      kind: 'text',
      at: g.textPos,
      text: g.text,
      height: g.textHeight,
      rotation: g.textAngle,
      hAlign: 'center',
      vAlign: 'bottom',
    });
  }
  return out;
}
