/**
 * まわりけん（境界辺長）。**この版は入力欄を作らず、読んだ値を見せるだけ**（issue #28）。
 * ただし**誤差の色分けは出す**（利用者の指示）。
 *
 * デスクトップ版 TrCad2D の `SurveyKenDto(Name, Measured, CalcDist, Unable)` と
 * `Keisanten`（計算点あり）に対応する。`.tc2` から読んだ値をそのまま持ち、
 * そのまま書き戻す。**Web 側で値を作らない。**
 *
 * ## 単位は m
 *
 * `.tc2` の `Measured` も `CalcDist` も **m**。デスクトップ版
 * （`MainWindow.xaml.cs` の `.tc2` 読込）は `CalcDist` を変換せずそのまま
 * `MawarikenRow` へ渡し、`ConfirmGosa` が `|Measured − CalcDist| × 1000` を
 * mm として判定している。**誤差のしきい値だけが mm。**
 *
 * 周長だけは表示のために出す。**境界名が `K1` からの連番で抜けなく揃っている
 * ときだけ**で、欠番があれば出さない（辺が欠けたまま足すと実際と違う値になる）。
 */

/** 境界辺 1 本。 */
export interface KenRow {
  /** 境界名（`K1` `K2` …）。デスクトップ版の `Name`。 */
  name: string;
  /** 実測値（まわりけん）。**文字列のまま持つ**（デスクトップ版が文字列で持つため）。 */
  measured: string;
  /** 図面から計算した辺長（**m**）。 */
  calcDist: number;
  /** 測れない辺。集計から外す。 */
  unable: boolean;
}

/** まわりけんの表全体。 */
export interface KenTable {
  rows: KenRow[];
  /** 計算点あり。ON のときデスクトップ版は実測入力を使わない。 */
  keisanten: boolean;
}

export function emptyKenTable(): KenTable {
  return { rows: [], keisanten: false };
}

export function cloneKenTable(t: KenTable): KenTable {
  return { rows: t.rows.map((r) => ({ ...r })), keisanten: t.keisanten };
}

export function isKenTableEmpty(t: KenTable): boolean {
  return t.rows.length === 0 && !t.keisanten;
}

/** 壊れた値で図面が開けなくならないよう、形を整えてから受ける。 */
export function normalizeKenTable(t: Partial<KenTable> | null | undefined): KenTable {
  const rows = Array.isArray(t?.rows) ? t.rows : [];
  return {
    rows: rows.map((r) => ({
      name: typeof r?.name === 'string' ? r.name : '',
      measured: typeof r?.measured === 'string' ? r.measured : '',
      calcDist: Number.isFinite(r?.calcDist) ? Number(r.calcDist) : 0,
      unable: r?.unable === true,
    })),
    keisanten: t?.keisanten === true,
  };
}

/**
 * 境界名から番号を採る（`K12` → 12、`k3` → 3）。
 * `K` で始まり数字が続く形だけを認める。合わなければ `null`。
 */
