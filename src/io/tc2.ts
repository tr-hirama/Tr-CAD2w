/**
 * デスクトップ版 TrCad2D の `.tc2` との相互運用。
 *
 * `.tc2` は **JSON を ZIP 圧縮したもの**で、中身は `TrCad2D.json` 1 件
 * （デスクトップ版 `CadDocument.cs` の `WriteTc2` / `Tc2Entry`）。
 *
 * ## 対応表（デスクトップ版 `DocDto`/`Dto` ⇔ Web 版 `DocumentJson`）
 *
 * | デスクトップ | Web | 備考 |
 * |---|---|---|
 * | `Kind: "Line"` + `Pts[4]` | `line` | |
 * | `Kind: "Rect"` + `Pts[4]` | `rect` | 対角 2 点 |
 * | `Kind: "Circle"` + `Pts[2]` + `Radius` | `circle` | |
 * | `Kind: "Arc"` + `Pts[2]` + `Radius` + `ArcStart/ArcEnd`（**度**） | `arc`（ラジアン） | |
 * | `Kind: "Polyline"` + `Pts[2n]` | `polyline` | **閉合フラグが無い**（下記） |
 * | `Kind: "Text"` + `Pts[2]` + `Text/Height/Rotation`（**度**）`/Align/VAlign` | `text` | |
 * | `Kind: "Point"` + `Pts[2]` | `point` | |
 * | `Color`（`0xAARRGGBB`） | `color`（`#rrggbb`） | **画層色と同じなら ByLayer(null)** にする |
 * | `LineType`（`Continuous`…） | `lineStyle`（`solid`…） | 1 対 1 |
 * | `LineWeight`（mm） | `lineWidth`（mm） | そのまま |
 * | `LtScale` | `lineTypeScale` | 無ければ 500 |
 *
 * ## 落ちる情報
 *
 * | 向き | 落ちるもの |
 * |---|---|
 * | tc2 → Web | ハッチ・ブロック(Insert)・画像・寸法（**件数を報告**）、測量データ（観測/座標/まわりけん/レベル/座標変換）、概要・コメント・メモ、用紙空間、グループ、ブロック定義 |
 * | Web → tc2 | 画層の**線種**（デスクトップ版の `LayerDto` は色と表示のみ）、用紙空間 |
 *
 * ## 閉じた連続線
 *
 * デスクトップ版の `Polyline` に閉合フラグは無い。**閉じた連続線は最後に始点を
 * 足して**書き出し、読み込むときは「最初と最後が同じ点なら閉じている」とみなす。
 * これで往復は一致する。
 */

import type { DocumentJson } from '../core/document.js';
import { DEFAULT_LINETYPE_SCALE, FILE_FORMAT_VERSION } from '../core/document.js';
import type { Entity, HatchPattern, LineStyleName, NewEntity, TextEntity } from '../core/entity.js';
import { DEFAULT_HATCH_SPACING } from '../core/hatch.js';
import type { BlockDef } from '../core/block.js';
import { dist, rad, vec, type Vec2 } from '../core/geometry.js';
import { deg } from '../core/geometry.js';
import type { Layer } from '../core/layer.js';
import { STANDARD_LAYERS, VB_BLACK, formatColor, makeLayer, parseColor } from '../core/layer.js';
import { looksLikeZip, unzip, zip } from './zip.js';

/** `.tc2` の中の JSON エントリ名（デスクトップ版 `CadDocument.Tc2Entry`）。 */
export const TC2_ENTRY = 'TrCad2D.json';

export interface Tc2LayerDto {
  Name: string;
  Color: number;
  Visible: boolean;
}

/** デスクトップ版 `Dto` のうち Web 版が使う項目だけ（残りは読み飛ばす）。 */
export interface Tc2EntityDto {
  Kind: string;
  Pts: number[];
  Radius?: number;
  Color?: number;
  Text?: string | null;
  Height?: number;
  Rotation?: number;
  Layer?: string | null;
  LineType?: string | null;
  LineWeight?: number;
  ArcStart?: number;
  ArcEnd?: number;
  Align?: string | null;
  VAlign?: string | null;
  Hatch?: string | null;
  HatchSpacing?: number;
  Block?: string | null;
  Scale?: number;
  ScaleY?: number;
  Img?: string | null;
  ImgOpacity?: number;
}

