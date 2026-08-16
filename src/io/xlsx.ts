/**
 * 最小限の `.xlsx` 書き出し（issue #29）。
 *
 * `.xlsx` は **ZIP の中に XML が数ファイル入っているだけ**なので、`.tc2` 用に
 * 作った `zip.ts` がそのまま使える。**実行時依存は増えない。**
 *
 * ## 入れるファイル
 *
 * | パート | 役割 |
 * |---|---|
 * | `[Content_Types].xml` | 各パートの MIME |
 * | `_rels/.rels` | 入口（workbook を指す） |
 * | `xl/workbook.xml` | シート一覧 |
 * | `xl/_rels/workbook.xml.rels` | workbook → 各シート |
 * | `xl/worksheets/sheetN.xml` | セルの値と数式 |
 *
 * 文字列は**インライン文字列**（`t="inlineStr"`）で書く。共有文字列表
 * （`sharedStrings.xml`）を使わないぶん少し冗長だが、パートが 1 つ減り、
 * 索引のずれで壊れる余地も消える。
 *
 * ## 共有数式を使わない
 *
 * デスクトップ版 TrCad2D で **Excel の修復ダイアログが出る不具合**があり、原因は
 * **共有数式（`t="shared"`）が親を失って孤立すること**だった。ここでは最初から
 * **1 セルずつ通常数式**で書く。冗長でも壊れない方を採る。
 *
 * ## 計算結果は入れない
 *
 * 数式セルに `<v>` を書かない。Excel は開いたときに計算して埋める。中途半端な
 * キャッシュ値を書くと、式と値が食い違ったときに修復対象になる。
 */

import { zip } from './zip.js';

/** セル 1 つ。 */
export type Cell =
  | { kind: 'text'; value: string }
  | { kind: 'number'; value: number }
  /** 数式。`=` は付けない（`SUM(A1:A3)` のように書く）。 */
  | { kind: 'formula'; value: string }
  | { kind: 'empty' };

export function text(value: string): Cell {
  return { kind: 'text', value };
}

export function num(value: number): Cell {
  return { kind: 'number', value };
}

export function formula(value: string): Cell {
  return { kind: 'formula', value };
}

export const EMPTY: Cell = { kind: 'empty' };

export interface Sheet {
  /** シート名。Excel の制限に合わせて整える。 */
  name: string;
  /** 行の並び（行ごとにセルの配列）。 */
  rows: Cell[][];
}

/** XML のテキストとして安全な形へ。**属性値にも使うので `"` も潰す。** */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // 制御文字は XML 1.0 に入れられない（タブ・改行は残す）
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/**
 * 列番号（0 始まり）→ `A` `B` … `Z` `AA` の列名。
 * 26 進だが 0 が無い（`Z` の次が `AA`）ので、素朴な進数変換では合わない。
 */
export function columnName(index: number): string {
  let n = index;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** セルの番地（`A1` は行 0・列 0）。 */
export function cellRef(row: number, col: number): string {
  return `${columnName(col)}${row + 1}`;
}

/**
 * シート名を Excel が許す形へ。
 *
 * 使えない文字（`: \ / ? * [ ]`）を `_` にし、31 文字までに切る。空なら `Sheet`。
 * **ここを通さないと Excel が「修復しました」と言って名前を変える。**
 */
export function sanitizeSheetName(name: string): string {
  const s = name.replace(/[:\\/?*[\]]/g, '_').slice(0, 31);
  return s.trim() === '' ? 'Sheet' : s;
}

function cellXml(row: number, col: number, cell: Cell): string {
  const ref = cellRef(row, col);
  switch (cell.kind) {
    case 'empty':
      return '';
    case 'number':
      // 有限でない値は Excel が読めないので空にする
      return Number.isFinite(cell.value) ? `<c r="${ref}"><v>${cell.value}</v></c>` : '';
    case 'text':
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell.value)}</t></is></c>`;
    case 'formula':
      // <v> は書かない。Excel が開いたときに計算する
      return `<c r="${ref}"><f>${escapeXml(cell.value)}</f></c>`;
  }
}

function sheetXml(sheet: Sheet): string {
  const rows = sheet.rows
    .map((cells, r) => {
      const inner = cells.map((c, i) => cellXml(r, i, c)).join('');
      return inner === '' ? `<row r="${r + 1}"/>` : `<row r="${r + 1}">${inner}</row>`;
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${rows}</sheetData>` +
    '</worksheet>'
  );
}

function contentTypesXml(count: number): string {
  const overrides = Array.from(
    { length: count },
    (_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    overrides +
    '</Types>'
  );
}

function workbookXml(sheets: readonly Sheet[]): string {
  const list = sheets
    .map((s, i) => `<sheet name="${escapeXml(sanitizeSheetName(s.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${list}</sheets>` +
    '</workbook>'
  );
}

function workbookRelsXml(count: number): string {
  const rels = Array.from(
    { length: count },
    (_, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
  ).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`
  );
}

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '</Relationships>';

/** `.xlsx` のバイト列を作る。シートは 1 つ以上。 */
export async function writeXlsx(sheets: readonly Sheet[]): Promise<Uint8Array> {
  if (sheets.length === 0) throw new Error('シートが 1 つもありません');
  const enc = new TextEncoder();
  const entries = [
    { name: '[Content_Types].xml', bytes: enc.encode(contentTypesXml(sheets.length)) },
    { name: '_rels/.rels', bytes: enc.encode(ROOT_RELS) },
    { name: 'xl/workbook.xml', bytes: enc.encode(workbookXml(sheets)) },
    { name: 'xl/_rels/workbook.xml.rels', bytes: enc.encode(workbookRelsXml(sheets.length)) },
    ...sheets.map((s, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      bytes: enc.encode(sheetXml(s)),
    })),
  ];
  return zip(entries);
}
