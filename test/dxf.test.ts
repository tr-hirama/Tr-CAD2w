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
import type { ArcEntity, CircleEntity, LineEntity, PolylineEntity, TextEntity } from '../src/core/entity.js';
import { VB_BLACK } from '../src/core/layer.js';

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
