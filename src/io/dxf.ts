/**
 * DXF 読込。
 *
 * DXF は「グループコード（整数）」と「値」が1行ずつ交互に並ぶテキスト形式。
 * まず全体を (code, value) の対へ分解し、SECTION 単位で処理する。
 *
 * 読める範囲（デスクトップ版 TrCad2D の `Dxf.cs` と同じところから始める）:
 *
 * | DXF | Tr-CAD2w |
 * |---|---|
 * | `LINE` `CIRCLE` `ARC` `POINT` | そのまま |
 * | `LWPOLYLINE` | `polyline`（バルジ 42 は無視＝直線として読む） |
 * | `POLYLINE` + `VERTEX` | `polyline`（旧形式） |
 * | `TEXT` | `text`（72/73 の揃え、揃え点 11/21） |
 * | `MTEXT` | `text`（改行 `\P`、アタッチメント 71 → 揃え） |
 *
 * 属性は 色 `62`(ACI) / `420`(トゥルーカラー) ・画層 `8` ・線種 `6` ・線幅 `370` を読む。
 * `420` があればそちらを優先する。
 */

import type { DocumentJson } from '../core/document.js';
import { DEFAULT_LINETYPE_SCALE, FILE_FORMAT_VERSION } from '../core/document.js';
import type { Entity, LineStyleName, NewEntity, TextEntity } from '../core/entity.js';
import type { Layer } from '../core/layer.js';
import { STANDARD_LAYERS, VB_BLACK, formatColor, makeLayer } from '../core/layer.js';
import { rad, vec, type Vec2 } from '../core/geometry.js';

// ---- 文字コードの判定 ----------------------------------------------------

/** `$DWGCODEPAGE` の値 → `TextDecoder` のラベル。 */
const CODEPAGE_TO_LABEL: Readonly<Record<string, string>> = {
  ANSI_932: 'shift_jis',
  ANSI_936: 'gbk',
  ANSI_949: 'euc-kr',
  ANSI_950: 'big5',
  ANSI_1250: 'windows-1250',
  ANSI_1251: 'windows-1251',
  ANSI_1252: 'windows-1252',
  ANSI_1253: 'windows-1253',
  ANSI_1254: 'windows-1254',
};

export interface DecodeResult {
  text: string;
  /** 実際に使ったデコーダのラベル。 */
  encoding: string;
  /** 何を根拠に決めたか（ログ・報告用）。 */
  reason: 'bom' | 'codepage' | 'utf8-valid' | 'fallback';
}

/**
 * DXF のバイト列を文字列へ。
 *
 * 判定は **BOM → `$DWGCODEPAGE` → UTF-8 妥当性** の順（デスクトップ版と同じ）。
 * `File.text()` は UTF-8 固定なので使わず、必ずバイト列から入る。
 */
export function decodeDxf(bytes: Uint8Array): DecodeResult {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8', reason: 'bom' };
  }

  // $DWGCODEPAGE を読むには先にデコードが必要なので、ASCII 相当（latin1）で
  // 先頭だけ覗く。コードページ名は ASCII なのでこれで足りる
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 8192)));
  const m = /\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*([A-Za-z0-9_]+)/.exec(head);
  const label = m ? CODEPAGE_TO_LABEL[m[1]!.toUpperCase()] : undefined;
  if (label) {
    return { text: new TextDecoder(label).decode(bytes), encoding: label, reason: 'codepage' };
  }

  try {
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      encoding: 'utf-8',
      reason: 'utf8-valid',
    };
  } catch {
    // UTF-8 として不正 → 日本語環境で最も多い Shift-JIS とみなす
    return { text: new TextDecoder('shift_jis').decode(bytes), encoding: 'shift_jis', reason: 'fallback' };
  }
}

// ---- トークン化 ----------------------------------------------------------

export interface DxfPair {
  code: number;
  value: string;
}

/** DXF テキストを (code, value) の対へ分解する。数値でないコード行は捨てる。 */
export function tokenize(text: string): DxfPair[] {
  const lines = text.split(/\r\n|\r|\n/);
  const out: DxfPair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number.parseInt(lines[i]!.trim(), 10);
    if (!Number.isFinite(code)) continue;
    out.push({ code, value: lines[i + 1]! });
  }
  return out;
}

// ---- 色 ------------------------------------------------------------------

