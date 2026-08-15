import { describe, expect, it } from 'vitest';
import { vec } from '../src/core/geometry.js';
import { CadDocument, FILE_FORMAT_VERSION, type DocumentJson } from '../src/core/document.js';
import {
  DEFAULT_ATTRS,
  type HatchEntity,
  type ImageEntity,
  type InsertEntity,
  entityBounds,
  hitTest,
  rotateEntity,
  translateEntity,
} from '../src/core/entity.js';
import { STANDARD_LAYERS } from '../src/core/layer.js';
import { documentToDxf } from '../src/io/dxf-write.js';
import {
  base64OfDataUrl,
  dataUrlOfBase64,
  documentToTc2Json,
  tc2JsonToDocument,
  type Tc2DocDto,
} from '../src/io/tc2.js';
import { makeBlock } from '../src/core/block.js';

/** 1×1 の透明 PNG（テスト用の最小データ）。 */
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function image(over: Partial<ImageEntity> = {}): ImageEntity {
  return {
    ...DEFAULT_ATTRS,
    id: 1,
    kind: 'image',
    a: vec(0, 0),
    b: vec(8, 4),
    dataUrl: PNG_1PX,
    opacity: 1,
    ...over,
  };
}

describe('画像の図形としての振る舞い', () => {
  it('外接矩形は配置矩形', () => {
    const b = entityBounds(image());
    expect([b.minX, b.minY, b.maxX, b.maxY]).toEqual([0, 0, 8, 4]);
  });

  it('矩形の内側を押すと掴める', () => {
    expect(hitTest(image(), vec(4, 2), 0.1)).toBe(true);
  });

  it('外側では掴めない', () => {
    expect(hitTest(image(), vec(9, 2), 0.1)).toBe(false);
  });

  it('平行移動する', () => {
    const m = translateEntity(image(), vec(10, 1)) as ImageEntity;
    expect(m.a).toEqual(vec(10, 1));
    expect(m.b).toEqual(vec(18, 5));
  });

  it('回すと軸平行のまま外接矩形へ収まる（画像は傾けない）', () => {
    const r = rotateEntity(image(), vec(0, 0), Math.PI / 2) as ImageEntity;
    expect(r.kind).toBe('image');
    const b = entityBounds(r);
    expect(b.minX).toBeCloseTo(-4, 9);
    expect(b.maxX).toBeCloseTo(0, 9);
    expect(b.maxY).toBeCloseTo(8, 9);
  });
});

describe('画像の埋め込みと往復', () => {
  it('保存して読み直しても画像が残る', () => {
    const doc = new CadDocument();
    doc.clear();
    doc.add({ ...image() });
    const json = JSON.parse(JSON.stringify(doc.toJson())) as DocumentJson;
    const back = new CadDocument();
    back.loadJson(json);
    const e = back.entities[0];
    if (e?.kind !== 'image') throw new Error('画像として戻ってきていません');
    expect(e.dataUrl).toBe(PNG_1PX);
    expect(e.opacity).toBe(1);
  });

  it('.tc2 は素の base64 で持つ（デスクトップ版に合わせる）', () => {
    const json: DocumentJson = {
      format: 'tr-cad2w',
      version: FILE_FORMAT_VERSION,
      lineTypeScale: 500,
      layers: [...STANDARD_LAYERS],
      entities: [image()],
    };
    const dto = documentToTc2Json(json);
    const d = dto.Entities[0]!;
    expect(d.Kind).toBe('Image');
    expect(d.Img?.startsWith('data:')).toBe(false);
    expect(d.Img?.startsWith('iVBORw0KGgo')).toBe(true);
  });

  it('.tc2 から読むと data URL に戻る', () => {
    const dto: Tc2DocDto = {
      Layers: [{ Name: '0', Color: 0xffffffff, Visible: true }],
      CurrentLayer: '0',
      Entities: [
        { Kind: 'Image', Pts: [0, 0, 8, 4], Color: 0xffffffff, Img: base64OfDataUrl(PNG_1PX), ImgOpacity: 0.5 },
      ],
    };
    const e = tc2JsonToDocument(dto).json.entities[0];
    if (e?.kind !== 'image') throw new Error('画像として読めていません');
    expect(e.dataUrl).toBe(PNG_1PX);
    expect(e.opacity).toBe(0.5);
  });

  it('種類は先頭のバイトで見分ける（デスクトップ版は種類を持たない）', () => {
    expect(dataUrlOfBase64('iVBORw0KGgoAAA')).toContain('image/png');
    expect(dataUrlOfBase64('/9j/4AAQSkZJRg')).toContain('image/jpeg');
    expect(dataUrlOfBase64('R0lGODlhAQABAI')).toContain('image/gif');
  });

  it('すでに data URL ならそのまま返す', () => {
    expect(dataUrlOfBase64(PNG_1PX)).toBe(PNG_1PX);
  });

  it('中身が空の画像は読み飛ばして件数に数える', () => {
    const dto: Tc2DocDto = {
      Layers: [{ Name: '0', Color: 0xffffffff, Visible: true }],
      CurrentLayer: '0',
      Entities: [{ Kind: 'Image', Pts: [0, 0, 8, 4], Color: 0xffffffff, Img: '' }],
    };
    const r = tc2JsonToDocument(dto);
    expect(r.json.entities).toHaveLength(0);
    expect(r.skipped['Image']).toBe(1);
  });

  it('DXF には配置枠だけが出る（ラスタは埋め込めない）', () => {
    const json: DocumentJson = {
      format: 'tr-cad2w',
      version: FILE_FORMAT_VERSION,
      lineTypeScale: 500,
      layers: [...STANDARD_LAYERS],
      entities: [image()],
    };
    const dxf = documentToDxf(json);
    expect(dxf).toContain('\nLWPOLYLINE\n');
    expect(dxf).not.toContain('iVBORw0KGgo');
  });
});

