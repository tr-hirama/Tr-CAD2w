/**
 * 測量帳票の `.xlsx`（issue #29 の 3/3）。
 *
 * レベル（水準）と座標変換の表を Excel へ出す。**数式を入れる**ので、受け取った
 * 人が数字を差し替えて追える（値だけだと Excel 側で検算できない）。
 *
 * 数式は `xlsx.ts` の約束どおり**1 セルずつ通常数式**で書く。共有数式は使わない
 * （デスクトップ版で Excel の修復ダイアログが出た原因）。
 */

import { EMPTY, formula, num, text, writeXlsx, type Cell, type Sheet } from '../io/xlsx.js';
import { calcLevel, type LevelRow } from './level.js';
import {
  controlPoints,
  helmertApply,
  helmertRotationDeg,
  helmertScale,
  residuals,
  solveHelmert,
  type TransformRow,
} from './transform.js';

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
 * 器高式そのものを数式にするので、B/C を差し替えれば D/E が追従する。
 * **最初の行だけは器械高を数式にできない**（引き算の相手が無い）ので、
 * 解いた地盤高を値で置く。
 */
export function levelSheet(rows: readonly LevelRow[]): Sheet {
  const calc = calcLevel(rows);
  const out: Cell[][] = [
    [text('測点'), text('後視 BS'), text('前視 FS'), text('器械高 IH'), text('地盤高 GH'), text('摘要')],
  ];

  // 直前に器械を据えた行（Excel の行番号）。器械高の参照先になる
  let instrumentRow: number | null = null;

  calc.rows.forEach((r, i) => {
    const excelRow = i + HEADER_ROWS + 1; // 1 始まり
    const src = rows[r.index]!;
    const bs = r.bs === null ? EMPTY : num(r.bs);
    const fs = r.fs === null ? EMPTY : num(r.fs);

    let ih: Cell = EMPTY;
    let gh: Cell;

    if (r.kind === 'instrument') {
      if (instrumentRow === null) {
        // 最初の据付。地盤高は入力（または 0）なので値で置く
        gh = num(r.gh);
      } else {
        // 据え直し。地盤高は直前の器械高から前視を引いた値のまま
        gh = num(r.gh);
      }
      // 器械高 = 地盤高 + 後視
      ih = formula(`E${excelRow}+B${excelRow}`);
      instrumentRow = excelRow;
    } else if (r.fs !== null && instrumentRow !== null) {
      // 地盤高 = 直前の器械高 − 前視
      gh = formula(`D${instrumentRow}-C${excelRow}`);
    } else {
      gh = num(r.gh);
    }

    out.push([text(r.name), bs, fs, ih, gh, text(src.remarks)]);
  });

  // 締め。合計と高低差を数式で
  const first = HEADER_ROWS + 1;
  const last = HEADER_ROWS + calc.rows.length;
  if (calc.rows.length > 0) {
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

  if (calc.unresolved.length > 0) {
    out.push([]);
    out.push([text(`解けなかった行: ${calc.unresolved.length} 件`)]);
    for (const u of calc.unresolved) out.push([text(u.name), text(u.reason)]);
  }

  return { name: 'レベル計算', rows: out };
}

/**
 * 座標変換のシート。
 *
 * 共通点の表と、解いたヘルマートのパラメータ・残差を出す。
 * **残差は数式**（`変換後 − 実測`）にして、共通点を差し替えたら追従させる。
 */
export function transformSheet(rows: readonly TransformRow[]): Sheet {
  const { points, skipped } = controlPoints(rows);
  const h = solveHelmert(points);

  const out: Cell[][] = [
    [
      text('点名'),
      text('前 X'),
      text('前 Y'),
      text('後 X'),
      text('後 Y'),
      text('計算 X'),
      text('計算 Y'),
      text('残差 X'),
      text('残差 Y'),
    ],
  ];

  // パラメータは下に置くが、数式から参照するので先に行番号を決めておく
  const dataFirst = HEADER_ROWS + 1;
  const dataLast = HEADER_ROWS + rows.length;
  const paramRow = dataLast + 2; // 空行を 1 つ挟む
  const aRef = `$B$${paramRow + 1}`;
  const bRef = `$B$${paramRow + 2}`;
  const cRef = `$B$${paramRow + 3}`;
  const dRef = `$B$${paramRow + 4}`;

  rows.forEach((r, i) => {
    const excelRow = i + dataFirst;
    const cells: Cell[] = [
      text(r.name),
      cellFromText(r.sx),
      cellFromText(r.sy),
      cellFromText(r.tx),
      cellFromText(r.ty),
    ];
    if (h) {
      // 計算 X = A·x − B·y + C 、計算 Y = B·x + A·y + D
      cells.push(formula(`${aRef}*B${excelRow}-${bRef}*C${excelRow}+${cRef}`));
      cells.push(formula(`${bRef}*B${excelRow}+${aRef}*C${excelRow}+${dRef}`));
      cells.push(formula(`F${excelRow}-D${excelRow}`));
      cells.push(formula(`G${excelRow}-E${excelRow}`));
    }
    out.push(cells);
  });

  out.push([]);
  if (h) {
    out.push([text('ヘルマート変換のパラメータ')]);
    out.push([text('A（= 倍率 × cosθ）'), num(h.a)]);
    out.push([text('B（= 倍率 × sinθ）'), num(h.b)]);
    out.push([text('C（X の移動）'), num(h.c)]);
    out.push([text('D（Y の移動）'), num(h.d)]);
    out.push([text('倍率'), formula(`SQRT(${aRef}^2+${bRef}^2)`)]);
    out.push([text('回転角（度）'), formula(`DEGREES(ATAN2(${aRef},${bRef}))`)]);
    const res = residuals(points, (x, y) => helmertApply(h, x, y));
    out.push([text('残差 最大'), num(res.max)]);
    out.push([text('残差 RMS'), num(res.rms)]);
    out.push([text('共通点の数'), num(points.length)]);
  } else {
    out.push([
      text(
        points.length < 2
          ? `共通点が ${points.length} 点。ヘルマートには 2 点以上が要ります`
          : '共通点が 1 か所に固まっているため解けません',
      ),
    ]);
  }
  if (skipped > 0) out.push([text(`数値がそろっていない行が ${skipped} 件あり、計算から外しました`)]);

  return { name: '座標変換', rows: out };
}

/** 文字列のセル値を、数値に見えるなら数値として入れる（Excel で計算に使えるように）。 */
function cellFromText(s: string): Cell {
  const t = s.trim();
  if (t === '') return EMPTY;
  const v = Number(t);
  return Number.isFinite(v) ? num(v) : text(s);
}

/**
 * レベルと座標変換の帳票を 1 冊にまとめて `.xlsx` のバイト列にする。
 * **中身のあるシートだけ**入れる（空のシートを開かせない）。
 */
export async function writeSurveyReport(
  level: readonly LevelRow[],
  transform: readonly TransformRow[],
): Promise<Uint8Array> {
  const sheets: Sheet[] = [];
  if (level.length > 0) sheets.push(levelSheet(level));
  if (transform.length > 0) sheets.push(transformSheet(transform));
  if (sheets.length === 0) throw new Error('レベルも座標変換も入っていません');
  return writeXlsx(sheets);
}

/** 帳票の既定のファイル名。 */
export function defaultReportFileName(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  return `測量帳票-${stamp}.xlsx`;
}
