import { describe, expect, it } from 'vitest';
import { CadDocument } from '../src/core/document.js';
import { DEFAULT_ATTRS, type ArcEntity, type PolylineEntity, type TextEntity } from '../src/core/entity.js';
import { vec } from '../src/core/geometry.js';
import { VB_BLACK } from '../src/core/layer.js';
import {
  TC2_ENTRY,
  argbToHex,
  defaultTc2FileName,
  documentToTc2Json,
  hexToArgb,
  readTc2,
  tc2JsonToDocument,
  writeTc2,
  type Tc2DocDto,
} from '../src/io/tc2.js';
import { unzip } from '../src/io/zip.js';

/**
 * デスクトップ版が書く JSON を模したもの。
 * 形は `CadDocument.cs` の `DocDto` / `Dto` / `LayerDto` に合わせている。
 */
function desktopJson(over: Partial<Tc2DocDto> = {}): Tc2DocDto {
  return {
    Layers: [
      { Name: '0', Color: 0xffffffff, Visible: true },
      { Name: '境界', Color: 0xff0000ff, Visible: true },
    ],
    CurrentLayer: '0',
    Entities: [],
    ...over,
  };
}

describe('色の変換', () => {
  it('0xAARRGGBB ⇔ #rrggbb', () => {
    expect(argbToHex(0xffffffff)).toBe('#ffffff');
    expect(argbToHex(0xff0000ff)).toBe('#0000ff');
    expect(argbToHex(0xff008000)).toBe('#008000');
    expect(hexToArgb('#0000ff')).toBe(0xff0000ff);
    expect(hexToArgb(VB_BLACK)).toBe(0xffffffff);
  });

  it('アルファは捨てて往復する', () => {
    expect(hexToArgb(argbToHex(0x80ff0000))).toBe(0xffff0000);
  });
});