/**
 * ACI（AutoCAD Color Index）→ `#rrggbb`。
 *
 * 1〜9 と 250〜255 は厳密な値。**10〜249 は色相環（24 色相 × 明度 10 段）からの
 * 近似**で、AutoCAD の実測値と数値までは一致しない。トゥルーカラー(`420`)がある
 * ファイルではそちらを優先するのでこの近似は効かない。
 */
export const ACI_EXACT: Readonly<Record<number, string>> = {
  1: '#ff0000',
  2: '#ffff00',
  3: '#00ff00',
  4: '#00ffff',
  5: '#0000ff',
  6: '#ff00ff',
  7: VB_BLACK, // 色 7 は「白/黒」。背景に応じて反転させるので白で持つ
  8: '#808080',
  9: '#c0c0c0',
  250: '#333333',
  251: '#505050',
  252: '#696969',
  253: '#828282',
  254: '#bebebe',
  255: '#ffffff',
};

export function aciToColor(aci: number): string {
  const exact = ACI_EXACT;
  const hit = exact[aci];
  if (hit) return hit;
  if (aci < 10 || aci > 249) return VB_BLACK;

  const i = aci - 10;
  const hue = (Math.floor(i / 10) * 15) % 360;
  const step = i % 10; // 0,1=明るい/濃い … 偶奇で彩度、段で明度
  const value = 1 - Math.floor(step / 2) * 0.18;
  const sat = step % 2 === 0 ? 1 : 0.5;
  return formatColor(hsvToRgb(hue, sat, Math.max(0.2, value)));
}

function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const c = v * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = v - c;
  return { r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255 };
}

/** トゥルーカラー(`420`) の 24bit 整数 → `#rrggbb`。 */
export function trueColorToHex(v: number): string {
  return formatColor({ r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 });
}

// ---- 線種 ----------------------------------------------------------------

/**
 * DXF の線種名 → Tr-CAD2w の線種。
 *
 * **刻みそのもの（LTYPE テーブルの 49/74）は読まない。** Web 版の線種は 5 種の
 * 固定定義（`render/linetype.ts`）で、刻みは線種尺度から決まるため。
 * 未知の名前は実線として扱う。
 */
export function lineStyleOfName(name: string): LineStyleName {
  const n = name.trim().toUpperCase();
  if (n === '' || n === 'BYLAYER' || n === 'BYBLOCK' || n === 'CONTINUOUS' || n === 'SOLID') return 'solid';
  if (n.includes('CENTER') || n.includes('中心')) return 'center';
  if (n.includes('DASHDOT') || n.includes('DASH_DOT') || n.includes('一点') || n.includes('PHANTOM')) return 'dashdot';
  if (n.startsWith('DOT') || n.includes('点線')) return 'dotted';
  if (n.includes('DASH') || n.includes('HIDDEN') || n.includes('破線') || n.includes('DIVIDE')) return 'dashed';
  return 'solid';
}

// ---- 本体 ----------------------------------------------------------------

export interface DxfReadResult {
  json: DocumentJson;
  /** 読めなかった／捨てたエンティティの種別と件数。 */
  skipped: Record<string, number>;
  encoding?: string;
}

/** グループコードから値を引くための小さな入れ物（同じコードが複数回来る場合は配列で持つ）。 */
class Group {
  private readonly map = new Map<number, string[]>();

  constructor(pairs: readonly DxfPair[]) {
    for (const p of pairs) {
      const list = this.map.get(p.code);
      if (list) list.push(p.value);
      else this.map.set(p.code, [p.value]);
    }
  }

  str(code: number, fallback = ''): string {
    return this.map.get(code)?.[0]?.trim() ?? fallback;
  }

  /** 生の文字列（前後の空白を落とさない。文字列値のため）。 */
  raw(code: number): string | undefined {
    return this.map.get(code)?.[0];
  }

  all(code: number): string[] {
    return this.map.get(code) ?? [];
  }

  num(code: number, fallback: number): number {
    const v = this.map.get(code)?.[0];
    if (v === undefined) return fallback;
    const n = Number.parseFloat(v.trim());
    return Number.isFinite(n) ? n : fallback;
  }

  int(code: number, fallback: number): number {
    const v = this.map.get(code)?.[0];
    if (v === undefined) return fallback;
    const n = Number.parseInt(v.trim(), 10);
    return Number.isFinite(n) ? n : fallback;
  }