/** デスクトップ版 `BlockDto`（名前と中身）。 */
export interface Tc2BlockDto {
  Name: string;
  Entities: Tc2EntityDto[];
}

export interface Tc2DocDto {
  Layers: Tc2LayerDto[];
  CurrentLayer: string;
  Entities: Tc2EntityDto[];
  LtScale?: number | null;
  Blocks?: Tc2BlockDto[] | null;
  [key: string]: unknown; // 測量データなど、Web 版が使わない項目はそのまま無視する
}

const LINE_TYPE_TO_STYLE: Readonly<Record<string, LineStyleName>> = {
  Continuous: 'solid',
  Dashed: 'dashed',
  Dotted: 'dotted',
  DashDot: 'dashdot',
  Center: 'center',
};

const STYLE_TO_LINE_TYPE: Record<LineStyleName, string> = {
  solid: 'Continuous',
  dashed: 'Dashed',
  dotted: 'Dotted',
  dashdot: 'DashDot',
  center: 'Center',
};

const ALIGN_TO_H: Readonly<Record<string, TextEntity['hAlign']>> = {
  Left: 'left',
  Center: 'center',
  Right: 'right',
};

const VALIGN_TO_V: Readonly<Record<string, TextEntity['vAlign']>> = {
  Baseline: 'baseline',
  Bottom: 'bottom',
  Middle: 'middle',
  Top: 'top',
};

/** デスクトップ版 `HatchPattern` ⇔ Web 版 `pattern`。 */
const HATCH_TO_WEB: Readonly<Record<string, HatchPattern>> = {
  Solid: 'solid',
  Line45: 'line45',
  Line135: 'line135',
  Cross: 'cross',
  Grid: 'grid',
};

const HATCH_TO_TC2: Record<HatchPattern, string> = {
  solid: 'Solid',
  line45: 'Line45',
  line135: 'Line135',
  cross: 'Cross',
  grid: 'Grid',
};

const H_TO_ALIGN: Record<TextEntity['hAlign'], string> = { left: 'Left', center: 'Center', right: 'Right' };
const V_TO_VALIGN: Record<TextEntity['vAlign'], string> = {
  baseline: 'Baseline',
  bottom: 'Bottom',
  middle: 'Middle',
  top: 'Top',
};

/** `0xAARRGGBB` → `#rrggbb`（アルファは捨てる）。 */
export function argbToHex(argb: number): string {
  const v = argb >>> 0;
  return formatColor({ r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 });
}

/** `#rrggbb` → `0xAARRGGBB`（アルファは不透明）。 */
export function hexToArgb(hex: string): number {
  const c = parseColor(hex) ?? { r: 255, g: 255, b: 255 };
  return ((0xff << 24) | (c.r << 16) | (c.g << 8) | c.b) >>> 0;
}

/** 連続線の点列が閉じているか（最初と最後が同じ点）。 */
function isClosedRing(points: readonly Vec2[]): boolean {
  return points.length >= 4 && dist(points[0]!, points[points.length - 1]!) < 1e-9;
}

function toPoints(pts: readonly number[]): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const x = pts[i]!;
    const y = pts[i + 1]!;
    if (Number.isFinite(x) && Number.isFinite(y)) out.push(vec(x, y));
  }
  return out;
}

export interface Tc2ReadResult {
  json: DocumentJson;
  /** Web 版に無い図形種別と件数（`Hatch` `Insert` `Image` `Dimension` など）。 */
  skipped: Record<string, number>;
  /** 図形以外で落ちたもの（測量データなど）の名前。 */
  droppedSections: string[];
}