describe('ハッチ・挿入の .tc2 往復', () => {
  const roundTrip = (entities: DocumentJson['entities'], blocks?: DocumentJson['blocks']): DocumentJson => {
    const json: DocumentJson = {
      format: 'tr-cad2w',
      version: FILE_FORMAT_VERSION,
      lineTypeScale: 500,
      layers: [...STANDARD_LAYERS],
      entities,
    };
    if (blocks) json.blocks = blocks;
    return tc2JsonToDocument(documentToTc2Json(json) as Tc2DocDto).json;
  };

  const hatch: HatchEntity = {
    ...DEFAULT_ATTRS,
    id: 1,
    kind: 'hatch',
    points: [vec(0, 0), vec(8, 0), vec(8, 8), vec(0, 8)],
    pattern: 'cross',
    spacing: 250,
  };

  it('ハッチはパターンと間隔を保って往復する', () => {
    const back = roundTrip([hatch]).entities[0];
    if (back?.kind !== 'hatch') throw new Error('ハッチとして戻ってきていません');
    expect(back.pattern).toBe('cross');
    expect(back.spacing).toBe(250);
    expect(back.points).toHaveLength(4);
  });

  it('5 種のパターンがすべて往復する', () => {
    for (const p of ['solid', 'line45', 'line135', 'cross', 'grid'] as const) {
      const back = roundTrip([{ ...hatch, pattern: p }]).entities[0];
      if (back?.kind !== 'hatch') throw new Error('ハッチとして戻ってきていません');
      expect(back.pattern).toBe(p);
    }
  });

  it('挿入はブロック定義ごと往復する', () => {
    const ins: InsertEntity = {
      ...DEFAULT_ATTRS,
      id: 2,
      kind: 'insert',
      blockName: 'A',
      at: vec(3, 4),
      scale: 2,
      scaleY: 0,
      rotation: Math.PI / 2,
    };
    const blk = makeBlock('A', [{ ...DEFAULT_ATTRS, id: 1, kind: 'line', a: vec(0, 0), b: vec(2, 0) }]);
    const back = roundTrip([ins], [blk]);
    const e = back.entities[0];
    if (e?.kind !== 'insert') throw new Error('挿入として戻ってきていません');
    expect(e.blockName).toBe('A');
    expect(e.at).toEqual(vec(3, 4));
    expect(e.scale).toBe(2);
    expect(e.rotation).toBeCloseTo(Math.PI / 2, 12);
    expect(back.blocks?.[0]?.entities).toHaveLength(1);
  });
});