export function kenNumber(name: string): number | null {
  const m = /^[Kk](\d+)$/.exec(name.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

export interface SequenceCheck {
  /** `K1` から抜けなく揃っているか。 */
  complete: boolean;
  /** 抜けている番号（`K1`〜最大番号のうち無いもの）。 */
  missing: number[];
  /** `K<数字>` の形でない名前。 */
  invalid: string[];
  /** 同じ番号が 2 度以上出てくるもの。 */
  duplicated: number[];
}

/**
 * 境界名が `K1` からの連番で揃っているかを調べる。
 *
 * **揃っていないと多角形が閉じない**ので、周長や面積を出してはいけない
 * （欠けた辺のぶんだけ短い値が出て、実際と違うのに正しく見えてしまう）。
 */
export function checkSequence(rows: readonly KenRow[]): SequenceCheck {
  const invalid: string[] = [];
  const seen = new Map<number, number>();
  for (const r of rows) {
    const n = kenNumber(r.name);
    if (n === null) {
      invalid.push(r.name);
      continue;
    }
    seen.set(n, (seen.get(n) ?? 0) + 1);
  }
  const duplicated = [...seen.entries()].filter(([, c]) => c > 1).map(([n]) => n).sort((a, b) => a - b);
  const numbers = [...seen.keys()];
  const missing: number[] = [];
  if (numbers.length > 0) {
    const max = Math.max(...numbers);
    for (let i = 1; i <= max; i++) if (!seen.has(i)) missing.push(i);
  }
  const complete =
    rows.length > 0 && invalid.length === 0 && duplicated.length === 0 && missing.length === 0 && numbers.length > 0;
  return { complete, missing, invalid, duplicated };
}

export interface KenSummary {
  /** 周長（**m**）。出せないときは `null`。 */
  perimeter: number | null;
  /** 出せない理由（出せるときは空文字）。 */
  reason: string;
  /** 「不可」の辺の数。 */
  unableCount: number;
  /** 辺の数。 */
  count: number;
}

/**
 * 表示用の集計。**周長は連番が揃っているときだけ**出す。
 *
 * 「不可」の辺も**周長には含める**（測れないだけで辺そのものは在る）。
 * 面積はこの版では出さない。境界点の座標が要るが、それは #8（座標入力）の範囲。
 */
/** 誤差の判定（デスクトップ版 `GosaLevel`）。 */
export type GosaLevel = 'ok' | 'warn' | 'ng' | 'none';

/** 誤差の判定 1 件ぶん。 */
export interface KenGosa {
  /** 表示文字。数値（m・小数 3 桁）／`Over`／`－`／`No point`／`不可`／空。 */
  text: string;
  level: GosaLevel;
  /** 誤差（mm）。判定できないときは `null`。 */
  mm: number | null;
}

/** 水色の上限（mm）。デスクトップ版 `MawarikenRow.OkMm`。 */
export const OK_MM = 20;
/** 金の上限（mm）。これを超えると赤（`Over`）。デスクトップ版 `MawarikenRow.WarnMm`。 */
export const WARN_MM = 50;

/**
 * 誤差(mm)を出す。**μm で丸めてから返す。**
 *
 * `10.050 - 10` は `0.05000000000000071` になるので、素直に比べると
 * **ちょうど 50mm が Over（赤）に落ちる**。しかもこのズレは座標が大きいほど育つ
 * （`123456.050 - 123456.000` は mm にすると `50.00000000291038`）。
 * **固定の許容値では吸収しきれない**ので、比べる前に丸める。
 *
 * μm を選んだのは、まわりけんの実測が mm 単位で入る値であり、図面座標から出した
 * 計算値もそれより細かい桁に意味を持たないため。**丸めで消えるのは浮動小数の
 * ゴミだけ**で、入力から生じる差は残る。これで**境界値は必ず等号側に入る**。
 */
function gosaMm(measured: number, calcDist: number): number {
  return Math.round(Math.abs(measured - calcDist) * 1e6) / 1e3;
}

/**
 * まわりけんと計算値の誤差を判定する（デスクトップ版 `MawarikenRow.ConfirmGosa` の移植）。
 *
 * **誤差(mm) = |まわりけん − 計算値| × 1000**（どちらも m のため）。
 * 判定の順番も向こうに合わせる。順番を変えると「不可なのに数値が出る」等が起きる。
 *
 * | 条件 | 表示 | 判定 |
 * |---|---|---|
 * | 不可（測れない辺） | `不可` | 赤 |
 * | 未入力 | 空 | なし |
 * | 非数値 | `－` | 赤 |
 * | 計算値が 0 以下 | `No point` | 赤 |
 * | 誤差 ≦ 20mm | 誤差(m) | 水色 |
 * | 誤差 ≦ 50mm | 誤差(m) | 金 |
 * | 誤差 > 50mm | `Over` | 赤 |
 */
export function confirmGosa(row: KenRow): KenGosa {
  if (row.unable) return { text: '不可', level: 'ng', mm: null };
  const t = row.measured.trim();
  if (t === '') return { text: '', level: 'none', mm: null };
  const m = Number(t);
  if (!Number.isFinite(m)) return { text: '－', level: 'ng', mm: null };
  if (!(row.calcDist > 0)) return { text: 'No point', level: 'ng', mm: null };

  const mm = gosaMm(m, row.calcDist);
  if (mm <= OK_MM) return { text: (mm / 1000).toFixed(3), level: 'ok', mm };
  if (mm <= WARN_MM) return { text: (mm / 1000).toFixed(3), level: 'warn', mm };
  return { text: 'Over', level: 'ng', mm };
}

/**
 * まだ入れ直しが要る辺の数。
 *
 * デスクトップ版は **Ok・Warn 以外を未完了**として数え、1 つでもあれば先へ進ませない
 * （VB `GetMawarikenHantei`）。**「不可」の辺は測れないので対象外。**
 */
export function incompleteCount(rows: readonly KenRow[]): number {
  return rows.filter((r) => !r.unable && !['ok', 'warn'].includes(confirmGosa(r).level)).length;
}

export function summarize(table: KenTable): KenSummary {
  const rows = table.rows;
  const unableCount = rows.filter((r) => r.unable).length;
  if (rows.length === 0) {
    return { perimeter: null, reason: 'まわりけんがありません', unableCount, count: 0 };
  }
  const check = checkSequence(rows);
  if (!check.complete) {
    const parts: string[] = [];
    if (check.missing.length > 0) parts.push(`K${check.missing.join(' / K')} が欠番`);
    if (check.invalid.length > 0) parts.push(`「${check.invalid.join('」「')}」は K+数字の形でない`);
    if (check.duplicated.length > 0) parts.push(`K${check.duplicated.join(' / K')} が重複`);
    return {
      perimeter: null,
      reason: `境界が連番で揃っていないため周長を出せません（${parts.join('、')}）`,
      unableCount,
      count: rows.length,
    };
  }
  const perimeter = rows.reduce((sum, r) => sum + r.calcDist, 0);
  return { perimeter, reason: '', unableCount, count: rows.length };
}
