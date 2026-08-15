/**
 * DXF 書出（UTF-8 / R2007 = AC1021）。
 *
 * 読込は `dxf.ts`。**属性の対応は往復で一致するように決めている**:
 *
 * | Tr-CAD2w | DXF | 読み直したとき |
 * |---|---|---|
 * | `color: null`（ByLayer） | `62 256` | `null` |
 * | `color` が ACI で厳密に表せる | `62` のみ（**`420` は出さない**） | 同じ色 |
 * | `color` がそれ以外 | `420`（厳密）＋ `62`（近似・互換用） | 同じ `#rrggbb` |
 * | `lineStyle: 'solid'` | `6 BYLAYER` | `'solid'` |
 * | `lineStyle: 破線など` | `6 DASHED` など | 同じ線種 |
 * | `lineWidth: 0`（極細） | 図形は `370 -1`（ByLayer）／画層は `370 -3`（既定） | `0` |
 * | `lineWidth: 0.5` | `370 50`（mm×100・**列挙値へスナップ**） | `0.5` |
 *
 * **ACI 7 に `420` を併記してはいけない。** 色 7 は「背景に応じて白/黒」という
 * 意味で、どんな RGB でも表現できない。`#ffffff` を `420` で出すと、白背景の
 * CAD で図形が消える（`VB_BLACK` は内部で `#ffffff` なので全図形が該当しうる）。
 *
 * **落ちる情報**: 複数行文字の `vAlign: 'baseline'`。MTEXT のアタッチメントに
 * ベースラインが無いため `top` として出る（1 行の文字は TEXT なので保たれる）。
 *
 * Shift-JIS（ANSI_932）出力は #4 で判断するまで持たない。ブラウザの `TextEncoder`
 * は UTF-8 固定なので、素朴には書けない。
 */

import type { DocumentJson } from '../core/document.js';
import type { Entity, LineStyleName, TextEntity } from '../core/entity.js';
import { entityBounds, rectCorners } from '../core/entity.js';
import { hatchSegments } from '../core/hatch.js';
import { explodeInsert, type BlockDef } from '../core/block.js';
import { DEFAULT_POINT_STYLE } from '../core/point-style.js';
import { dimExplode } from '../core/dim-geom.js';
import type { Layer } from '../core/layer.js';
import { parseColor, type Rgb } from '../core/layer.js';
import { EMPTY_AABB, aabbUnion, deg } from '../core/geometry.js';
import { patternInMm } from '../render/linetype.js';
import { ACI_EXACT, aciToColor } from './dxf.js';

/** 線種名（DXF 側）。読込の `lineStyleOfName` が拾える名前にする。 */
const LINETYPE_NAME: Record<LineStyleName, string> = {
  solid: 'CONTINUOUS',
  dashed: 'DASHED',
  dotted: 'DOT',
  dashdot: 'DASHDOT',
  center: 'CENTER',
};

const LINETYPE_DESCRIPTION: Record<LineStyleName, string> = {
  solid: 'Solid line',
  dashed: 'Dashed __ __ __ __ __ __',
  dotted: 'Dot . . . . . . . . . .',
  dashdot: 'Dash dot __ . __ . __ .',
  center: 'Center ____ _ ____ _ __',
};

/** 文字スタイル名。日本語が出るよう TrueType を指定する（`txt.shx` だと他CADで `?` になる）。 */
const TEXT_STYLE = 'STANDARD';
const TEXT_STYLE_FONT = 'msgothic.ttf';

/** DXF に出す実数。整数にも小数点を付ける（AutoCAD の慣習）。指数表記は出さない。 */
export function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return '0.0';
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return `${v}.0`;
  const s = String(v);
  // 1e-7 のような指数表記は DXF リーダーが解せないことがあるので固定小数へ
  return s.includes('e') || s.includes('E') ? v.toFixed(12).replace(/0+$/, '0') : s;
}

// ---- 色 ------------------------------------------------------------------

/** その色が ACI で**厳密に**表せるなら ACI、表せないなら null。 */
export function aciExactFor(hex: string): number | null {
  const target = hex.trim().toLowerCase();
  for (const [aci, value] of Object.entries(ACI_EXACT)) {
    if (value.toLowerCase() === target) return Number(aci);
  }
  return null;
}

/**
 * `#rrggbb` → 近似 ACI。**厳密な色は `420` で出すので、これは互換用の近似。**
 * 1〜255 を総当たりし、**有彩色は灰色系（8/9/250〜254）へ吸着させない**
 * （色基準のプロット設定が壊れるため）。
 */
