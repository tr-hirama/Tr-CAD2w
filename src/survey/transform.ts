/**
 * 座標変換（ヘルマート／アフィン）。
 *
 * デスクトップ版 TrCad2D の `Helmert.cs` を写したもの。共通点（変換前 → 変換後）
 * から最小二乗でパラメータを求める。
 *
 * ## ヘルマート（相似変換・4 パラメータ）
 *
 * ```
 * X' = A·x − B·y + C
 * Y' = B·x + A·y + D        （A = s·cosθ, B = s·sinθ）
 * ```
 *
 * 縮尺と回転と平行移動だけ。**形は変わらない**（角度と縦横比が保たれる）。
 * 測量の座標系変換はふつうこれ。**2 点以上**必要。
 *
 * ## アフィン（6 パラメータ）
 *
 * ```
 * X' = M11·x + M12·y + Tx
 * Y' = M21·x + M22·y + Ty
 * ```
 *
 * せん断と非等方の伸縮も表せる。**3 点以上**必要（同一直線上だと解けない）。
 * **ヘルマートはアフィンの特別な場合**（`M11 = M22`, `M12 = −M21`）。
 *
 * x,y と X,Y は同じ座標系の取り方（測量なら X=北, Y=東）で扱う。
 */

/** 共通点 1 組（変換前 → 変換後）。 */
export interface ControlPoint {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}

/** ヘルマート変換の 4 パラメータ。 */
export interface HelmertParams {
  a: number;
  b: number;
  c: number;
  d: number;
  /** 使った共通点の数。 */
  n: number;
}

/** 縮尺（倍率）。 */
export function helmertScale(p: HelmertParams): number {
  return Math.hypot(p.a, p.b);
}

/** 回転角（度・反時計回り）。 */
export function helmertRotationDeg(p: HelmertParams): number {
  return (Math.atan2(p.b, p.a) * 180) / Math.PI;
}

/** 点を変換後の座標へ。 */
export function helmertApply(p: HelmertParams, x: number, y: number): { x: number; y: number } {
  return { x: p.a * x - p.b * y + p.c, y: p.b * x + p.a * y + p.d };
}

/**
 * 共通点からヘルマートの 4 パラメータを最小二乗で求める。
 *
 * **2 点以上**必要。変換前の点がすべて同じ位置など、退化していれば `null`。
 * 重心を引いてから解く（平行移動を分離すると 2 パラメータの問題に落ちる）。
 */
export function solveHelmert(pts: readonly ControlPoint[]): HelmertParams | null {
  const n = pts.length;
  if (n < 2) return null;

  let sxm = 0;
  let sym = 0;
  let txm = 0;
  let tym = 0;
  for (const p of pts) {
    sxm += p.sx;
    sym += p.sy;
    txm += p.tx;
    tym += p.ty;
  }
  sxm /= n;
  sym /= n;
  txm /= n;
  tym /= n;

  let suu = 0;
  let num1 = 0;
  let num2 = 0;
  for (const p of pts) {
    const u = p.sx - sxm;
    const v = p.sy - sym;
    const uu = p.tx - txm;
    const vv = p.ty - tym;
    suu += u * u + v * v;
    num1 += u * uu + v * vv; // A の分子
    num2 += u * vv - v * uu; // B の分子
  }
  // 変換前の点が 1 か所に固まっていると割れない
  if (suu < 1e-12) return null;

  const a = num1 / suu;
  const b = num2 / suu;
  const c = txm - (a * sxm - b * sym);
  const d = tym - (b * sxm + a * sym);
  return { a, b, c, d, n };
}

/** アフィン変換の 6 パラメータ。 */
export interface AffineParams {
  m11: number;
  m12: number;
  tx: number;
  m21: number;
  m22: number;
  ty: number;
}

export function affineApply(p: AffineParams, x: number, y: number): { x: number; y: number } {
  return { x: p.m11 * x + p.m12 * y + p.tx, y: p.m21 * x + p.m22 * y + p.ty };
}

/** 線形部の行列式（面積比）。負なら裏返っている。 */
export function affineDet(p: AffineParams): number {
  return p.m11 * p.m22 - p.m12 * p.m21;
}

/** ヘルマートを同値のアフィンへ。 */
export function helmertToAffine(p: HelmertParams): AffineParams {
  return { m11: p.a, m12: -p.b, tx: p.c, m21: p.b, m22: p.a, ty: p.d };
}

/**
 * 共通点からアフィンの 6 パラメータを最小二乗で求める。
 *
 * **3 点以上**必要。同一直線上に並んでいるなど退化していれば `null`。
 * X' と Y' で正規方程式の係数行列が同じなので、1 度組んで 2 回解く。
 */