describe('デスクトップ版 JSON の読込', () => {
  it('図形の種類ごとに読める', () => {
    const res = tc2JsonToDocument(
      desktopJson({
        Entities: [
          { Kind: 'Line', Pts: [0, 0, 8, 4], Color: 0xffffffff },
          { Kind: 'Rect', Pts: [0, 0, 8, 4], Color: 0xffffffff },
          { Kind: 'Circle', Pts: [4, 4], Radius: 2, Color: 0xffffffff },
          { Kind: 'Arc', Pts: [0, 0], Radius: 8, ArcStart: 90, ArcEnd: 180, Color: 0xffffffff },
          { Kind: 'Point', Pts: [1, 2], Color: 0xffffffff },
          { Kind: 'Polyline', Pts: [0, 0, 8, 0, 8, 4], Color: 0xffffffff },
        ],
      }),
    );
    expect(res.json.entities.map((e) => e.kind)).toEqual(['line', 'rect', 'circle', 'arc', 'point', 'polyline']);
    const arc = res.json.entities[3] as ArcEntity;
    // デスクトップ版は度。ラジアンへ直す
    expect(arc.startAngle).toBeCloseTo(Math.PI / 2, 12);
    expect(arc.endAngle).toBeCloseTo(Math.PI, 12);
  });

  it('文字は度→ラジアン・揃えも変換する', () => {
    const res = tc2JsonToDocument(
      desktopJson({
        Entities: [
          {
            Kind: 'Text',
            Pts: [4, 8],
            Text: 'K1',
            Height: 500,
            Rotation: 90,
            Align: 'Center',
            VAlign: 'Middle',
            Color: 0xffffffff,
          },
        ],
      }),
    );
    const t = res.json.entities[0] as TextEntity;
    expect(t.text).toBe('K1');
    expect(t.rotation).toBeCloseTo(Math.PI / 2, 12);
    expect(t.hAlign).toBe('center');
    expect(t.vAlign).toBe('middle');
  });

  it('閉じた連続線は「最初と最後が同じ点」で判定する（閉合フラグが無いため）', () => {
    const res = tc2JsonToDocument(
      desktopJson({
        Entities: [
          { Kind: 'Polyline', Pts: [0, 0, 8, 0, 8, 4, 0, 0], Color: 0xffffffff },
          { Kind: 'Polyline', Pts: [0, 0, 8, 0, 8, 4], Color: 0xffffffff },
        ],
      }),
    );
    const closed = res.json.entities[0] as PolylineEntity;
    const open = res.json.entities[1] as PolylineEntity;
    expect(closed.closed).toBe(true);
    expect(closed.points).toHaveLength(3); // 重複した終点は落とす
    expect(open.closed).toBe(false);
    expect(open.points).toHaveLength(3);
  });

  it('画層色と同じ色は ByLayer として持つ', () => {
    const res = tc2JsonToDocument(
      desktopJson({
        Entities: [
          { Kind: 'Line', Pts: [0, 0, 1, 1], Layer: '境界', Color: 0xff0000ff }, // 画層色と同じ
          { Kind: 'Line', Pts: [0, 0, 1, 1], Layer: '境界', Color: 0xffff0000 }, // 違う
        ],
      }),
    );
    expect(res.json.entities[0]!.color).toBeNull();
    expect(res.json.entities[1]!.color).toBe('#ff0000');
  });

  it('線種と線幅', () => {
    const res = tc2JsonToDocument(
      desktopJson({
        Entities: [{ Kind: 'Line', Pts: [0, 0, 1, 1], LineType: 'DashDot', LineWeight: 0.5, Color: 0xffffffff }],
      }),
    );
    expect(res.json.entities[0]).toMatchObject({ lineStyle: 'dashdot', lineWidth: 0.5 });
  });

  it('Web 版に無い図形は件数を数えて飛ばす', () => {
    const res = tc2JsonToDocument(
      desktopJson({
        Entities: [
          { Kind: 'Hatch', Pts: [0, 0, 1, 1] },
          { Kind: 'Insert', Pts: [0, 0] },
          { Kind: 'Dimension', Pts: [0, 0, 1, 1] },
          { Kind: 'Image', Pts: [0, 0, 1, 1] },
          { Kind: 'Hatch', Pts: [0, 0, 2, 2] },
          { Kind: 'Line', Pts: [0, 0, 1, 1], Color: 0xffffffff },
        ],
      }),
    );
    expect(res.json.entities).toHaveLength(1);
    expect(res.skipped).toEqual({ Hatch: 2, Insert: 1, Dimension: 1, Image: 1 });
  });

  it('図形以外で落ちるものを名前で報告する', () => {
    const res = tc2JsonToDocument(
      desktopJson({
        Entities: [{ Kind: 'Line', Pts: [0, 0, 1, 1], Color: 0xffffffff }],
        Obs: [{ Name: 'T1' }],
        Coord: [{ Name: 'K1' }],
        Level: [],
        MemoText: 'メモ',
      } as Partial<Tc2DocDto>),
    );
    expect(res.droppedSections).toEqual(expect.arrayContaining(['観測データ', '座標', 'メモ']));
    expect(res.droppedSections).not.toContain('レベル'); // 空配列は落ちたうちに入れない
  });

  it('線種尺度（LtScale）を読む。無ければ 500', () => {
    expect(tc2JsonToDocument(desktopJson({ LtScale: 250 })).json.lineTypeScale).toBe(250);
    expect(tc2JsonToDocument(desktopJson()).json.lineTypeScale).toBe(500);
  });

  it('画層 0 が無いファイルでも画層 0 を作る', () => {
    const res = tc2JsonToDocument(
      desktopJson({ Layers: [{ Name: '境界', Color: 0xff0000ff, Visible: true }] }),
    );
    expect(res.json.layers.map((l) => l.name)).toContain('0');
  });

  it('形が違うファイルは読まない', () => {
    expect(() => tc2JsonToDocument({ foo: 1 } as unknown as Tc2DocDto)).toThrow();
  });
});

describe('デスクトップ版 JSON への書出', () => {
  it('デスクトップ版の形（Kind / Pts / Color / LtScale）で出す', () => {
    const doc = new CadDocument();
    doc.lineTypeScale = 250;
    doc.add({ ...DEFAULT_ATTRS, kind: 'line', a: vec(0, 0), b: vec(8, 4) });
    const dto = documentToTc2Json(doc.toJson());

    expect(dto.CurrentLayer).toBe('0');
    expect(dto.LtScale).toBe(250);
    expect(dto.Entities[0]).toMatchObject({ Kind: 'Line', Pts: [0, 0, 8, 4], Layer: '0', LineType: 'Continuous' });
    // ByLayer は画層色に解決して書く（デスクトップ版に ByLayer が無い）
    expect(dto.Entities[0]!.Color).toBe(0xffffffff);
    expect(dto.Layers[0]).toMatchObject({ Name: '0', Color: 0xffffffff, Visible: true });
  });

  it('閉じた連続線は最後に始点を足す', () => {
    const doc = new CadDocument();
    doc.add({ ...DEFAULT_ATTRS, kind: 'polyline', points: [vec(0, 0), vec(8, 0), vec(8, 4)], closed: true });
    expect(documentToTc2Json(doc.toJson()).Entities[0]!.Pts).toEqual([0, 0, 8, 0, 8, 4, 0, 0]);
  });

  it('角度は度で出す', () => {
    const doc = new CadDocument();
    doc.add({
      ...DEFAULT_ATTRS,
      kind: 'arc',
      center: vec(0, 0),
      radius: 8,
      startAngle: Math.PI / 2,
      endAngle: Math.PI,
    });
    const dto = documentToTc2Json(doc.toJson()).Entities[0]!;
    expect(dto.ArcStart).toBeCloseTo(90, 9);
    expect(dto.ArcEnd).toBeCloseTo(180, 9);
  });
});

