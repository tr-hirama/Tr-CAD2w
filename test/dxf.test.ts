import { describe, expect, it } from 'vitest';
import {
  aciToColor,
  decodeDxf,
  dxfToDocumentJson,
  lineStyleOfName,
  lineWeightToMm,
  readDxfBytes,
  tokenize,
  trueColorToHex,
  unescapeMText,
} from '../src/io/dxf.js';
import { CadDocument } from '../src/core/document.js';
import type { ArcEntity, CircleEntity, Entity, LineEntity, PolylineEntity, TextEntity } from '../src/core/entity.js';
import { VB_BLACK } from '../src/core/layer.js';
import { vec } from '../src/core/geometry.js';
import { documentToDxf } from '../src/io/dxf-write.js';

/** DXF テキストを組み立てる。値は行ごとに (code, value) の対。 */
function dxf(...sections: string[]): string {
  return sections.join('\n') + '\n';
}

const HEADER = ['0', 'SECTION', '2', 'HEADER', '9', '$LTSCALE', '40', '250.0', '0', 'ENDSEC'].join('\n');

const LAYER_TABLE = [
  '0',
  'SECTION',
  '2',
  'TABLES',
  '0',
  'TABLE',
  '2',
  'LAYER',
  '70',
  '2',
  '0',
  'LAYER',
  '2',
  '0',
  '70',
  '0',
  '62',
  '7',
  '6',
  'CONTINUOUS',
  '0',
  'LAYER',
  '2',
  '境界',
  '70',
  '0',
  '62',
  '5',
  '6',
  'DASHDOT',
  '0',
  'ENDTAB',
  '0',
  'ENDSEC',
].join('\n');

function entities(...body: string[]): string {
  return ['0', 'SECTION', '2', 'ENTITIES', ...body, '0', 'ENDSEC', '0', 'EOF'].join('\n');
}

describe('tokenize', () => {
  it('コードと値の対に分解する（CRLF も可）', () => {
    expect(tokenize('  0\r\nSECTION\r\n  2\r\nHEADER\r\n')).toEqual([
      { code: 0, value: 'SECTION' },
      { code: 2, value: 'HEADER' },
    ]);
  });

  it('コードが数値でない行は捨てる', () => {
    expect(tokenize('x\nfoo\n0\nEOF\n')).toEqual([{ code: 0, value: 'EOF' }]);
  });
});