export function solveAffine(pts: readonly ControlPoint[]): AffineParams | null {
  const n = pts.length;
  if (n < 3) return null;

  let sxx = 0;
  let sxy = 0;
  let sx = 0;
  let syy = 0;
  let sy = 0;
  let bxX = 0;
  let byX = 0;
  let bX = 0;
  let bxY = 0;
  let byY = 0;
  let bY = 0;
  for (const p of pts) {
    sxx += p.sx * p.sx;
    sxy += p.sx * p.sy;
    sx += p.sx;
    syy += p.sy * p.sy;
    sy += p.sy;
    bxX += p.sx * p.tx;
    byX += p.sy * p.tx;
    bX += p.tx;
    bxY += p.sx * p.ty;
    byY += p.sy * p.ty;
    bY += p.ty;
  }
  const mat: number[][] = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, n],
  ];
  const r1 = solve3(mat, [bxX, byX, bX]);
  const r2 = solve3(mat, [bxY, byY, bY]);
  if (!r1 || !r2) return null;
  return { m11: r1[0]!, m12: r1[1]!, tx: r1[2]!, m21: r2[0]!, m22: r2[1]!, ty: r2[2]! };
}

/**
 * 3 元連立一次方程式を部分ピボットのガウス消去で解く。特異なら `null`。
 *
 * **部分ピボットが要る。** 先頭が 0 に近い行を軸にすると割り算で桁が飛ぶ。
 */
function solve3(m: readonly (readonly number[])[], b: readonly number[]): number[] | null {
  const a = m.map((row) => [...row]);
  const bb = [...b];
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(a[r]![col]!) > Math.abs(a[piv]![col]!)) piv = r;
    }
    if (Math.abs(a[piv]![col]!) < 1e-15) return null;
    if (piv !== col) {
      [a[col], a[piv]] = [a[piv]!, a[col]!];
      [bb[col], bb[piv]] = [bb[piv]!, bb[col]!];
    }
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = a[r]![col]! / a[col]![col]!;
      for (let k = 0; k < 3; k++) a[r]![k]! -= f * a[col]![k]!;
      bb[r]! -= f * bb[col]!;
    }
  }
  return [bb[0]! / a[0]![0]!, bb[1]! / a[1]![1]!, bb[2]! / a[2]![2]!];
}

/** 共通点 1 組の残差（変換して当てたときのズレ）。 */
export interface Residual {
  index: number;
  dx: number;
  dy: number;
  /** ズレの大きさ。 */
  distance: number;
}

export interface ResidualSummary {
  each: Residual[];
  /** いちばん大きいズレ。点が無ければ 0。 */
  max: number;
  /** 二乗平均平方根。 */
  rms: number;
}

/**
 * 求めたパラメータで共通点を変換し、実際の変換後座標とのズレを測る。
 *
 * **これを見ないと、解けたのに合っていない変換に気づけない**
 * （最小二乗は必ず「解」を返すが、共通点の入力が悪ければ残差が大きく出る）。
 */
export function residuals(
  pts: readonly ControlPoint[],
  apply: (x: number, y: number) => { x: number; y: number },
): ResidualSummary {
  const each: Residual[] = pts.map((p, index) => {
    const got = apply(p.sx, p.sy);
    const dx = got.x - p.tx;
    const dy = got.y - p.ty;
    return { index, dx, dy, distance: Math.hypot(dx, dy) };
  });
  if (each.length === 0) return { each, max: 0, rms: 0 };
  const max = each.reduce((m, r) => Math.max(m, r.distance), 0);
  const rms = Math.sqrt(each.reduce((s, r) => s + r.distance * r.distance, 0) / each.length);
  return { each, max, rms };
}

// ---- .tc2 の入力行 -------------------------------------------------------

/**
 * 座標変換の共通点 1 行（デスクトップ版 `SurveyTransformDto(Name, Sx, Sy, Tx, Ty)`）。
 * **すべて文字列**（空欄や非数値が混ざる）。
 */
export interface TransformRow {
  name: string;
  sx: string;
  sy: string;
  tx: string;
  ty: string;
}

export function emptyTransformRow(name = ''): TransformRow {
  return { name, sx: '', sy: '', tx: '', ty: '' };
}

export function cloneTransformRows(rows: readonly TransformRow[]): TransformRow[] {
  return rows.map((r) => ({ ...r }));
}

export function normalizeTransformRows(rows: unknown): TransformRow[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((r: Partial<TransformRow> | null | undefined) => ({
    name: typeof r?.name === 'string' ? r.name : '',
    sx: typeof r?.sx === 'string' ? r.sx : '',
    sy: typeof r?.sy === 'string' ? r.sy : '',
    tx: typeof r?.tx === 'string' ? r.tx : '',
    ty: typeof r?.ty === 'string' ? r.ty : '',
  }));
}

/**
 * 入力行のうち **4 つとも数値のもの**だけを共通点として採る。
 * 1 つでも欠けた行は計算に使えないので落とす（`skipped` で数を返す）。
 */
export function controlPoints(rows: readonly TransformRow[]): { points: ControlPoint[]; skipped: number } {
  const points: ControlPoint[] = [];
  let skipped = 0;
  for (const r of rows) {
    const sx = num(r.sx);
    const sy = num(r.sy);
    const tx = num(r.tx);
    const ty = num(r.ty);
    if (sx === null || sy === null || tx === null || ty === null) {
      // 名前だけの空行は「欠け」に数えない（表の余白なので）
      if (r.name.trim() !== '' || r.sx + r.sy + r.tx + r.ty !== '') skipped++;
      continue;
    }
    points.push({ sx, sy, tx, ty });
  }
  return { points, skipped };
}

function num(s: string): number | null {
  const t = s.trim();
  if (t === '') return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}