/** デスクトップ版の JSON（`DocDto`）→ Web 版の `DocumentJson`。 */
export function tc2JsonToDocument(dto: Tc2DocDto): Tc2ReadResult {
  if (!Array.isArray(dto?.Entities) || !Array.isArray(dto?.Layers)) {
    throw new Error('TrCad2D の図面ファイルとして読めません（Layers / Entities がありません）');
  }

  const layers: Layer[] = dto.Layers.map((l) => ({
    name: String(l.Name ?? '0'),
    color: argbToHex(Number(l.Color ?? 0xffffffff)),
    // デスクトップ版の画層は線種を持たない。実線として読む
    lineStyle: 'solid' as LineStyleName,
    visible: l.Visible !== false,
    lineWidth: 0,
  }));
  if (!layers.some((l) => l.name === '0')) layers.unshift(makeLayer('0', VB_BLACK));
  const layerColor = new Map(layers.map((l) => [l.name, l.color.toLowerCase()]));

  const skipped: Record<string, number> = {};
  const entities: Entity[] = [];
  let id = 1;

  for (const d of dto.Entities) {
    const built = buildEntity(d, layerColor);
    if (!built) {
      const key = String(d?.Kind ?? '不明');
      skipped[key] = (skipped[key] ?? 0) + 1;
      continue;
    }
    entities.push({ ...built, id: id++ } as Entity);
  }

  // 図形以外で落ちるもの（利用者に伝えるため名前だけ拾う）
  const droppedSections: string[] = [];
  const SECTION_LABEL: Record<string, string> = {
    Obs: '観測データ',
    Coord: '座標',
    Ken: 'まわりけん',
    Level: 'レベル',
    Transform: '座標変換',
    Project: '概要',
    Comments: 'コメント',
    Kyokai: '境界コメント',
    Blocks: 'ブロック定義',
    Layouts: '用紙空間',
    MemoText: 'メモ',
    MemoInk: '手書きメモ',
  };
  for (const [key, label] of Object.entries(SECTION_LABEL)) {
    const v = dto[key];
    if (v === null || v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'string' && v === '') continue;
    droppedSections.push(label);
  }

  // ブロック定義（挿入の中身）。中の図形にも同じ変換をかける
  const blocks: BlockDef[] = [];
  for (const b of dto.Blocks ?? []) {
    if (typeof b?.Name !== 'string' || !Array.isArray(b.Entities)) continue;
    const inner: Entity[] = [];
    for (const d of b.Entities) {
      const built = buildEntity(d, layerColor);
      if (built) inner.push({ ...built, id: id++ } as Entity);
    }
    blocks.push({ name: b.Name, entities: inner });
  }

  const ltScale = typeof dto.LtScale === 'number' && dto.LtScale > 0 ? dto.LtScale : DEFAULT_LINETYPE_SCALE;
  const json: DocumentJson = {
    format: 'tr-cad2w',
    version: FILE_FORMAT_VERSION,
    lineTypeScale: ltScale,
    layers,
    entities,
  };
  if (blocks.length > 0) json.blocks = blocks;
  return { json, skipped, droppedSections };
}