  has(code: number): boolean {
    return this.map.has(code);
  }
}

/** DXF テキストを `DocumentJson` へ。`CadDocument.loadJson` にそのまま渡せる。 */
export function dxfToDocumentJson(text: string): DxfReadResult {
  const pairs = tokenize(text);
  const skipped: Record<string, number> = {};

  const header = readHeader(pairs);
  const layers = readLayers(pairs);
  const entities = readEntities(pairs, skipped);

  // 図形が使っている画層が LAYER テーブルに無いことがある（他 CAD の出力）
  const names = new Set(layers.map((l) => l.name));
  for (const e of entities) {
    if (!names.has(e.layer)) {
      names.add(e.layer);
      layers.push(makeLayer(e.layer, VB_BLACK));
    }
  }

  return {
    json: {
      format: 'tr-cad2w',
      version: FILE_FORMAT_VERSION,
      lineTypeScale: header.lineTypeScale,
      layers,
      entities: entities.map((e, i) => ({ ...e, id: i + 1 }) as Entity),
    },
    skipped,
  };
}

function readHeader(pairs: readonly DxfPair[]): { lineTypeScale: number } {
  let lineTypeScale = DEFAULT_LINETYPE_SCALE;
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i]!;
    if (p.code === 0 && p.value.trim() === 'ENDSEC') break;
    if (p.code !== 9) continue;
    if (p.value.trim() === '$LTSCALE') {
      const v = Number.parseFloat(pairs[i + 1]?.value ?? '');
      // 0 以下は不正。既定値のままにする
      if (Number.isFinite(v) && v > 0) lineTypeScale = v;
    }
  }
  return { lineTypeScale };
}

function readLayers(pairs: readonly DxfPair[]): Layer[] {
  const out: Layer[] = [];
  let inTable = false;
  let current: DxfPair[] | null = null;

  const flush = (): void => {
    if (!current) return;
    const g = new Group(current);
    const name = g.str(2);
    if (name !== '') {
      const aci = g.int(62, 7);
      const color = g.has(420) ? trueColorToHex(g.int(420, 0)) : aciToColor(Math.abs(aci));
      out.push({
        name,
        color,
        lineStyle: lineStyleOfName(g.str(6, 'CONTINUOUS')),
        // ACI が負の画層は「表示 OFF」（AutoCAD の約束）
        visible: aci >= 0,
        lineWidth: lineWeightToMm(g.int(370, -1)),
      });
    }
    current = null;
  };

  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i]!;
    const v = p.value.trim();
    if (p.code === 2 && v === 'LAYER' && pairs[i - 1]?.value.trim() === 'TABLE') {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (p.code === 0) {
      if (v === 'LAYER') {
        flush();
        current = [];
        continue;
      }
      flush();
      if (v === 'ENDTAB' || v === 'ENDSEC') {
        inTable = false;
      }
      continue;
    }
    current?.push(p);
  }
  flush();

  // LAYER テーブルが無いファイルもある。画層 0 は必ず用意する
  if (!out.some((l) => l.name === '0')) {
    out.unshift(STANDARD_LAYERS[0] ? { ...STANDARD_LAYERS[0] } : makeLayer('0', VB_BLACK));
  }
  return out;
}

/** 線幅 `370`（mm×100） → mm。ByLayer(-1) / ByBlock(-2) / Default(-3) は 0（極細）。 */
export function lineWeightToMm(lw: number): number {
  return lw > 0 ? lw / 100 : 0;
}

const SUPPORTED = new Set([
  'LINE',
  'CIRCLE',
  'ARC',
  'POINT',
  'LWPOLYLINE',
  'POLYLINE',
  'TEXT',
  'MTEXT',
  'VERTEX',
  'SEQEND',
]);