describe('エンティティの読込', () => {
  it('LINE', () => {
    const res = dxfToDocumentJson(
      dxf(HEADER, entities('0', 'LINE', '8', '0', '10', '4', '20', '8', '11', '16', '21', '32')),
    );
    expect(res.json.entities).toHaveLength(1);
    const e = res.json.entities[0] as LineEntity;
    expect(e.kind).toBe('line');
    expect(e.a).toEqual({ x: 4, y: 8 });
    expect(e.b).toEqual({ x: 16, y: 32 });
  });

  it('CIRCLE と半径 0 の除外', () => {
    const res = dxfToDocumentJson(
      dxf(
        HEADER,
        entities(
          '0', 'CIRCLE', '8', '0', '10', '4', '20', '8', '40', '16',
          '0', 'CIRCLE', '8', '0', '10', '0', '20', '0', '40', '0',
        ),
      ),
    );
    expect(res.json.entities).toHaveLength(1);
    const e = res.json.entities[0] as CircleEntity;
    expect(e.center).toEqual({ x: 4, y: 8 });
    expect(e.radius).toBe(16);
  });

  it('ARC は度→ラジアン（反時計回りのまま）', () => {
    const res = dxfToDocumentJson(
      dxf(HEADER, entities('0', 'ARC', '8', '0', '10', '0', '20', '0', '40', '8', '50', '90', '51', '180')),
    );
    const e = res.json.entities[0] as ArcEntity;
    expect(e.startAngle).toBeCloseTo(Math.PI / 2, 12);
    expect(e.endAngle).toBeCloseTo(Math.PI, 12);
  });

  it('LWPOLYLINE は閉合フラグ 70 を読む', () => {
    const res = dxfToDocumentJson(
      dxf(
        HEADER,
        entities(
          '0', 'LWPOLYLINE', '8', '0', '90', '3', '70', '1',
          '10', '0', '20', '0',
          '10', '8', '20', '0',
          '10', '8', '20', '4',
        ),
      ),
    );
    const e = res.json.entities[0] as PolylineEntity;
    expect(e.kind).toBe('polyline');
    expect(e.points).toEqual([
      { x: 0, y: 0 },
      { x: 8, y: 0 },
      { x: 8, y: 4 },
    ]);
    expect(e.closed).toBe(true);
  });

  it('POLYLINE + VERTEX（旧形式）', () => {
    const res = dxfToDocumentJson(
      dxf(
        HEADER,
        entities(
          '0', 'POLYLINE', '8', '境界', '66', '1', '70', '0',
          '0', 'VERTEX', '10', '0', '20', '0',
          '0', 'VERTEX', '10', '4', '20', '8',
          '0', 'VERTEX', '10', '16', '20', '8',
          '0', 'SEQEND',
          '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '1', '21', '1',
        ),
      ),
    );
    // SEQEND の後の LINE も読めている（巻き取り位置がずれていない）
    expect(res.json.entities.map((e) => e.kind)).toEqual(['polyline', 'line']);
    const e = res.json.entities[0] as PolylineEntity;
    expect(e.layer).toBe('境界');
    expect(e.points).toHaveLength(3);
    expect(e.closed).toBe(false);
  });

  it('POINT', () => {
    const res = dxfToDocumentJson(dxf(HEADER, entities('0', 'POINT', '8', '0', '10', '4', '20', '8')));
    expect(res.json.entities[0]).toMatchObject({ kind: 'point', at: { x: 4, y: 8 } });
  });

  it('未対応エンティティは件数を数えて読み飛ばす', () => {
    const res = dxfToDocumentJson(
      dxf(
        HEADER,
        entities(
          '0', 'INSERT', '8', '0', '2', 'BLK', '10', '0', '20', '0',
          '0', 'SOLID', '8', '0', '10', '0', '20', '0',
          '0', 'INSERT', '8', '0', '2', 'BLK', '10', '1', '20', '1',
          '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '1', '21', '1',
        ),
      ),
    );
    expect(res.json.entities).toHaveLength(1);
    expect(res.skipped).toEqual({ INSERT: 2, SOLID: 1 });
  });
});

describe('TEXT / MTEXT', () => {
  it('TEXT は高さ・回転・内容を読む', () => {
    const res = dxfToDocumentJson(
      dxf(HEADER, entities('0', 'TEXT', '8', '0', '10', '4', '20', '8', '40', '500', '50', '90', '1', 'K1')),
    );
    const e = res.json.entities[0] as TextEntity;
    expect(e.text).toBe('K1');
    expect(e.height).toBe(500);
    expect(e.rotation).toBeCloseTo(Math.PI / 2, 12);
    expect(e.at).toEqual({ x: 4, y: 8 });
    expect(e.hAlign).toBe('left');
    expect(e.vAlign).toBe('baseline');
  });

  it('揃えが左ベースライン以外なら第二揃え点 11/21 を挿入点にする', () => {
    const res = dxfToDocumentJson(
      dxf(
        HEADER,
        entities(
          '0', 'TEXT', '8', '0', '10', '0', '20', '0', '11', '4', '21', '8',
          '40', '250', '72', '1', '73', '2', '1', '中央',
        ),
      ),
    );
    const e = res.json.entities[0] as TextEntity;
    expect(e.at).toEqual({ x: 4, y: 8 });
    expect(e.hAlign).toBe('center');
    expect(e.vAlign).toBe('middle');
  });

  it('MTEXT は改行 \\P とアタッチメント 71 を読む', () => {
    const res = dxfToDocumentJson(
      dxf(
        HEADER,
        entities('0', 'MTEXT', '8', '0', '10', '0', '20', '0', '40', '300', '71', '9', '1', 'A\\PB'),
      ),
    );
    const e = res.json.entities[0] as TextEntity;
    expect(e.text).toBe('A\nB');
    expect(e.hAlign).toBe('right');
    expect(e.vAlign).toBe('bottom');
  });

  it('MTEXT の書式コードは落とす', () => {
    expect(unescapeMText('{\\fMSゴシック|b0|i0|c128|p49;寸法}\\P値')).toBe('寸法\n値');
    expect(unescapeMText('45%%d')).toBe('45°');
  });

  it('高さ 0 の文字は捨てる（描けないため）', () => {
    const res = dxfToDocumentJson(
      dxf(HEADER, entities('0', 'TEXT', '8', '0', '10', '0', '20', '0', '40', '0', '1', 'x')),
    );
    expect(res.json.entities).toHaveLength(0);
  });
});