describe('.tc2 ファイルの往復', () => {
  function sampleDoc(): CadDocument {
    const doc = new CadDocument();
    doc.lineTypeScale = 250;
    doc.add({ ...DEFAULT_ATTRS, kind: 'line', a: vec(0, 0), b: vec(1000, 500) });
    doc.add({ ...DEFAULT_ATTRS, layer: '境界', lineStyle: 'dashdot', lineWidth: 0.5, kind: 'circle', center: vec(500, 250), radius: 100 });
    doc.add({ ...DEFAULT_ATTRS, kind: 'polyline', points: [vec(0, 0), vec(100, 0), vec(100, 50)], closed: true });
    doc.add({
      ...DEFAULT_ATTRS,
      layer: '点番',
      kind: 'text',
      at: vec(10, 20),
      text: '筆界点 K1',
      height: 300,
      rotation: Math.PI / 4,
      hAlign: 'right',
      vAlign: 'top',
    });
    return doc;
  }

  it('中身は TrCad2D.json 1 件', async () => {
    const bytes = await writeTc2(sampleDoc().toJson());
    const entries = await unzip(bytes);
    expect(entries.map((e) => e.name)).toEqual([TC2_ENTRY]);
  });

  it('図形・画層・線種尺度が往復する', async () => {
    const src = sampleDoc();
    const res = await readTc2(await writeTc2(src.toJson()));
    const back = new CadDocument();
    back.loadJson(res.json);

    expect(back.count).toBe(src.count);
    expect(back.lineTypeScale).toBe(250);
    expect(back.entities.map((e) => e.kind)).toEqual(['line', 'circle', 'polyline', 'text']);
    expect(back.entities[1]).toMatchObject({ layer: '境界', lineStyle: 'dashdot', lineWidth: 0.5 });
    const poly = back.entities[2] as PolylineEntity;
    expect(poly.closed).toBe(true);
    expect(poly.points).toHaveLength(3);
    const t = back.entities[3] as TextEntity;
    expect(t.text).toBe('筆界点 K1');
    expect(t.height).toBe(300);
    expect(t.rotation).toBeCloseTo(Math.PI / 4, 9);
    expect(t.hAlign).toBe('right');
    expect(t.vAlign).toBe('top');
  });

  it('画層の色と表示が往復する', async () => {
    const src = new CadDocument();
    const layer = src.layers.get('境界')!;
    src.layers.set({ ...layer, visible: false });
    src.add({ ...DEFAULT_ATTRS, layer: '境界', kind: 'line', a: vec(0, 0), b: vec(1, 1) });

    const res = await readTc2(await writeTc2(src.toJson()));
    const back = new CadDocument();
    back.loadJson(res.json);
    expect(back.layers.get('境界')).toMatchObject({ color: '#0000ff', visible: false });
  });

  it('**画層の線種は落ちる**（デスクトップ版の画層は色と表示だけ）', async () => {
    const src = new CadDocument();
    src.add({ ...DEFAULT_ATTRS, layer: '境界', kind: 'line', a: vec(0, 0), b: vec(1, 1) });
    const res = await readTc2(await writeTc2(src.toJson()));
    // 元は dashdot だが、往復すると solid になる
    expect(src.layers.get('境界')?.lineStyle).toBe('dashdot');
    expect(res.json.layers.find((l) => l.name === '境界')?.lineStyle).toBe('solid');
  });

  it('.tc2 でないものは読まない', async () => {
    await expect(readTc2(new TextEncoder().encode('{"format":"tr-cad2w"}'))).rejects.toThrow('ZIP ではない');
  });

  it('中身が JSON でない ZIP は読まない', async () => {
    const { zip } = await import('../src/io/zip.js');
    const bytes = await zip([{ name: TC2_ENTRY, bytes: new TextEncoder().encode('not json') }]);
    await expect(readTc2(bytes)).rejects.toThrow();
  });

  it('保存名は 図面-日付.tc2', () => {
    expect(defaultTc2FileName(new Date(2026, 7, 14, 15, 30))).toBe('図面-20260814-1530.tc2');
  });
});