function readEntities(pairs: readonly DxfPair[], skipped: Record<string, number>): NewEntity[] {
  const out: NewEntity[] = [];

  // ENTITIES セクションの範囲を探す
  let start = -1;
  let end = pairs.length;
  for (let i = 0; i + 1 < pairs.length; i++) {
    if (pairs[i]!.code === 0 && pairs[i]!.value.trim() === 'SECTION' && pairs[i + 1]!.code === 2) {
      if (pairs[i + 1]!.value.trim() === 'ENTITIES') start = i + 2;
      else if (start >= 0) {
        end = i;
        break;
      }
    }
    if (start >= 0 && pairs[i]!.code === 0 && pairs[i]!.value.trim() === 'ENDSEC') {
      end = i;
      break;
    }
  }
  if (start < 0) return out;

  // code 0 ごとにエンティティを切る。POLYLINE は VERTEX/SEQEND を巻き取る
  let i = start;
  while (i < end) {
    const p = pairs[i]!;
    if (p.code !== 0) {
      i++;
      continue;
    }
    const kind = p.value.trim();
    let j = i + 1;
    while (j < end && pairs[j]!.code !== 0) j++;
    const body = pairs.slice(i + 1, j);

    if (kind === 'POLYLINE') {
      // VERTEX の連なりを SEQEND まで集める
      const verts: DxfPair[][] = [];
      let k = j;
      while (k < end) {
        const q = pairs[k]!;
        if (q.code !== 0) {
          k++;
          continue;
        }
        const kv = q.value.trim();
        let m = k + 1;
        while (m < end && pairs[m]!.code !== 0) m++;
        if (kv === 'VERTEX') {
          verts.push(pairs.slice(k + 1, m));
          k = m;
          continue;
        }
        if (kv === 'SEQEND') k = m;
        break;
      }
      const built = buildPolylineOld(new Group(body), verts.map((v) => new Group(v)));
      if (built) out.push(built);
      else count(skipped, 'POLYLINE');
      i = k;
      continue;
    }

    const built = buildEntity(kind, new Group(body));
    if (built) out.push(built);
    else if (!SUPPORTED.has(kind)) count(skipped, kind);
    i = j;
  }
  return out;
}

function count(rec: Record<string, number>, key: string): void {
  rec[key] = (rec[key] ?? 0) + 1;
}

/** 図形共通の属性（画層・色・線種・線幅）。 */
function attrsOf(g: Group): Omit<Entity, 'id' | 'kind'> {
  const aci = g.int(62, 256);
  const color = g.has(420)
    ? trueColorToHex(g.int(420, 0))
    : // 256=ByLayer / 0=ByBlock は画層色に従う（null）
      aci === 256 || aci === 0
      ? null
      : aciToColor(Math.abs(aci));
  return {
    layer: g.str(8, '0') || '0',
    color,
    lineStyle: lineStyleOfName(g.str(6, 'BYLAYER')),
    lineWidth: lineWeightToMm(g.int(370, -1)),
  };
}

function point(g: Group, xCode = 10, yCode = 20): Vec2 {
  return vec(g.num(xCode, 0), g.num(yCode, 0));
}

function buildEntity(kind: string, g: Group): NewEntity | null {
  const b = attrsOf(g);
  switch (kind) {
    case 'LINE':
      return { ...b, kind: 'line', a: point(g), b: point(g, 11, 21) };
    case 'CIRCLE': {
      const r = g.num(40, 0);
      return r > 0 ? { ...b, kind: 'circle', center: point(g), radius: r } : null;
    }
    case 'ARC': {
      const r = g.num(40, 0);
      if (r <= 0) return null;
      // DXF の 50/51 は度で、常に 50→51 が反時計回り
      return {
        ...b,
        kind: 'arc',
        center: point(g),
        radius: r,
        startAngle: rad(g.num(50, 0)),
        endAngle: rad(g.num(51, 0)),
      };
    }
    case 'POINT':
      return { ...b, kind: 'point', at: point(g) };
    case 'LWPOLYLINE': {
      const xs = g.all(10).map((v) => Number.parseFloat(v));
      const ys = g.all(20).map((v) => Number.parseFloat(v));
      const n = Math.min(xs.length, ys.length);
      if (n < 2) return null;
      const points: Vec2[] = [];
      for (let i = 0; i < n; i++) {
        const x = xs[i]!;
        const y = ys[i]!;
        if (Number.isFinite(x) && Number.isFinite(y)) points.push(vec(x, y));
      }
      if (points.length < 2) return null;
      return { ...b, kind: 'polyline', points, closed: (g.int(70, 0) & 1) === 1 };
    }
    case 'TEXT':
      return buildText(g, b);
    case 'MTEXT':
      return buildMText(g, b);
    default:
      return null;
  }
}

