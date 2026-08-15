/**
 * レベル（水準測量）の器高式。
 *
 * デスクトップ版 TrCad2D の `LevelExcel.cs` の `BuildRows`（さらにその元は
 * VB 版の `btnLevelExcel` ＋ `LevelCalc`）を写したもの。**値は m**。
 *
 * ## 器高式
 *
 * ```
 * 器械高 IH = 後視 BS + その点の地盤高 GH
 * 地盤高 GH = 器械高 IH − 前視 FS
 * ```
 *
 * 入力は**すべて文字列**で持つ（デスクトップ版が `SurveyLevelDto(Name, BS, FS,
 * GH, Remarks, TP, CK)` を文字列で持つため）。空欄・非数値・`[点番]` 参照が
 * 混ざるので、数値に直せるかどうかで行の意味が変わる。
 *
 * ## 行の読み分け（この順で判定する）
 *
 * | 条件 | 意味 | GH |
 * |---|---|---|
 * | `BS` が数値 | 既知点／器械設置 | 確定済み → 入力 `GH` → 0 の順。**器械高を更新** |
 * | `BS` が `[点番]`・`FS` が数値 | 参照点からの派生 | 参照点の GH + FS |
 * | `FS` が数値 | ふつうの前視 | 器械高 − FS |
 * | `GH` が数値 | 与点（BS も FS も無い） | 入力 `GH` |
 *
 * **`TP`（転換点の前視）は `FS` と同じ扱い。** `FS` が空で `TP` に数値があれば
 * `TP` を前視として読む。これを見ないと転換点の行が「与点」に落ちて計算が狂う。
 *
 * **確定 GH は初回のみ**（`first-write-wins`）。既知点へ点検の前視を打っても
 * GH を上書きしない。上書きすると点検の誤差が器械高へ伝播して以降が全部ずれる。
 */

/** レベルの 1 行（デスクトップ版 `SurveyLevelDto`）。 */
export interface LevelRow {
  /** 測点名。 */
  name: string;
  /** 後視。数値か `[点番]` 参照か空。 */
  bs: string;
  /** 前視。 */
  fs: string;
  /** 地盤高（与点や既知点の入力値）。 */
  gh: string;
  /** 摘要。 */
  remarks: string;
  /** 転換点の前視。**`fs` が空ならこれを前視として読む。** */
  tp: string;
  /** 与点チェックの差分。計算には使わず持ち回るだけ。 */
  ck: string;
}

export function emptyLevelRow(name = ''): LevelRow {
  return { name, bs: '', fs: '', gh: '', remarks: '', tp: '', ck: '' };
}

export function cloneLevelRows(rows: readonly LevelRow[]): LevelRow[] {
  return rows.map((r) => ({ ...r }));
}

export function normalizeLevelRows(rows: unknown): LevelRow[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((r: Partial<LevelRow> | null | undefined) => ({
    name: typeof r?.name === 'string' ? r.name : '',
    bs: typeof r?.bs === 'string' ? r.bs : '',
    fs: typeof r?.fs === 'string' ? r.fs : '',
    gh: typeof r?.gh === 'string' ? r.gh : '',
    remarks: typeof r?.remarks === 'string' ? r.remarks : '',
    tp: typeof r?.tp === 'string' ? r.tp : '',
    ck: typeof r?.ck === 'string' ? r.ck : '',
  }));
}

/**
 * 文字列を数値として読む。**空欄と非数値は `null`。**
 * 全角の数字や前後の空白が混ざることがあるので、そこだけ均す。
 */