describe('属性（色・画層・線種・線幅）', () => {
  it('420（トゥルーカラー）が 62（ACI）より優先される', () => {
    const res = dxfToDocumentJson(
      dxf(
        HEADER,
        entities('0', 'LINE', '8', '0', '62', '1', '420', String(0x0a58ca), '10', '0', '20', '0', '11', '1', '21', '1'),
      ),
    );
    expect(res.json.entities[0]!.color).toBe('#0a58ca');
  });

  it('62 = 256（ByLayer）は個別色なし', () => {
    const res = dxfToDocumentJson(
      dxf(HEADER, entities('0', 'LINE', '8', '0', '62', '256', '10', '0', '20', '0', '11', '1', '21', '1')),
    );
    expect(res.json.entities[0]!.color).toBeNull();
  });

  it('線種名から線種が決まる', () => {
    expect(lineStyleOfName('CONTINUOUS')).toBe('solid');
    expect(lineStyleOfName('BYLAYER')).toBe('solid');
    expect(lineStyleOfName('DASHED')).toBe('dashed');
    expect(lineStyleOfName('HIDDEN')).toBe('dashed');
    expect(lineStyleOfName('DOT')).toBe('dotted');
    expect(lineStyleOfName('DASHDOT')).toBe('dashdot');
    expect(lineStyleOfName('CENTER')).toBe('center');
    expect(lineStyleOfName('得体の知れない線種')).toBe('solid');
  });

  it('線幅 370 は mm×100。ByLayer などは 0（極細）', () => {
    expect(lineWeightToMm(50)).toBe(0.5);
    expect(lineWeightToMm(-1)).toBe(0);
    expect(lineWeightToMm(-3)).toBe(0);
  });

  it('ACI 7 は白で持つ（明背景で黒に反転させるため）', () => {
    expect(aciToColor(7)).toBe(VB_BLACK);
    expect(aciToColor(1)).toBe('#ff0000');
    expect(aciToColor(5)).toBe('#0000ff');
  });

  it('トゥルーカラーの整数変換', () => {
    expect(trueColorToHex(0xff0000)).toBe('#ff0000');
    expect(trueColorToHex(0)).toBe('#000000');
  });
});

describe('LAYER テーブルとヘッダ', () => {
  it('画層の色・線種・表示を読む', () => {
    const res = dxfToDocumentJson(dxf(HEADER, LAYER_TABLE, entities()));
    const kyoukai = res.json.layers.find((l) => l.name === '境界');
    expect(kyoukai).toMatchObject({ color: '#0000ff', lineStyle: 'dashdot', visible: true });
    expect(res.json.layers.find((l) => l.name === '0')).toMatchObject({ color: VB_BLACK });
  });

  it('ACI が負の画層は表示 OFF', () => {
    const table = LAYER_TABLE.replace(['62', '5'].join('\n'), ['62', '-5'].join('\n'));
    const res = dxfToDocumentJson(dxf(HEADER, table, entities()));
    expect(res.json.layers.find((l) => l.name === '境界')?.visible).toBe(false);
  });

  it('$LTSCALE を線種尺度として読む', () => {
    expect(dxfToDocumentJson(dxf(HEADER, entities())).json.lineTypeScale).toBe(250);
  });

  it('$LTSCALE が無ければ既定の 500', () => {
    const noHeader = ['0', 'SECTION', '2', 'HEADER', '0', 'ENDSEC'].join('\n');
    expect(dxfToDocumentJson(dxf(noHeader, entities())).json.lineTypeScale).toBe(500);
  });

  it('LAYER テーブルに無い画層も作られる', () => {
    const res = dxfToDocumentJson(
      dxf(HEADER, LAYER_TABLE, entities('0', 'LINE', '8', '未知の画層', '10', '0', '20', '0', '11', '1', '21', '1')),
    );
    expect(res.json.layers.map((l) => l.name)).toContain('未知の画層');
  });

  it('CadDocument.loadJson にそのまま渡せる', () => {
    const res = dxfToDocumentJson(
      dxf(HEADER, LAYER_TABLE, entities('0', 'LINE', '8', '境界', '10', '0', '20', '0', '11', '8', '21', '4')),
    );
    const doc = new CadDocument();
    doc.loadJson(res.json);
    expect(doc.count).toBe(1);
    expect(doc.lineTypeScale).toBe(250);
    expect(doc.layers.get('境界')?.lineStyle).toBe('dashdot');
    // 採番が続く（id 衝突しない）
    expect(doc.bounds()).toEqual({ minX: 0, minY: 0, maxX: 8, maxY: 4 });
  });
});

