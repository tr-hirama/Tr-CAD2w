/**
 * 測量帳票の `.xlsx`（issue #29）。
 *
 * レベル（水準）の表を Excel へ出す。**数式を入れる**ので、受け取った人が数字を
 * 差し替えて追える（値だけだと Excel 側で検算できない）。
 *
 * 数式は `xlsx.ts` の約束どおり**1 セルずつ通常数式**で書く。共有数式は使わない
 * （デスクトップ版で Excel の修復ダイアログが出た原因）。
 *
 * **座標変換の帳票は入れない。** 利用者の「今は不要」（PR #47）で範囲から外れた。
 * 再開するときは `issue-29-transform` ブランチに求解と残差の実装が残っている。
 */

import { EMPTY, formula, num, text, writeXlsx, type Cell, type Sheet } from '../io/xlsx.js';
import { calcLevel, type LevelRow } from './level.js';

/** 1 行目は見出し、2 行目からデータ（Excel の行番号は 1 始まり）。 */
const HEADER_ROWS = 1;

/**
 * レベルのシート。
 *
 * | 列 | 内容 |
 * |---|---|
 * | A | 測点 |
 * | B | 後視 BS |
 * | C | 前視 FS |
 * | D | 器械高 IH（**数式** `= 地盤高 + 後視`） |
 * | E | 地盤高 GH（**数式** `= 直前の器械高 − 前視`） |
 * | F | 摘要 |
 *
 * **器高式そのものを数式にする**ので、B/C を差し替えれば D/E が追従する。
 * 器械を据えた行より前に器械高は無いので、そこだけ地盤高を値で置く。
 */
export function levelSheet(rows: readonly LevelRow[]): Sheet {
  const calc = calcLevel(rows);
  const out: Cell[][] = [
    [text('測点'), text('後視 BS'), text('前視 FS'), text('器械高 IH'), text('地盤高 GH'), text('摘要')],
  ];

  // 直前に器械を据えた行（Excel の行番号）。器械高の参照先になる
  let instrumentRow: number | null = null;

  calc.rows.forEach((r, i) => {
    const excelRow = i + HEADER_ROWS + 1; // Excel の行番号は 1 始まり
    const src = rows[r.index];
    const bs = r.bs === null ? EMPTY : num(r.bs);
    const fs = r.fs === null ? EMPTY : num(r.fs);

    let ih: Cell = EMPTY;
    let gh: Cell;

    if (r.kind === 'instrument') {
      // 据付の行。地盤高は入力（既知点）か直前に決まった値なので、値で置く
      gh = num(r.gh);
      // 器械高 = 地盤高 + 後視
      ih = formula(`E${excelRow}+B${excelRow}`);
      instrumentRow = excelRow;
    } else if (r.kind === 'turning' && instrumentRow !== null) {
      // 転換点（issue #52）。**前視で地盤高を出してから**、その上に器械を据え直す。
      // 1 行で 2 つの数式が要る（D と E が同じ行で互いを見ない形になっている）
      gh = formula(`D${instrumentRow}-C${excelRow}`);
      ih = formula(`E${excelRow}+B${excelRow}`);
      instrumentRow = excelRow;
    } else if (r.fs !== null && instrumentRow !== null) {
      // 地盤高 = 直前の器械高 − 前視
      gh = formula(`D${instrumentRow}-C${excelRow}`);
    } else {
      gh = num(r.gh);
    }

    out.push([text(r.name), bs, fs, ih, gh, text(src?.remarks ?? '')]);
  });

  // 締め。合計と高低差も数式にして、差し替えに追従させる
  if (calc.rows.length > 0) {
    const first = HEADER_ROWS + 1;
    const last = HEADER_ROWS + calc.rows.length;
    out.push([]);
    const sumRow = out.length + 1;
    out.push([
      text('合計'),
      formula(`SUM(B${first}:B${last})`),
      formula(`SUM(C${first}:C${last})`),
      EMPTY,
      EMPTY,
      EMPTY,
    ]);
    out.push([text('高低差（後視計 − 前視計）'), formula(`B${sumRow}-C${sumRow}`)]);
  }

  // 解けなかった行は**落とさずに書く**。黙って消すと入力の取りこぼしに気づけない
  if (calc.unresolved.length > 0) {
    out.push([]);
    out.push([text(`解けなかった行: ${calc.unresolved.length} 件`)]);
    for (const u of calc.unresolved) out.push([text(u.name), text(u.reason)]);
  }

  return { name: 'レベル計算', rows: out };
}

/**
 * レベルの帳票を `.xlsx` のバイト列にする。
 *
 * 空の図面で押されたときは**書き出さずに投げる**（0 行の Excel を開かせない）。
 */
export async function writeSurveyReport(level: readonly LevelRow[]): Promise<Uint8Array> {
  if (level.length === 0) throw new Error('レベル（水準）が入っていません');
  return writeXlsx([levelSheet(level)]);
}

/** 帳票の既定のファイル名。 */
export function defaultReportFileName(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  return `測量帳票-${stamp}.xlsx`;
}