export function parseNumber(s: string): number | null {
  const t = s
    .trim()
    .replace(/[０-９．＋－]/g, (c) => '0123456789.+-'['０１２３４５６７８９．＋－'.indexOf(c)] ?? c)
    .replace(/,/g, '');
  if (t === '') return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

/** `[点番]` 参照なら中の点番、そうでなければ `null`。 */
export function referencedPoint(bs: string): string | null {
  const t = bs.trim();
  if (!t.startsWith('[')) return null;
  const name = t.replace(/^\[/, '').replace(/\]$/, '').trim();
  return name === '' ? null : name;
}

/** 計算した 1 行。 */
export interface LevelResult {
  name: string;
  /** 解決した地盤高（m）。 */
  gh: number;
  /** その行で更新された器械高（m）。更新していなければ `null`。 */
  ih: number | null;
  /** 後視として使った値（帳票の B 列）。 */
  bs: number | null;
  /** 前視として使った値（帳票の C 列）。 */
  fs: number | null;
  /** どの規則で解決したか。 */
  kind: 'instrument' | 'reference' | 'foresight' | 'given';
  /** 元の行の位置（表と突き合わせるため）。 */
  index: number;
}

export interface LevelCalc {
  rows: LevelResult[];
  /** GH を解決できなかった行（名前と理由）。 */
  unresolved: { index: number; name: string; reason: string }[];
  /** 点ごとの確定 GH（初回に決まった値）。 */
  fixed: Map<string, number>;
}

/**
 * 器高式で各行の地盤高を解く。
 *
 * **解決できない行は `unresolved` へ回し、計算は止めない**（1 行の入力漏れで
 * 帳票が丸ごと出せなくなるより、出せる行を出して欠けを知らせる方がよい）。
 */
export function calcLevel(rows: readonly LevelRow[]): LevelCalc {
  const out: LevelResult[] = [];
  const unresolved: { index: number; name: string; reason: string }[] = [];
  const fixed = new Map<string, number>();
  let ih: number | null = null;

  rows.forEach((row, index) => {
    const name = row.name.trim();
    if (name === '') return; // 名前の無い行は表の空行。黙って飛ばす

    const bsNum = parseNumber(row.bs);
    // TP は前視と同じ扱い（FS が空のときだけ読む）
    const fsNum = parseNumber(row.fs) ?? parseNumber(row.tp);
    const ref = referencedPoint(row.bs);
    const ghNum = parseNumber(row.gh);

    let gh: number | null = null;
    let bs: number | null = null;
    let fs: number | null = null;
    let kind: LevelResult['kind'] = 'given';
    let ihHere: number | null = null;

    if (bsNum !== null) {
      // 既知点／器械設置。確定済みの GH があればそれを使う（点検の誤差を伝播させない）
      gh = fixed.get(name) ?? ghNum ?? 0;
      ih = bsNum + gh;
      ihHere = ih;
      bs = bsNum;
      kind = 'instrument';
    } else if (ref !== null && fsNum !== null) {
      const refGh = fixed.get(ref);
      if (refGh === undefined) {
        unresolved.push({ index, name, reason: `参照先 [${ref}] の地盤高がまだ決まっていません` });
        return;
      }
      gh = refGh + fsNum;
      if (ih !== null) fs = ih - gh;
      kind = 'reference';
    } else if (fsNum !== null) {
      if (ih === null) {
        unresolved.push({ index, name, reason: '器械高が決まっていません（先に後視のある行が要ります）' });
        return;
      }
      gh = ih - fsNum;
      fs = fsNum;
      kind = 'foresight';
    } else if (ghNum !== null) {
      gh = ghNum;
      fs = ghNum;
      kind = 'given';
    } else {
      unresolved.push({ index, name, reason: '後視・前視・地盤高のいずれも数値でありません' });
      return;
    }

    // 確定 GH は初回のみ
    if (!fixed.has(name)) fixed.set(name, gh);
    out.push({ name, gh, ih: ihHere, bs, fs, kind, index });
  });

  return { rows: out, unresolved, fixed };
}

export interface LevelSummary {
  /** 後視の合計（m）。 */
  totalBs: number;
  /** 前視の合計（m）。 */
  totalFs: number;
  /** 高低差（後視の合計 − 前視の合計）。 */
  difference: number;
  /** 解けた行の数。 */
  resolved: number;
  /** 解けなかった行の数。 */
  unresolved: number;
}

/**
 * 帳票の締め。**閉合差の判定はしない**（この版は表示だけ）。
 * 合計は「実際に読んだ値」だけを足す（`null` の列は飛ばす）。
 */
export function summarizeLevel(calc: LevelCalc): LevelSummary {
  let totalBs = 0;
  let totalFs = 0;
  for (const r of calc.rows) {
    if (r.bs !== null) totalBs += r.bs;
    if (r.fs !== null) totalFs += r.fs;
  }
  return {
    totalBs,
    totalFs,
    difference: totalBs - totalFs,
    resolved: calc.rows.length,
    unresolved: calc.unresolved.length,
  };
}
