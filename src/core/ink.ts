/**
 * 手書きメモ（点列）。issue #39・**案 B**。
 *
 * ## なぜ点列にするか
 *
 * デスクトップ版 TrCad2D はこれまで **Windows Ink の ISF**（`MemoInk`）で
 * 手書きを持っていた。ISF は Windows の API（`System.Windows.Ink`）が読み書き
 * する形式で、**ブラウザには読み書きする手段が無い**。
 *
 * 利用者の判断（issue #39）で **ISF は捨て、点列（`MemoStrokes`）だけを正とする**。
 * 「変換が必要な図面は現時点で保存していない」ため、移行用の ISF → 点列変換も
 * 要らない。**Web でもデスクトップ版でも同じ形式を読み書きする。**
 *
 * ## 持ち方
 *
 * 1 本のストローク＝連続して引いた線。点は `x` `y` と筆圧 `p`（0〜1）。
 * 座標は**メモ領域の中の相対座標**（0〜1）で持つ。表示の大きさが変わっても
 * 同じ形で描けるようにするため。
 */

/** ストロークの 1 点。 */
export interface InkPoint {
  /** メモ領域の中の相対座標（0〜1）。 */
  x: number;
  y: number;
  /** 筆圧（0〜1）。取れない入力機器では 0.5。 */
  p: number;
}

/** 続けて引いた線 1 本。 */
export interface InkStroke {
  points: InkPoint[];
  /** 線の色（`#rrggbb`）。 */
  color: string;
  /** 線の太さ（メモ領域の幅に対する比）。 */
  width: number;
}

export const DEFAULT_INK_COLOR = '#1b1b1b';
/** 既定の太さ。メモ領域の幅の 0.4%。 */
export const DEFAULT_INK_WIDTH = 0.004;

export function cloneStrokes(strokes: readonly InkStroke[]): InkStroke[] {
  return strokes.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p })) }));
}

/** 壊れた値で図面が開けなくならないよう、形を整えてから受ける。 */
export function normalizeStrokes(value: unknown): InkStroke[] {
  if (!Array.isArray(value)) return [];
  const out: InkStroke[] = [];
  for (const s of value as Partial<InkStroke>[]) {
    if (!Array.isArray(s?.points)) continue;
    const points = (s.points as Partial<InkPoint>[])
      .filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y))
      .map((p) => ({
        x: clamp01(Number(p.x)),
        y: clamp01(Number(p.y)),
        p: Number.isFinite(p?.p) ? clamp01(Number(p.p)) : 0.5,
      }));
    // 点が 1 つも無いストロークは捨てる（描けないので持っていても意味が無い）
    if (points.length === 0) continue;
    out.push({
      points,
      color: typeof s.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.color) ? s.color : DEFAULT_INK_COLOR,
      width: Number.isFinite(s.width) && Number(s.width) > 0 ? Number(s.width) : DEFAULT_INK_WIDTH,
    });
  }
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 引いた軌跡から点を間引く（Ramer–Douglas–Peucker）。
 *
 * ポインタは 1 秒に何十点も来るので、そのまま持つとファイルが膨らむ。
 * **形が変わらない範囲で捨てる**。`tolerance` は相対座標での距離。
 */
export function simplifyStroke(points: readonly InkPoint[], tolerance = 0.002): InkPoint[] {
  if (points.length <= 2) return points.map((p) => ({ ...p }));

  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    if (last <= first + 1) continue;
    let maxDist = -1;
    let index = first;
    for (let i = first + 1; i < last; i++) {
      const d = perpendicular(points[i]!, points[first]!, points[last]!);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (maxDist > tolerance) {
      keep[index] = true;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]).map((p) => ({ ...p }));
}

/** 点 `p` から線分 `a`–`b` までの距離。 */
function perpendicular(p: InkPoint, a: InkPoint, b: InkPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  // 線分の外側へ出た分は端点までの距離で測る
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** ストロークの点の総数（保存の大きさの目安）。 */
export function pointCount(strokes: readonly InkStroke[]): number {
  return strokes.reduce((n, s) => n + s.points.length, 0);
}

/**
 * 消しゴム。**線に触れたストロークを丸ごと消す。**
 *
 * 判定は「点」ではなく**線分との距離**で行う。`simplifyStroke` で点を間引くので、
 * まっすぐな線では両端しか点が残らない。点だけを見ると**線の途中を狙っても
 * 消えない**（実機で踏んだ）。
 *
 * 部分的に切る（ストロークを 2 本に割る）方が細かく消せるが、消し跡が
 * 不自然に途切れやすい。手書きメモの用途では 1 本ずつ消す方が扱いやすい。
 */
export function eraseAt(
  strokes: readonly InkStroke[],
  at: { x: number; y: number },
  radius: number,
): InkStroke[] {
  const target: InkPoint = { x: at.x, y: at.y, p: 0 };
  return strokes.filter((s) => {
    if (s.points.length === 1) {
      return Math.hypot(s.points[0]!.x - at.x, s.points[0]!.y - at.y) > radius;
    }
    for (let i = 0; i + 1 < s.points.length; i++) {
      if (perpendicular(target, s.points[i]!, s.points[i + 1]!) <= radius) return false;
    }
    return true;
  });
}