function buildText(g: Group, b: Omit<Entity, 'id' | 'kind'>): NewEntity | null {
  const content = g.raw(1);
  if (content === undefined) return null;
  const h = g.num(40, 0);
  if (h <= 0) return null;

  const hCode = g.int(72, 0);
  const vCode = g.int(73, 0);
  const hAlign: TextEntity['hAlign'] = hCode === 1 || hCode === 4 ? 'center' : hCode === 2 ? 'right' : 'left';
  const vAlign: TextEntity['vAlign'] =
    vCode === 1 ? 'bottom' : vCode === 2 ? 'middle' : vCode === 3 ? 'top' : hCode === 4 ? 'middle' : 'baseline';

  // 左寄せ・ベースライン以外は第二揃え点(11/21)が挿入点になる
  const useAlignPoint = (hCode !== 0 || vCode !== 0) && g.has(11);
  return {
    ...b,
    kind: 'text',
    at: useAlignPoint ? point(g, 11, 21) : point(g),
    text: unescapeDxfText(content),
    height: h,
    rotation: rad(g.num(50, 0)),
    hAlign,
    vAlign,
  };
}

function buildMText(g: Group, b: Omit<Entity, 'id' | 'kind'>): NewEntity | null {
  // 250 文字を超える本文は 3 が並び、最後の断片が 1 に入る
  const body = [...g.all(3), ...(g.raw(1) === undefined ? [] : [g.raw(1)!])].join('');
  if (body === '') return null;
  const h = g.num(40, 0);
  if (h <= 0) return null;

  const att = g.int(71, 1);
  const hAlign: TextEntity['hAlign'] =
    att === 2 || att === 5 || att === 8 ? 'center' : att === 3 || att === 6 || att === 9 ? 'right' : 'left';
  const vAlign: TextEntity['vAlign'] = att <= 3 ? 'top' : att <= 6 ? 'middle' : 'bottom';

  return {
    ...b,
    kind: 'text',
    at: point(g),
    text: unescapeMText(body),
    height: h,
    // 50 は度、11/21 の方向ベクトルで回転が来ることもある
    rotation: g.has(50) ? rad(g.num(50, 0)) : Math.atan2(g.num(21, 0), g.num(11, 1)),
    hAlign,
    vAlign,
  };
}

function buildPolylineOld(head: Group, verts: readonly Group[]): NewEntity | null {
  const points = verts.map((v) => point(v)).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (points.length < 2) return null;
  return { ...attrsOf(head), kind: 'polyline', points, closed: (head.int(70, 0) & 1) === 1 };
}

/** `TEXT` の制御表記を素の文字へ。 */
export function unescapeDxfText(s: string): string {
  return s.replace(/%%d/gi, '°').replace(/%%p/gi, '±').replace(/%%c/gi, 'Ø').replace(/%%%/g, '%');
}

/**
 * `MTEXT` の本文を素の文字へ。
 *
 * **1 文字ずつ走査する。** 正規表現の順次置換だと `\\P`（エスケープされた
 * バックスラッシュ + P）が改行に化けるなど、エスケープの入れ子を取り違える。
 * 書出の `escapeMText` と対になっていること。
 */
export function unescapeMText(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '{' || c === '}') continue; // グループ化の記号（素の波括弧は \{ で来る）
    if (c !== '\\') {
      out += c;
      continue;
    }
    const next = s[i + 1];
    if (next === undefined) break;
    switch (next) {
      case 'P':
        out += '\n';
        i++;
        break;
      case '~':
        out += ' ';
        i++;
        break;
      case '\\':
      case '{':
      case '}':
        out += next;
        i++;
        break;
      default:
        if ('fFHWQATCcpS'.includes(next)) {
          // \H1.5x; \fMSゴシック|b0; などの書式指定は ; まで捨てる
          const end = s.indexOf(';', i + 1);
          i = end < 0 ? s.length : end;
        } else {
          out += next; // 知らないエスケープは中身をそのまま出す
          i++;
        }
        break;
    }
  }
  return unescapeDxfText(out);
}

/** バイト列から直接読む（文字コード判定つき）。 */
export function readDxfBytes(bytes: Uint8Array): DxfReadResult {
  const dec = decodeDxf(bytes);
  const res = dxfToDocumentJson(dec.text);
  return { ...res, encoding: `${dec.encoding} (${dec.reason})` };
}