function buildEntity(d: Tc2EntityDto, layerColor: Map<string, string>): NewEntity | null {
  if (!d || typeof d.Kind !== 'string' || !Array.isArray(d.Pts)) return null;
  const points = toPoints(d.Pts);
  const layer = d.Layer ?? '0';
  const hex = argbToHex(Number(d.Color ?? 0xffffffff));
  // 画層色と同じなら ByLayer として持つ（Web 版らしい持ち方。往復でも一致する）
  const color = layerColor.get(layer) === hex.toLowerCase() ? null : hex;
  const base = {
    layer,
    color,
    lineStyle: LINE_TYPE_TO_STYLE[d.LineType ?? 'Continuous'] ?? 'solid',
    lineWidth: Number.isFinite(d.LineWeight) ? Number(d.LineWeight) : 0,
  };

  switch (d.Kind) {
    case 'Line':
      return points.length >= 2 ? { ...base, kind: 'line', a: points[0]!, b: points[1]! } : null;
    case 'Rect':
      return points.length >= 2 ? { ...base, kind: 'rect', a: points[0]!, b: points[1]! } : null;
    case 'Circle': {
      const r = Number(d.Radius ?? 0);
      return points.length >= 1 && r > 0 ? { ...base, kind: 'circle', center: points[0]!, radius: r } : null;
    }
    case 'Arc': {
      const r = Number(d.Radius ?? 0);
      if (points.length < 1 || !(r > 0)) return null;
      return {
        ...base,
        kind: 'arc',
        center: points[0]!,
        radius: r,
        // デスクトップ版は度・反時計回り
        startAngle: rad(Number(d.ArcStart ?? 0)),
        endAngle: rad(Number(d.ArcEnd ?? 0)),
      };
    }
    case 'Polyline': {
      if (points.length < 2) return null;
      // 閉合フラグが無いので「最初と最後が同じ点」で閉じているとみなす
      const closed = isClosedRing(points);
      return { ...base, kind: 'polyline', points: closed ? points.slice(0, -1) : points, closed };
    }
    case 'Point':
      return points.length >= 1 ? { ...base, kind: 'point', at: points[0]! } : null;
    case 'Text': {
      const text = d.Text ?? '';
      const height = Number(d.Height ?? 0);
      if (points.length < 1 || text === '' || !(height > 0)) return null;
      return {
        ...base,
        kind: 'text',
        at: points[0]!,
        text,
        height,
        rotation: rad(Number(d.Rotation ?? 0)),
        hAlign: ALIGN_TO_H[d.Align ?? 'Left'] ?? 'left',
        vAlign: VALIGN_TO_V[d.VAlign ?? 'Baseline'] ?? 'baseline',
      };
    }
    case 'Hatch': {
      if (points.length < 3) return null;
      return {
        ...base,
        kind: 'hatch',
        points,
        pattern: HATCH_TO_WEB[d.Hatch ?? 'Solid'] ?? 'solid',
        spacing: numberOr(d.HatchSpacing, DEFAULT_HATCH_SPACING),
      };
    }
    case 'Insert': {
      const name = d.Block ?? '';
      if (points.length < 1 || name === '') return null;
      return {
        ...base,
        kind: 'insert',
        blockName: name,
        at: points[0]!,
        scale: numberOr(d.Scale, 1),
        scaleY: numberOr(d.ScaleY, 0),
        rotation: rad(numberOr(d.Rotation, 0)),
      };
    }
    case 'Image': {
      const img = d.Img ?? '';
      if (points.length < 2 || img === '') return null;
      return {
        ...base,
        kind: 'image',
        a: points[0]!,
        b: points[1]!,
        dataUrl: dataUrlOfBase64(img),
        opacity: numberOr(d.ImgOpacity, 1),
      };
    }
    default:
      return null; // Dimension など、まだ対応していない種別
  }
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Web 版の `DocumentJson` → デスクトップ版の JSON（`DocDto`）。 */
export function documentToTc2Json(json: DocumentJson): Tc2DocDto {
  const layers: Tc2LayerDto[] = (json.layers.length > 0 ? json.layers : STANDARD_LAYERS).map((l) => ({
    Name: l.name,
    Color: hexToArgb(l.color),
    Visible: l.visible,
  }));
  const layerColor = new Map(layers.map((l) => [l.Name, l.Color]));

  const entities: Tc2EntityDto[] = [];
  for (const e of json.entities) {
    const dto = toTc2Entity(e, layerColor);
    if (dto) entities.push(dto);
  }

  const out: Tc2DocDto = {
    Layers: layers,
    CurrentLayer: '0',
    Entities: entities,
    LtScale: json.lineTypeScale,
  };

  const blocks = json.blocks ?? [];
  if (blocks.length > 0) {
    out.Blocks = blocks.map((b) => ({
      Name: b.name,
      Entities: b.entities.map((e) => toTc2Entity(e, layerColor)).filter((x): x is Tc2EntityDto => x !== null),
    }));
  }
  return out;
}

function toTc2Entity(e: Entity, layerColor: Map<string, number>): Tc2EntityDto | null {
  // ByLayer は画層色に解決して書く（デスクトップ版に ByLayer の持ち方が無い）
  const color = e.color === null ? (layerColor.get(e.layer) ?? hexToArgb(VB_BLACK)) : hexToArgb(e.color);
  const base = {
    Color: color,
    Layer: e.layer,
    LineType: STYLE_TO_LINE_TYPE[e.lineStyle],
    LineWeight: e.lineWidth,
    Radius: 0,
  };

  switch (e.kind) {
    case 'line':
      return { ...base, Kind: 'Line', Pts: [e.a.x, e.a.y, e.b.x, e.b.y] };
    case 'rect':
      return { ...base, Kind: 'Rect', Pts: [e.a.x, e.a.y, e.b.x, e.b.y] };
    case 'circle':
      return { ...base, Kind: 'Circle', Pts: [e.center.x, e.center.y], Radius: e.radius };
    case 'arc':
      return {
        ...base,
        Kind: 'Arc',
        Pts: [e.center.x, e.center.y],
        Radius: e.radius,
        ArcStart: normalizeDegrees(deg(e.startAngle)),
        ArcEnd: normalizeDegrees(deg(e.endAngle)),
      };
    case 'polyline': {
      if (e.points.length < 2) return null;
      // 閉じた連続線は最後に始点を足す（デスクトップ版に閉合フラグが無いため）
      const pts = e.closed ? [...e.points, e.points[0]!] : e.points;
      return { ...base, Kind: 'Polyline', Pts: pts.flatMap((p) => [p.x, p.y]) };
    }
    case 'point':
      return { ...base, Kind: 'Point', Pts: [e.at.x, e.at.y] };
    case 'text':
      return {
        ...base,
        Kind: 'Text',
        Pts: [e.at.x, e.at.y],
        Text: e.text,
        Height: e.height,
        Rotation: normalizeDegrees(deg(e.rotation)),
        Align: H_TO_ALIGN[e.hAlign],
        VAlign: V_TO_VALIGN[e.vAlign],
      };
    case 'hatch':
      if (e.points.length < 3) return null;
      return {
        ...base,
        Kind: 'Hatch',
        Pts: e.points.flatMap((p) => [p.x, p.y]),
        Hatch: HATCH_TO_TC2[e.pattern],
        HatchSpacing: e.spacing,
      };
    case 'insert':
      return {
        ...base,
        Kind: 'Insert',
        Pts: [e.at.x, e.at.y],
        Block: e.blockName,
        Scale: e.scale,
        ScaleY: e.scaleY,
        Rotation: normalizeDegrees(deg(e.rotation)),
      };
    case 'image':
      return {
        ...base,
        Kind: 'Image',
        Pts: [e.a.x, e.a.y, e.b.x, e.b.y],
        // デスクトップ版は「素の base64」で持つ（data URL ではない）
        Img: base64OfDataUrl(e.dataUrl),
        ImgOpacity: e.opacity,
      };
  }
}

/** `data:image/png;base64,XXXX` → `XXXX`。すでに素の base64 ならそのまま。 */
export function base64OfDataUrl(dataUrl: string): string {
  const i = dataUrl.indexOf('base64,');
  return i >= 0 ? dataUrl.slice(i + 'base64,'.length) : dataUrl;
}

/**
 * 素の base64 → `data:...;base64,...`。
 *
 * デスクトップ版は画像の種類を持たないので、**先頭のバイトから見分ける**
 * （PNG は `\x89PNG`＝base64 で `iVBORw0KGgo`、JPEG は `\xff\xd8\xff`＝`/9j/`）。
 */
export function dataUrlOfBase64(b64: string): string {
  if (b64.startsWith('data:')) return b64;
  const mime = b64.startsWith('/9j/') ? 'image/jpeg' : b64.startsWith('R0lGOD') ? 'image/gif' : 'image/png';
  return `data:${mime};base64,${b64}`;
}

function normalizeDegrees(d: number): number {
  const v = d % 360;
  return v < 0 ? v + 360 : v;
}

// ---- ファイル入出力 ------------------------------------------------------

export interface Tc2FileResult extends Tc2ReadResult {
  /** ZIP の中で実際に読んだエントリ名。 */
  entryName: string;
}

/** `.tc2`（ZIP）のバイト列 → Web 版の図面。 */
export async function readTc2(bytes: Uint8Array): Promise<Tc2FileResult> {
  if (!looksLikeZip(bytes)) throw new Error('.tc2 ではありません（ZIP ではない）');
  const entries = await unzip(bytes);
  // 名前は TrCad2D.json のはずだが、違う名前でも .json が 1 つならそれを読む
  const entry = entries.find((x) => x.name === TC2_ENTRY) ?? entries.find((x) => x.name.endsWith('.json'));
  if (!entry) throw new Error(`.tc2 の中に ${TC2_ENTRY} がありません`);

  const text = new TextDecoder('utf-8').decode(entry.bytes);
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== 'object' || parsed === null) throw new Error('.tc2 の中身が JSON ではありません');
  return { ...tc2JsonToDocument(parsed as Tc2DocDto), entryName: entry.name };
}

/** Web 版の図面 → `.tc2`（ZIP）のバイト列。 */
export async function writeTc2(json: DocumentJson): Promise<Uint8Array> {
  const text = JSON.stringify(documentToTc2Json(json));
  return zip([{ name: TC2_ENTRY, bytes: new TextEncoder().encode(text) }]);
}

/** 既定の保存名。`図面-20260814-1530.tc2` の形。 */
export function defaultTc2FileName(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  return `図面-${stamp}.tc2`;
}