export function colorToAci(hex: string): number {
  const exact = aciExactFor(hex);
  if (exact !== null) return exact;

  const rgb = parseColor(hex);
  if (!rgb) return 7;
  const chromatic = !(rgb.r === rgb.g && rgb.g === rgb.b);
  const GRAYS = new Set([8, 9, 250, 251, 252, 253, 254]);

  let best = 7;
  let bestDist = Infinity;
  for (let aci = 1; aci <= 255; aci++) {
    if (chromatic && GRAYS.has(aci)) continue;
    const c = parseColor(aciToColor(aci));
    if (!c) continue;
    const d = dist2(rgb, c);
    if (d < bestDist) {
      bestDist = d;
      best = aci;
    }
  }
  return best;
}

function dist2(a: Rgb, b: Rgb): number {
  return (a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2;
}

/** `#rrggbb` → トゥルーカラー(`420`) の 24bit 整数。 */
export function colorToTrueColor(hex: string): number {
  const c = parseColor(hex);
  return c ? (c.r << 16) | (c.g << 8) | c.b : 0;
}

// ---- 線幅 ----------------------------------------------------------------

/** DXF が許す線幅の列挙値（mm×100）。 */
const LINEWEIGHTS = [
  0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211,
];

/** 任意の mm を DXF の線幅列挙値へスナップする（列挙外の値はリーダーに弾かれる）。 */
export function snapLineWeight(hundredths: number): number {
  let best = LINEWEIGHTS[0]!;
  let bestDist = Infinity;
  for (const v of LINEWEIGHTS) {
    const d = Math.abs(v - hundredths);
    if (d < bestDist) {
      bestDist = d;
      best = v;
    }
  }
  return best;
}

/** 図形の線幅（mm）→ `370`。0 は ByLayer(-1)。 */
export function lineWeightFromMm(mm: number): number {
  return mm > 0 ? snapLineWeight(Math.round(mm * 100)) : -1;
}

/**
 * **画層の**線幅（mm）→ `370`。0 は既定(-3)。
 * 画層に ByLayer(-1) は存在しない（-1/-2 は図形専用）。
 */
export function layerLineWeightFromMm(mm: number): number {
  return mm > 0 ? snapLineWeight(Math.round(mm * 100)) : -3;
}

/** ラジアン → 度（0〜360 に正規化）。 */
export function angleToDegrees(rad: number): number {
  const d = deg(rad) % 360;
  return d < 0 ? d + 360 : d;
}

function norm2pi(a: number): number {
  const t = a % (Math.PI * 2);
  return t < 0 ? t + Math.PI * 2 : t;
}

// ---- 文字列の安全化 ------------------------------------------------------

/**
 * 名前（画層名・スタイル名）を DXF で安全な形へ。
 *
 * **改行が入ると (コード行, 値行) の対がずれ、以降の DXF 全体が壊れる。**
 * DXF が名前に許さない文字もまとめて潰す。書出側の複数箇所で**同じ関数**を
 * 通すこと（画層テーブルと図形で違う名前になると画層が解決できない）。
 */
export function sanitizeName(name: string): string {
  const s = name.replace(/[\r\n\t]+/g, '_').replace(/[<>/\\":;?*|=`]/g, '_');
  return s === '' ? '0' : s;
}

/**
 * `TEXT`（1 行）の値。改行は空白へ潰し、`°` `±` `Ø` を制御表記へ。
 * 読込の `unescapeDxfText` と対になる。
 */
export function escapeDxfText(s: string): string {
  return s
    .replace(/[\r\n]+/g, ' ')
    .replace(/°/g, '%%d')
    .replace(/±/g, '%%p')
    .replace(/Ø/g, '%%c');
}

/**
 * `MTEXT` の本文。**順序が重要**: バックスラッシュ → 波括弧 → 改行。
 *
 * MTEXT では `\` が書式コードの開始、`{}` がグループ化の記号なので、素の文字は
 * エスケープしないと他CADで**文字が化ける・丸ごと消える**。`°` などは MTEXT では
 * Unicode のまま出す（`%%` 表記は本来 TEXT 用で、MTEXT での扱いは実装差がある）。
 */
export function escapeMText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\n/g, '\\P');
}

/** 書き出し行を組み立てる小さな入れ物。 */
class DxfWriter {
  private readonly lines: string[] = [];
  private nextHandle = 0x100;

  pair(code: number, value: string | number): void {
    if (typeof value === 'number') {
      this.lines.push(String(code), formatNumber(value));
      return;
    }
    // 値に生の改行が残ると行対がずれて DXF 全体が壊れる。最後の砦
    this.lines.push(String(code), value.replace(/[\r\n]+/g, ' '));
  }

  int(code: number, value: number): void {
    this.lines.push(String(code), String(Math.round(value)));
  }

  /** 新しいハンドル（16進大文字）。 */
  handle(): string {
    return (this.nextHandle++).toString(16).toUpperCase();
  }

  get handleSeed(): string {
    return (this.nextHandle + 16).toString(16).toUpperCase();
  }

  text(): string {
    return this.lines.join('\n') + '\n';
  }
}

/** 相互参照するハンドル。テーブルと OBJECTS が互いを指すので先に確保する。 */
interface Handles {
  rootDict: string;
  groupDict: string;
  layoutDict: string;
  modelLayout: string;
  paperLayout: string;
  modelBlockRecord: string;
  paperBlockRecord: string;
  paperBlockRecord0: string;
}

/** 図面を DXF テキスト（UTF-8 / R2007）へ。 */
export function documentToDxf(json: DocumentJson): string {
  const body = new DxfWriter();
  const h: Handles = {
    rootDict: body.handle(),
    groupDict: body.handle(),
    layoutDict: body.handle(),
    modelLayout: body.handle(),
    paperLayout: body.handle(),
    modelBlockRecord: body.handle(),
    paperBlockRecord: body.handle(),
    paperBlockRecord0: body.handle(),
  };

  // 挿入は中身へ展開してから出す（DXF の BLOCK/INSERT は作らない。
  // 受け側で見た目が変わらないよう、実体だけを渡す割り切り）
  const flat = flattenInserts(json);

  writeTables(body, json, h);
  writeBlocks(body);
  writeEntities(body, flat);
  writeObjects(body, h);

  // $HANDSEED はハンドルを使い切ってからでないと決まらないので HEADER は最後に組む
  const head = new DxfWriter();
  writeHeader(head, json, body.handleSeed);

  return head.text() + body.text() + ['0', 'EOF', ''].join('\n');
}

/** 挿入をブロック定義から展開して並べる（定義が無い挿入は落ちる）。 */
function flattenInserts(json: DocumentJson): Entity[] {
  const blocks = json.blocks ?? [];
  if (blocks.length === 0) return json.entities.filter((e) => e.kind !== 'insert');
  const src = { getBlock: (name: string): BlockDef | undefined => blocks.find((b) => b.name === name) };
  const out: Entity[] = [];
  for (const e of json.entities) {
    if (e.kind === 'insert') out.push(...explodeInsert(src, e));
    else out.push(e);
  }
  return out;
}

function writeHeader(w: DxfWriter, json: DocumentJson, handleSeed: string): void {
  const box = flattenInserts(json).reduce((acc, e) => aabbUnion(acc, entityBounds(e)), EMPTY_AABB);
  const hasExtents = box.minX <= box.maxX;

  w.pair(0, 'SECTION');
  w.pair(2, 'HEADER');
  w.pair(9, '$ACADVER');
  w.pair(1, 'AC1021'); // R2007。UTF-8 が使えるのはこの版から
  w.pair(9, '$HANDSEED');
  w.pair(5, handleSeed);
  w.pair(9, '$INSUNITS');
  w.int(70, 4); // 4 = ミリメートル
  w.pair(9, '$LTSCALE');
  w.pair(40, json.lineTypeScale);
  // 点の表示スタイル（AutoCAD と同じ意味。0 は画面固定サイズ）
  w.pair(9, '$PDMODE');
  w.int(70, json.pointStyle?.mode ?? DEFAULT_POINT_STYLE.mode);
  w.pair(9, '$PDSIZE');
  w.pair(40, json.pointStyle?.size ?? DEFAULT_POINT_STYLE.size);
  w.pair(9, '$CLAYER');
  w.pair(8, '0');
  w.pair(9, '$CECOLOR');
  w.int(62, 256); // ByLayer
  w.pair(9, '$CELTYPE');
  w.pair(6, 'BYLAYER');
  w.pair(9, '$TEXTSTYLE');
  w.pair(7, TEXT_STYLE);
  w.pair(9, '$MEASUREMENT');
  w.int(70, 1); // メートル法
  if (hasExtents) {
    w.pair(9, '$EXTMIN');
    w.pair(10, box.minX);
    w.pair(20, box.minY);
    w.pair(30, 0);
    w.pair(9, '$EXTMAX');
    w.pair(10, box.maxX);
    w.pair(20, box.maxY);
    w.pair(30, 0);
  }
  w.pair(0, 'ENDSEC');
}

// ---- TABLES --------------------------------------------------------------

function writeTables(w: DxfWriter, json: DocumentJson, h: Handles): void {
  w.pair(0, 'SECTION');
  w.pair(2, 'TABLES');
  // R2000 以降のリーダーはこの一式が揃っている前提で読む。空でも出す
  writeVportTable(w);
  writeLtypeTable(w);
  writeLayerTable(w, json.layers);
  writeStyleTable(w);
  writeSimpleTable(w, 'VIEW');
  writeSimpleTable(w, 'UCS');
  writeAppIdTable(w);
  writeDimStyleTable(w);
  writeBlockRecordTable(w, h);
  w.pair(0, 'ENDSEC');
}

function tableHead(w: DxfWriter, name: string, count: number): void {
  w.pair(0, 'TABLE');
  w.pair(2, name);
  w.pair(5, w.handle());
  w.pair(100, 'AcDbSymbolTable');
  w.int(70, count);
}

/** 中身の無いテーブル（VIEW / UCS）。存在しないとレイアウト解決に失敗する CAD がある。 */
function writeSimpleTable(w: DxfWriter, name: string): void {
  tableHead(w, name, 0);
  w.pair(0, 'ENDTAB');
}

function writeVportTable(w: DxfWriter): void {
  tableHead(w, 'VPORT', 1);
  w.pair(0, 'VPORT');
  w.pair(5, w.handle());
  w.pair(100, 'AcDbSymbolTableRecord');
  w.pair(100, 'AcDbViewportTableRecord');
  w.pair(2, '*Active');
  w.int(70, 0);
  w.pair(10, 0);
  w.pair(20, 0);
  w.pair(11, 1);
  w.pair(21, 1);
  w.pair(12, 0);
  w.pair(22, 0);
  w.pair(13, 0);
  w.pair(23, 0);
  w.pair(14, 10);
  w.pair(24, 10);
  w.pair(15, 10);
  w.pair(25, 10);
  w.pair(16, 0);
  w.pair(26, 0);
  w.pair(36, 1);
  w.pair(17, 0);
  w.pair(27, 0);
  w.pair(37, 0);
  w.pair(40, 1000);
  w.pair(41, 1.5);
  w.pair(42, 50);
  w.pair(43, 0);
  w.pair(44, 0);
  w.pair(50, 0);
  w.pair(51, 0);
  w.int(71, 0);
  w.int(72, 100);
  w.int(73, 1);
  w.int(74, 3);
  w.int(75, 0);
  w.int(76, 0);
  w.int(77, 0);
  w.int(78, 0);
  w.pair(0, 'ENDTAB');
}

function writeAppIdTable(w: DxfWriter): void {
  tableHead(w, 'APPID', 1);
  w.pair(0, 'APPID');
  w.pair(5, w.handle());
  w.pair(100, 'AcDbSymbolTableRecord');
  w.pair(100, 'AcDbRegAppTableRecord');
  w.pair(2, 'ACAD');
  w.int(70, 0);
  w.pair(0, 'ENDTAB');
}

function writeDimStyleTable(w: DxfWriter): void {
  w.pair(0, 'TABLE');
  w.pair(2, 'DIMSTYLE');
  w.pair(5, w.handle());
  w.pair(100, 'AcDbSymbolTable');
  w.int(70, 1);
  w.pair(100, 'AcDbDimStyleTable');
  w.int(71, 0);
  w.pair(0, 'DIMSTYLE');
  w.pair(105, w.handle()); // DIMSTYLE だけハンドルのコードが 105
  w.pair(100, 'AcDbSymbolTableRecord');
  w.pair(100, 'AcDbDimStyleTableRecord');
  w.pair(2, 'Standard');
  w.int(70, 0);
  w.pair(0, 'ENDTAB');
}

const LINE_STYLES: LineStyleName[] = ['solid', 'dashed', 'dotted', 'dashdot', 'center'];

function writeLtypeTable(w: DxfWriter): void {
  tableHead(w, 'LTYPE', LINE_STYLES.length + 2);

  // ByLayer / ByBlock は AutoCAD が要求する予約エントリ
  for (const name of ['ByLayer', 'ByBlock']) {
    w.pair(0, 'LTYPE');
    w.pair(5, w.handle());
    w.pair(100, 'AcDbSymbolTableRecord');
    w.pair(100, 'AcDbLinetypeTableRecord');
    w.pair(2, name);
    w.int(70, 0);
    w.pair(3, '');
    w.int(72, 65);
    w.int(73, 0);
    w.pair(40, 0);
  }

  for (const style of LINE_STYLES) {
    // 刻みは線種尺度 1 のときの mm 定義（実際の刻みは $LTSCALE で決まる）
    const pattern = patternInMm(style, 1);
    w.pair(0, 'LTYPE');
    w.pair(5, w.handle());
    w.pair(100, 'AcDbSymbolTableRecord');
    w.pair(100, 'AcDbLinetypeTableRecord');
    w.pair(2, LINETYPE_NAME[style]);
    w.int(70, 0);
    w.pair(3, LINETYPE_DESCRIPTION[style]);
    w.int(72, 65); // 'A' 揃え
    w.int(73, pattern.length);
    w.pair(40, pattern.reduce((a, b) => a + Math.abs(b), 0));
    for (let i = 0; i < pattern.length; i++) {
      // 線は正、空きは負、点は 0。定義は「線→空き→線→空き…」の順
      const v = pattern[i]!;
      w.pair(49, i % 2 === 0 ? v : -v);
      w.int(74, 0);
    }
  }
  w.pair(0, 'ENDTAB');
}

function writeLayerTable(w: DxfWriter, layers: readonly Layer[]): void {
  tableHead(w, 'LAYER', layers.length);
  for (const layer of layers) {
    const exact = aciExactFor(layer.color);
    const aci = exact ?? colorToAci(layer.color);
    w.pair(0, 'LAYER');
    w.pair(5, w.handle());
    w.pair(100, 'AcDbSymbolTableRecord');
    w.pair(100, 'AcDbLayerTableRecord');
    w.pair(2, sanitizeName(layer.name));
    w.int(70, 0);
    // 非表示の画層は ACI を負で出す（AutoCAD の約束。読込も同じ判定）
    w.int(62, layer.visible ? aci : -aci);
    // ACI で厳密に表せる色に 420 を併記しない（色 7 が純白に固定され、
    // 白背景の CAD で図形が消える）
    if (exact === null) w.int(420, colorToTrueColor(layer.color));
    w.pair(6, LINETYPE_NAME[layer.lineStyle]);
    w.int(370, layerLineWeightFromMm(layer.lineWidth));
  }
  w.pair(0, 'ENDTAB');
}

function writeStyleTable(w: DxfWriter): void {
  tableHead(w, 'STYLE', 1);
  w.pair(0, 'STYLE');
  w.pair(5, w.handle());
  w.pair(100, 'AcDbSymbolTableRecord');
  w.pair(100, 'AcDbTextStyleTableRecord');
  w.pair(2, TEXT_STYLE);
  w.int(70, 0);
  w.pair(40, 0); // 高さ 0 = 図形ごとに指定
  w.pair(41, 1);
  w.pair(50, 0);
  w.int(71, 0);
  w.pair(42, 2.5);
  // TrueType にしないと日本語が他CADで `?` になる（txt.shx にビッグフォントが無いため）
  w.pair(3, TEXT_STYLE_FONT);
  w.pair(4, '');
  w.pair(0, 'ENDTAB');
}

function writeBlockRecordTable(w: DxfWriter, h: Handles): void {
  tableHead(w, 'BLOCK_RECORD', 3);
  const records: [string, string, string | null][] = [
    ['*Model_Space', h.modelBlockRecord, h.modelLayout],
    ['*Paper_Space', h.paperBlockRecord, h.paperLayout],
    ['*Paper_Space0', h.paperBlockRecord0, null],
  ];
  for (const [name, handle, layout] of records) {
    w.pair(0, 'BLOCK_RECORD');
    w.pair(5, handle);
    w.pair(100, 'AcDbSymbolTableRecord');
    w.pair(100, 'AcDbBlockTableRecord');
    w.pair(2, name);
    // レイアウトへのハードポインタ。これが無いと ODA 系のインポータが
    // レイアウトを解決できず読込を中断する
    if (layout) w.pair(340, layout);
  }
  w.pair(0, 'ENDTAB');
}

// ---- BLOCKS / ENTITIES / OBJECTS ----------------------------------------

/** モデル空間・用紙空間の空ブロック（R2000 以降は無いと開けない CAD がある）。 */
function writeBlocks(w: DxfWriter): void {
  w.pair(0, 'SECTION');
  w.pair(2, 'BLOCKS');
  for (const name of ['*Model_Space', '*Paper_Space']) {
    w.pair(0, 'BLOCK');
    w.pair(5, w.handle());
    w.pair(100, 'AcDbEntity');
    w.pair(8, '0');
    w.pair(100, 'AcDbBlockBegin');
    w.pair(2, name);
    w.int(70, 0);
    w.pair(10, 0);
    w.pair(20, 0);
    w.pair(30, 0);
    w.pair(3, name);
    w.pair(1, '');
    w.pair(0, 'ENDBLK');
    w.pair(5, w.handle());
    w.pair(100, 'AcDbEntity');
    w.pair(8, '0');
    w.pair(100, 'AcDbBlockEnd');
  }
  w.pair(0, 'ENDSEC');
}

/** 名前付きオブジェクト辞書とレイアウト。R2000 以降のリーダーはこれを探す。 */
function writeObjects(w: DxfWriter, h: Handles): void {
  w.pair(0, 'SECTION');
  w.pair(2, 'OBJECTS');

  w.pair(0, 'DICTIONARY');
  w.pair(5, h.rootDict);
  w.pair(100, 'AcDbDictionary');
  w.int(281, 1);
  w.pair(3, 'ACAD_GROUP');
  w.pair(350, h.groupDict);
  w.pair(3, 'ACAD_LAYOUT');
  w.pair(350, h.layoutDict);

  w.pair(0, 'DICTIONARY');
  w.pair(5, h.groupDict);
  w.pair(330, h.rootDict);
  w.pair(100, 'AcDbDictionary');
  w.int(281, 1);

  w.pair(0, 'DICTIONARY');
  w.pair(5, h.layoutDict);
  w.pair(330, h.rootDict);
  w.pair(100, 'AcDbDictionary');
  w.int(281, 1);
  w.pair(3, 'Model');
  w.pair(350, h.modelLayout);
  w.pair(3, 'Layout1');
  w.pair(350, h.paperLayout);

  writeLayout(w, 'Model', h.modelLayout, h.layoutDict, h.modelBlockRecord, 0);
  writeLayout(w, 'Layout1', h.paperLayout, h.layoutDict, h.paperBlockRecord, 1);

  w.pair(0, 'ENDSEC');
}

function writeLayout(
  w: DxfWriter,
  name: string,
  handle: string,
  ownerDict: string,
  blockRecord: string,
  tabOrder: number,
): void {
  w.pair(0, 'LAYOUT');
  w.pair(5, handle);
  w.pair(330, ownerDict);
  w.pair(100, 'AcDbPlotSettings');
  w.pair(1, '');
  w.pair(2, '');
  w.pair(4, '');
  w.pair(6, '');
  w.pair(40, 0);
  w.pair(41, 0);
  w.pair(42, 0);
  w.pair(43, 0);
  w.pair(44, 210); // A4 の幅（mm）
  w.pair(45, 297);
  w.pair(46, 0);
  w.pair(47, 0);
  w.pair(48, 0);
  w.pair(49, 0);
  w.pair(140, 0);
  w.pair(141, 0);
  w.pair(142, 1);
  w.pair(143, 1);
  w.int(70, 688);
  w.int(72, 0);
  w.int(73, 1);
  w.int(74, 5);
  w.pair(7, '');
  w.int(75, 16);
  w.int(147, 1);
  w.pair(100, 'AcDbLayout');
  w.pair(1, name);
  w.int(70, 1);
  w.int(71, tabOrder);
  w.pair(10, 0);
  w.pair(20, 0);
  w.pair(11, 420);
  w.pair(21, 297);
  w.pair(12, 0);
  w.pair(22, 0);
  w.pair(32, 0);
  w.pair(14, 0);
  w.pair(24, 0);
  w.pair(34, 0);
  w.pair(15, 0);
  w.pair(25, 0);
  w.pair(35, 0);
  w.pair(146, 0);
  w.pair(13, 0);
  w.pair(23, 0);
  w.pair(33, 0);
  w.pair(16, 1);
  w.pair(26, 0);
  w.pair(36, 0);
  w.pair(17, 0);
  w.pair(27, 1);
  w.pair(37, 0);
  w.int(76, 0);
  w.pair(330, blockRecord);
}

function writeEntities(w: DxfWriter, entities: readonly Entity[]): void {
  w.pair(0, 'SECTION');
  w.pair(2, 'ENTITIES');
  for (const e of entities) writeEntity(w, e);
  w.pair(0, 'ENDSEC');
}

/** 図形共通の属性（画層・色・線種・線幅）。`type` の直後に置く。 */
function writeCommon(w: DxfWriter, e: Entity, subclass: string): void {
  w.pair(5, w.handle());
  w.pair(100, 'AcDbEntity');
  w.pair(8, sanitizeName(e.layer));
  if (e.color === null) {
    w.int(62, 256); // ByLayer
  } else {
    const exact = aciExactFor(e.color);
    w.int(62, exact ?? colorToAci(e.color));
    // ACI 7 などに 420 を併記しない（純白に固定され白背景の CAD で消える）
    if (exact === null) w.int(420, colorToTrueColor(e.color));
  }
  // 'solid' は「画層に従う」の意味なので BYLAYER で出す（往復で一致する）
  w.pair(6, e.lineStyle === 'solid' ? 'BYLAYER' : LINETYPE_NAME[e.lineStyle]);
  w.int(370, lineWeightFromMm(e.lineWidth));
  w.pair(100, subclass);
}

function writeEntity(w: DxfWriter, e: Entity): void {
  switch (e.kind) {
    case 'line':
      w.pair(0, 'LINE');
      writeCommon(w, e, 'AcDbLine');
      w.pair(10, e.a.x);
      w.pair(20, e.a.y);
      w.pair(30, 0);
      w.pair(11, e.b.x);
      w.pair(21, e.b.y);
      w.pair(31, 0);
      break;

    case 'circle':
      writeCircle(w, e, e.center.x, e.center.y, e.radius);
      break;

    case 'arc': {
      // 掃引ゼロは内部表現では「全円」。DXF の ARC に全円は無いので CIRCLE で出す
      // （50 == 51 の ARC は退化エンティティとして他CADに捨てられる）
      const sweep = norm2pi(e.endAngle - e.startAngle);
      if (sweep < 1e-9) {
        writeCircle(w, e, e.center.x, e.center.y, e.radius);
        break;
      }
      w.pair(0, 'ARC');
      writeCommon(w, e, 'AcDbCircle');
      w.pair(10, e.center.x);
      w.pair(20, e.center.y);
      w.pair(30, 0);
      w.pair(40, e.radius);
      w.pair(100, 'AcDbArc');
      w.pair(50, angleToDegrees(e.startAngle));
      w.pair(51, angleToDegrees(e.endAngle));
      break;
    }

    case 'point':
      w.pair(0, 'POINT');
      writeCommon(w, e, 'AcDbPoint');
      w.pair(10, e.at.x);
      w.pair(20, e.at.y);
      w.pair(30, 0);
      break;

    case 'rect': {
      // 矩形は閉じた LWPOLYLINE として出す（DXF に矩形は無い）
      const pts = [
        { x: e.a.x, y: e.a.y },
        { x: e.b.x, y: e.a.y },
        { x: e.b.x, y: e.b.y },
        { x: e.a.x, y: e.b.y },
      ];
      writeLwPolyline(w, e, pts, true);
      break;
    }

    case 'polyline':
      writeLwPolyline(w, e, e.points, e.closed);
      break;

    case 'text':
      if (e.text.includes('\n') || e.text.includes('\r')) writeMText(w, e);
      else writeText(w, e);
      break;

    case 'hatch': {
      // DXF の HATCH は境界とパターン定義が要り、受け側で見た目が変わりやすい。
      // **境界＋走査線を実体で出す**（デスクトップ版も同じ割り切り）
      writeLwPolyline(w, e, e.points, true);
      for (const [a, b] of hatchSegments(e)) {
        w.pair(0, 'LINE');
        writeCommon(w, e, 'AcDbLine');
        w.pair(10, a.x);
        w.pair(20, a.y);
        w.pair(30, 0);
        w.pair(11, b.x);
        w.pair(21, b.y);
        w.pair(31, 0);
      }
      break;
    }

    case 'image':
      // ラスタ画像は DXF に埋め込めない（IMAGEDEF は外部ファイル参照）。
      // 外部ファイルを作らない方針なので、配置枠だけを出す
      writeLwPolyline(w, e, rectCorners({ ...e, kind: 'rect' }), true);
      break;

    case 'insert':
      // `documentToDxf` が先に展開している（ここへは来ない）
      break;

    case 'dim':
      // DXF の DIMENSION は寸法スタイル（DIMSTYLE）で見た目が変わるので、
      // **見たままを渡せる線分・矢印・文字へ分解して出す**（デスクトップ版と同じ判断）
      for (const part of dimExplode(e)) writeEntity(w, { ...part, id: e.id } as Entity);
      break;
  }
}

function writeCircle(w: DxfWriter, e: Entity, x: number, y: number, radius: number): void {
  w.pair(0, 'CIRCLE');
  writeCommon(w, e, 'AcDbCircle');
  w.pair(10, x);
  w.pair(20, y);
  w.pair(30, 0);
  w.pair(40, radius);
}

function writeLwPolyline(
  w: DxfWriter,
  e: Entity,
  points: readonly { x: number; y: number }[],
  closed: boolean,
): void {
  if (points.length < 2) return;
  w.pair(0, 'LWPOLYLINE');
  writeCommon(w, e, 'AcDbPolyline');
  w.int(90, points.length);
  w.int(70, closed ? 1 : 0);
  w.pair(43, 0); // 一定幅 0
  for (const p of points) {
    w.pair(10, p.x);
    w.pair(20, p.y);
  }
}

const H_CODE: Record<TextEntity['hAlign'], number> = { left: 0, center: 1, right: 2 };
const V_CODE: Record<TextEntity['vAlign'], number> = { baseline: 0, bottom: 1, middle: 2, top: 3 };

function writeText(w: DxfWriter, e: TextEntity): void {
  w.pair(0, 'TEXT');
  writeCommon(w, e, 'AcDbText');
  w.pair(10, e.at.x);
  w.pair(20, e.at.y);
  w.pair(30, 0);
  w.pair(40, e.height);
  w.pair(1, escapeDxfText(e.text));
  if (e.rotation !== 0) w.pair(50, angleToDegrees(e.rotation));
  w.pair(7, TEXT_STYLE);
  const h = H_CODE[e.hAlign];
  const v = V_CODE[e.vAlign];
  if (h !== 0) w.int(72, h);
  if (h !== 0 || v !== 0) {
    // 他CADは 72/73 が非 0 のとき 10/20 を無視して 11/21 を挿入点に使う
    w.pair(11, e.at.x);
    w.pair(21, e.at.y);
    w.pair(31, 0);
  }
  w.pair(100, 'AcDbText');
  if (v !== 0) w.int(73, v);
}

/**
 * MTEXT のアタッチメント（71）。
 * **ベースラインは MTEXT に無いので top として出す**（読み直すと top になる）。
 */
export function mtextAttachment(hAlign: TextEntity['hAlign'], vAlign: TextEntity['vAlign']): number {
  const row = vAlign === 'middle' ? 1 : vAlign === 'bottom' ? 2 : 0; // top / baseline → 上段
  const col = hAlign === 'center' ? 1 : hAlign === 'right' ? 2 : 0;
  return row * 3 + col + 1;
}

function writeMText(w: DxfWriter, e: TextEntity): void {
  w.pair(0, 'MTEXT');
  writeCommon(w, e, 'AcDbMText');
  w.pair(10, e.at.x);
  w.pair(20, e.at.y);
  w.pair(30, 0);
  w.pair(40, e.height);
  w.pair(41, 0); // 折り返し幅 0 = 折り返さない
  w.int(71, mtextAttachment(e.hAlign, e.vAlign));
  w.int(72, 5); // 行方向: 左から右
  writeMTextContent(w, escapeMText(e.text));
  w.pair(7, TEXT_STYLE);
  w.pair(50, angleToDegrees(e.rotation));
}

/**
 * MTEXT の本文は 250 文字ごとに `3` へ分け、**最後の断片を `1`** に置く。
 *
 * 分割は**コードポイント境界**で行う。UTF-16 のサロゲートペアを割ると、
 * UTF-8 に符号化した時点で U+FFFD に化ける（絵文字・一部の漢字が壊れる）。
 */
function writeMTextContent(w: DxfWriter, body: string): void {
  const CHUNK = 250;
  const codePoints = Array.from(body);
  const chunks: string[] = [];
  for (let i = 0; i < codePoints.length; i += CHUNK) {
    chunks.push(codePoints.slice(i, i + CHUNK).join(''));
  }
  if (chunks.length === 0) chunks.push('');
  for (let i = 0; i < chunks.length - 1; i++) w.pair(3, chunks[i]!);
  w.pair(1, chunks[chunks.length - 1]!);
}

/** 既定の保存名。`図面-20260814-1530.dxf` の形。 */
export function defaultDxfFileName(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  return `図面-${stamp}.dxf`;
}