describe('文字コードの判定', () => {
  const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
  /** Shift-JIS の「境界」= 0x8BAB 0x8A45。テストのために生バイトで持つ。 */
  const SJIS_KYOUKAI = [0x8b, 0xab, 0x8a, 0x45];

  /** 文字列とバイト列を混ぜてつなぐ（改行の位置を自分で持つため文字列は素で書く）。 */
  function concat(...parts: (string | Uint8Array)[]): Uint8Array {
    const bytes = parts.map((p) => (typeof p === 'string' ? utf8(p) : p));
    const out = new Uint8Array(bytes.reduce((n, b) => n + b.length, 0));
    let o = 0;
    for (const b of bytes) {
      out.set(b, o);
      o += b.length;
    }
    return out;
  }

  function sjisDxf(): Uint8Array {
    const name = new Uint8Array(SJIS_KYOUKAI);
    return concat(
      '0\nSECTION\n2\nHEADER\n9\n$DWGCODEPAGE\n3\nANSI_932\n0\nENDSEC\n',
      '0\nSECTION\n2\nENTITIES\n0\nTEXT\n8\n',
      name,
      '\n10\n0\n20\n0\n40\n500\n1\n',
      name,
      '\n0\nENDSEC\n0\nEOF\n',
    );
  }

  it('$DWGCODEPAGE=ANSI_932 なら Shift-JIS として読む', () => {
    const res = readDxfBytes(sjisDxf());
    expect(res.encoding).toBe('shift_jis (codepage)');
    const e = res.json.entities[0] as TextEntity;
    expect(e.text).toBe('境界');
    expect(e.layer).toBe('境界');
  });

  it('BOM つきは UTF-8', () => {
    const body = utf8(dxf(HEADER, entities('0', 'POINT', '8', '0', '10', '1', '20', '2')));
    const withBom = new Uint8Array(3 + body.length);
    withBom.set([0xef, 0xbb, 0xbf], 0);
    withBom.set(body, 3);
    expect(decodeDxf(withBom).reason).toBe('bom');
  });

  it('コードページが無く UTF-8 として妥当なら UTF-8', () => {
    const res = decodeDxf(utf8(dxf(HEADER, entities('0', 'POINT', '8', '日本語', '10', '1', '20', '2'))));
    expect(res.reason).toBe('utf8-valid');
    expect(res.encoding).toBe('utf-8');
  });

  it('コードページが無く UTF-8 として不正なら Shift-JIS へ倒す', () => {
    const bytes = concat(
      `${HEADER}\n`,
      '0\nSECTION\n2\nENTITIES\n0\nPOINT\n8\n',
      new Uint8Array(SJIS_KYOUKAI),
      '\n10\n1\n20\n2\n0\nENDSEC\n0\nEOF\n',
    );

    const res = readDxfBytes(bytes);
    expect(res.encoding).toBe('shift_jis (fallback)');
    expect(res.json.entities[0]!.layer).toBe('境界');
  });
});

describe('壊れた入力', () => {
  it('ENTITIES セクションが無ければ図形 0 件（例外は投げない）', () => {
    expect(dxfToDocumentJson('0\nEOF\n').json.entities).toHaveLength(0);
  });

  it('空文字列でも落ちない', () => {
    expect(dxfToDocumentJson('').json.entities).toHaveLength(0);
  });

  it('座標が欠けた LINE は原点として読む（行が落ちても止めない）', () => {
    const res = dxfToDocumentJson(dxf(HEADER, entities('0', 'LINE', '8', '0', '10', '4', '20', '8')));
    expect(res.json.entities[0]).toMatchObject({ kind: 'line', a: { x: 4, y: 8 }, b: { x: 0, y: 0 } });
  });
});

/**
 * 往復（読込→書出→再読込）で情報が落ちないことを機械的に確かめる。issue #3。
 *
 * **1 周目は正規化が入る**（矩形は DXF に無いので閉じた連続線になる）。
 * そこで「**2 周目からは一字一句変わらない**」を軸に据える。落ちる属性があると
 * 2 周目で必ずずれるので、正規化と欠落を混同せずに測れる。
 *
 * 座標の検証値は**二進小数として厳密な値**（4 / 8 / 0.25 / 1/64）を使う。丸めが
 * 浮動小数誤差でぶれない。角度が絡む円弧だけ `toBeCloseTo`。
 */
