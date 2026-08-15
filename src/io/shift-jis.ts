/**
 * Shift-JIS（CP932 / `ANSI_932`）への符号化。
 *
 * 旧 AutoCAD / ZWCAD は DXF を Shift-JIS で読むので、UTF-8 で出すと日本語が
 * 化けることがある（issue #4）。ブラウザの `TextEncoder` は **UTF-8 固定**で
 * Shift-JIS を書けないため、ここで変換を持つ。
 *
 * ## 変換表の出どころ
 *
 * **表を持ち込まず、`TextDecoder('shift_jis')` から実行時に逆引きを組む。**
 * このデコーダは [Encoding Standard](https://encoding.spec.whatwg.org/#shift_jis)
 * の索引そのもので、ブラウザにも Node にも標準で入っている。全 2 バイト列
 * （0x81–0xFC × 0x40–0xFC）を 1 度ずつ通して「読めた文字 → そのバイト列」を
 * 記録すれば、**読み側と必ず一致する表**が手に入る。
 *
 * この作り方なら
 *
 * - 7,000 字ぶんの表（100KB 前後）をリポジトリに抱えなくてよい
 * - 表の誤りが原理的に入らない（読みと書きが同じ索引を見る）
 * - **実行時依存は増えない**（標準 API だけ）
 *
 * 構築は 9,206 文字で 6ms 程度。初回の書き出し時にだけ組んで使い回す。
 */

/** Unicode コードポイント → Shift-JIS のバイト列（1 バイトはそのまま、2 バイトは `hi<<8|lo`）。 */
let table: Map<number, number> | null = null;

/** 変換できない文字の代わりに置くバイト（`?`）。 */
const REPLACEMENT = 0x3f;

/**
 * 逆引き表を組む。**`TextDecoder` が読めた組み合わせだけ**を採る。
 *
 * 同じ文字に複数のバイト列が当たることがある（NEC 選定 IBM 拡張と IBM 拡張の重複）。
 * その場合は**若いバイト列を採る**（先に見つけたものを残す）。デスクトップ版が
 * 書き出すのも若い方なので、往復で揺れない。
 */
function buildTable(): Map<number, number> {
  const dec = new TextDecoder('shift_jis');
  const m = new Map<number, number>();
  const one = new Uint8Array(1);
  const two = new Uint8Array(2);

  // 1 バイト域: ASCII（0x00–0x7F）と半角カナ（0xA1–0xDF）
  for (let b = 0x00; b <= 0xff; b++) {
    one[0] = b;
    const s = dec.decode(one);
    if (s.length !== 1) continue;
    const cp = s.codePointAt(0)!;
    if (cp === 0xfffd) continue;
    if (!m.has(cp)) m.set(cp, b);
  }

  // 2 バイト域
  for (let hi = 0x81; hi <= 0xfc; hi++) {
    // 0xA0–0xDF は半角カナなので 2 バイトの先頭にはならない
    if (hi >= 0xa0 && hi <= 0xdf) continue;
    two[0] = hi;
    for (let lo = 0x40; lo <= 0xfc; lo++) {
      if (lo === 0x7f) continue;
      two[1] = lo;
      const s = dec.decode(two);
      if (s.length !== 1) continue;
      const cp = s.codePointAt(0)!;
      if (cp === 0xfffd) continue;
      if (!m.has(cp)) m.set(cp, (hi << 8) | lo);
    }
  }
  return m;
}

/** 逆引き表（初回だけ組む）。 */
function shiftJisTable(): Map<number, number> {
  table ??= buildTable();
  return table;
}

/** 表に載っている文字数（テストと診断用）。 */
export function shiftJisTableSize(): number {
  return shiftJisTable().size;
}

export interface ShiftJisResult {
  bytes: Uint8Array;
  /** Shift-JIS に無くて `?` へ落とした文字の数。 */
  unmapped: number;
}

/**
 * 文字列を Shift-JIS のバイト列にする。
 *
 * **変換できない文字は `?` にして先へ進む**（例外にしない）。図面の書き出しが
 * 1 文字のために丸ごと失敗するより、落ちた数を返して呼び出し側に知らせる方がよい。
 */
export function encodeShiftJis(text: string): ShiftJisResult {
  const map = shiftJisTable();
  const out: number[] = [];
  let unmapped = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const sjis = map.get(cp);
    if (sjis === undefined) {
      out.push(REPLACEMENT);
      unmapped++;
      continue;
    }
    if (sjis > 0xff) {
      out.push(sjis >> 8, sjis & 0xff);
    } else {
      out.push(sjis);
    }
  }
  return { bytes: new Uint8Array(out), unmapped };
}

/** すべての文字が Shift-JIS で書けるか。 */
export function canEncodeShiftJis(text: string): boolean {
  const map = shiftJisTable();
  for (const ch of text) {
    if (!map.has(ch.codePointAt(0)!)) return false;
  }
  return true;
}

/** Shift-JIS で書けない文字を重複なく拾う（利用者への報告用）。 */
export function unmappableChars(text: string): string[] {
  const map = shiftJisTable();
  const seen = new Set<string>();
  for (const ch of text) {
    if (!map.has(ch.codePointAt(0)!)) seen.add(ch);
  }
  return [...seen];
}