describe('往復（読込→書出→再読込）', () => {
  const TOL = 1e-9;

  /** 図形の比較に使う属性だけを取り出す（id は往復で振り直されるので見ない）。 */
  function shape(e: Entity): Record<string, unknown> {
    const { id: _id, ...rest } = e;
    return rest as Record<string, unknown>;
  }

  function writeRead(doc: CadDocument): CadDocument {
    const back = new CadDocument();
    back.loadJson(dxfToDocumentJson(documentToDxf(doc.toJson())).json);
    return back;
  }

  /** 全図形種・全属性を 1 枚に載せた図面。 */
  function sample(): CadDocument {
    const doc = new CadDocument();
    doc.lineTypeScale = 250;
    doc.addAll([
      { layer: '0', color: null, lineStyle: 'solid', lineWidth: 0, kind: 'line', a: vec(0, 0), b: vec(8, 4) },
      {
        layer: '境界',
        color: '#0a58ca',
        lineStyle: 'dashdot',
        lineWidth: 0.5,
        kind: 'circle',
        center: vec(16, 32),
        radius: 4,
      },
      {
        layer: '0',
        color: '#ff8000',
        lineStyle: 'dashed',
        lineWidth: 0.25,
        kind: 'arc',
        center: vec(-8, 0.25),
        radius: 8,
        startAngle: 0,
        endAngle: Math.PI / 2,
      },
      {
        layer: '点番',
        color: null,
        lineStyle: 'dotted',
        lineWidth: 0.13,
        kind: 'polyline',
        points: [vec(0, 0), vec(8, 0), vec(8, 4)],
        closed: true,
      },
      {
        layer: '0',
        color: null,
        lineStyle: 'solid',
        lineWidth: 0,
        kind: 'polyline',
        points: [vec(0, 64), vec(0.015625, 64)],
        closed: false,
      },
      { layer: '点番', color: null, lineStyle: 'solid', lineWidth: 0, kind: 'point', at: vec(-4, 0.25) },
      {
        layer: '0',
        color: '#00ff00',
        lineStyle: 'solid',
        lineWidth: 0,
        kind: 'text',
        at: vec(4, 8),
        text: '境界点 A',
        height: 2.5,
        rotation: 0,
        hAlign: 'center',
        vAlign: 'middle',
      },
      { layer: '0', color: null, lineStyle: 'solid', lineWidth: 0, kind: 'rect', a: vec(0, 0), b: vec(8, 4) },
    ]);
    return doc;
  }

  it('図形数が保たれる（矩形も 1 図形として戻る）', () => {
    const src = sample();
    const back = writeRead(src);
    expect(back.count).toBe(src.count);
  });

  it('座標が 1e-9 の許容で一致する', () => {
    const back = writeRead(sample());
    const line = back.entities[0] as LineEntity;
    expect(line.a.x).toBeCloseTo(0, 9);
    expect(line.b.x).toBeCloseTo(8, 9);
    expect(line.b.y).toBeCloseTo(4, 9);

    const circle = back.entities[1] as CircleEntity;
    expect(Math.abs(circle.center.x - 16)).toBeLessThan(TOL);
    expect(Math.abs(circle.center.y - 32)).toBeLessThan(TOL);
    expect(Math.abs(circle.radius - 4)).toBeLessThan(TOL);

    // 1/64 = 0.015625 は二進小数として厳密。桁を削られていたらここで出る
    const short = back.entities[4] as PolylineEntity;
    expect(short.points[1]!.x).toBe(0.015625);
  });

  it('円弧の角度は反時計回りのまま戻る', () => {
    const arc = writeRead(sample()).entities[2] as ArcEntity;
    expect(arc.startAngle).toBeCloseTo(0, 9);
    expect(arc.endAngle).toBeCloseTo(Math.PI / 2, 9);
    expect(Math.abs(arc.radius - 8)).toBeLessThan(TOL);
  });

  it('色・画層・線種・線幅がすべて一致する', () => {
    const back = writeRead(sample());
    expect(back.entities.map((e) => e.layer)).toEqual(['0', '境界', '0', '点番', '0', '点番', '0', '0']);
    expect(back.entities.map((e) => e.color)).toEqual([
      null,
      '#0a58ca',
      '#ff8000',
      null,
      null,
      null,
      '#00ff00',
      null,
    ]);
    expect(back.entities.map((e) => e.lineStyle)).toEqual([
      'solid',
      'dashdot',
      'dashed',
      'dotted',
      'solid',
      'solid',
      'solid',
      'solid',
    ]);
    expect(back.entities.map((e) => e.lineWidth)).toEqual([0, 0.5, 0.25, 0.13, 0, 0, 0, 0]);
  });

  /**
   * **DXF の線幅は列挙値しか許さない**（mm×100 で 0/5/9/13/15/18/…）。
   * 列挙外の値を書くと他 CAD のリーダーに弾かれるので、最寄りへスナップする。
   * **往復で値が変わる唯一の属性**なので、変わり方をここで固定しておく。
   */
  it('列挙にない線幅は最寄りの DXF 線幅へスナップされる', () => {
    const doc = new CadDocument();
    doc.addAll([
      { layer: '0', color: null, lineStyle: 'solid', lineWidth: 0.125, kind: 'line', a: vec(0, 0), b: vec(4, 0) },
      { layer: '0', color: null, lineStyle: 'solid', lineWidth: 0.44, kind: 'line', a: vec(0, 4), b: vec(4, 4) },
    ]);
    const back = writeRead(doc);
    // 12.5 → 13、44 → 40（どちらも最寄りの列挙値）
    expect(back.entities.map((e) => e.lineWidth)).toEqual([0.13, 0.4]);
    // スナップ後は 2 周目で動かない
    expect(writeRead(back).entities.map((e) => e.lineWidth)).toEqual([0.13, 0.4]);
  });
  it('lineTypeScale が保たれる', () => {
    expect(writeRead(sample()).lineTypeScale).toBe(250);
  });

  it('連続線の閉合フラグが保たれる', () => {
    const back = writeRead(sample());
    expect((back.entities[3] as PolylineEntity).closed).toBe(true);
    expect((back.entities[4] as PolylineEntity).closed).toBe(false);
  });

  it('文字の内容・高さ・揃えが保たれる', () => {
    const t = writeRead(sample()).entities[6] as TextEntity;
    expect(t).toMatchObject({ text: '境界点 A', height: 2.5, hAlign: 'center', vAlign: 'middle' });
  });

  it('矩形は閉じた連続線になる（DXF に矩形が無いため）', () => {
    const r = writeRead(sample()).entities[7] as PolylineEntity;
    expect(r.kind).toBe('polyline');
    expect(r.closed).toBe(true);
    expect(r.points).toEqual([vec(0, 0), vec(8, 0), vec(8, 4), vec(0, 4)]);
  });

  it('2 周目からは図形が一字一句変わらない', () => {
    const first = writeRead(sample());
    const second = writeRead(first);
    expect(second.entities.map(shape)).toEqual(first.entities.map(shape));
  });

  it('3 周目でも変わらない（誤差が積み上がらない）', () => {
    const first = writeRead(sample());
    const third = writeRead(writeRead(first));
    expect(third.entities.map(shape)).toEqual(first.entities.map(shape));
  });

  it('画層の色・線種・表示が保たれる', () => {
    const src = sample();
    const layer = src.layers.get('境界')!;
    src.layers.set({ ...layer, visible: false });
    const back = writeRead(src);
    expect(back.layers.get('境界')).toMatchObject({ color: '#0000ff', lineStyle: 'dashdot', visible: false });
    expect(back.layers.get('点番')?.color).toBe(src.layers.get('点番')?.color);
  });

  it('図面の範囲（bounds）が一致する', () => {
    const src = sample();
    const back = writeRead(src);
    const a = src.bounds();
    const b = back.bounds();
    expect(Math.abs(a.minX - b.minX)).toBeLessThan(TOL);
    expect(Math.abs(a.minY - b.minY)).toBeLessThan(TOL);
    expect(Math.abs(a.maxX - b.maxX)).toBeLessThan(TOL);
    expect(Math.abs(a.maxY - b.maxY)).toBeLessThan(TOL);
  });

  it('日本語の画層名・文字が化けない', () => {
    const back = writeRead(sample());
    expect(back.entities.some((e) => e.layer === '境界')).toBe(true);
    expect(back.entities.some((e) => e.layer === '点番')).toBe(true);
    expect((back.entities[6] as TextEntity).text).toBe('境界点 A');
  });
});
