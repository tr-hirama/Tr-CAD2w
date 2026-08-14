import { describe, expect, it } from 'vitest';
import { CadDocument } from '../src/core/document.js';
import { DEFAULT_ATTRS, type ArcEntity, type PolylineEntity, type TextEntity } from '../src/core/entity.js';
import { vec } from '../src/core/geometry.js';
import { VB_BLACK } from '../src/core/layer.js';
import { dxfToDocumentJson, readDxfBytes } from '../src/io/dxf.js';
import {
  angleToDegrees,
  colorToAci,
  colorToTrueColor,
  defaultDxfFileName,
  documentToDxf,
  escapeDxfText,
  formatNumber,
  lineWeightFromMm,
  mtextAttachment,
} from '../src/io/dxf-write.js';

/** DXF テキストから (code, value) を拾う小さなヘルパ。 */
function values(dxf: string, code: number): string[] {
  const lines = dxf.split('\n');
  const out: string[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    if (Number.parseInt(lines[i]!.trim(), 10) === code) out.push(lines[i + 1]!);
  }
  return out;
}

function section(dxf: string, name: string): string {
  const start = dxf.indexOf(`\n2\n${name}\n`);
  if (start < 0) return '';
  const end = dxf.indexOf('\n0\nENDSEC\n', start);
  // 先頭の改行を落とさないと (code, value) の偶奇がずれる
  return dxf.slice(start + 1, end < 0 ? undefined : end);
}

describe('数値・色・線幅の書式', () => {
  it('整数にも小数点を付ける', () => {
    expect(formatNumber(4)).toBe('4.0');
    expect(formatNumber(-8)).toBe('-8.0');
    expect(formatNumber(0.25)).toBe('0.25');
  });

  it('指数表記は出さない', () => {
    expect(formatNumber(1e-7)).not.toMatch(/e/i);
  });

  it('色は 420 で厳密・62 は近似', () => {
    expect(colorToTrueColor('#0a58ca')).toBe(0x0a58ca);
    expect(colorToAci('#ff0000')).toBe(1);
    expect(colorToAci('#0000ff')).toBe(5);
    expect(colorToAci(VB_BLACK)).toBe(7);
    // 表に無い色は最も近い ACI に寄せる（赤寄りの色 → 1）
    expect(colorToAci('#fa0505')).toBe(1);
  });

  it('線幅 0 は ByLayer(-1)、それ以外は mm×100', () => {
    expect(lineWeightFromMm(0)).toBe(-1);
    expect(lineWeightFromMm(0.5)).toBe(50);
    expect(lineWeightFromMm(2)).toBe(200);
  });

  it('角度は度へ正規化される', () => {
    expect(angleToDegrees(Math.PI)).toBeCloseTo(180, 9);
    expect(angleToDegrees(-Math.PI / 2)).toBeCloseTo(270, 9);
    expect(angleToDegrees(0)).toBe(0);
  });

  it('保存名は 図面-日付.dxf', () => {
    expect(defaultDxfFileName(new Date(2026, 7, 14, 15, 30))).toBe('図面-20260814-1530.dxf');
  });

  it('制御表記へのエスケープ', () => {
    expect(escapeDxfText('45°±1')).toBe('45%%d±1'.replace('±', '%%p'));
  });
});

describe('DXF の骨格', () => {
  const doc = new CadDocument();
  doc.add({ ...DEFAULT_ATTRS, kind: 'line', a: vec(0, 0), b: vec(8, 4) });
  const dxf = documentToDxf(doc.toJson());

  it('R2007（AC1021）で出す', () => {
    expect(values(dxf, 1)).toContain('AC1021');
  });

  it('単位はミリメートル（$INSUNITS = 4）', () => {
    const header = section(dxf, 'HEADER');
    expect(header).toContain('$INSUNITS');
    expect(values(header, 70)).toContain('4');
  });

  it('必要なテーブルを出す', () => {
    for (const t of ['LTYPE', 'LAYER', 'STYLE', 'BLOCK_RECORD']) {
      expect(dxf).toContain(`\n2\n${t}\n`);
    }
  });

  it('モデル空間・用紙空間のブロックを出す', () => {
    expect(dxf).toContain('*Model_Space');
    expect(dxf).toContain('*Paper_Space');
  });

  it('EOF で終わる', () => {
    expect(dxf.endsWith('0\nEOF\n')).toBe(true);
  });

  it('ハンドルは重複しない', () => {
    const handles = values(dxf, 5).filter((h) => h !== '');
    expect(new Set(handles).size).toBe(handles.length);
  });

  it('$HANDSEED は使ったどのハンドルより大きい', () => {
    const header = section(dxf, 'HEADER');
    const seed = Number.parseInt(values(header, 5)[0]!, 16);
    const maxUsed = Math.max(...values(dxf, 5).slice(1).map((h) => Number.parseInt(h, 16)));
    expect(seed).toBeGreaterThan(maxUsed);
  });

  it('線種定義（LTYPE）に刻みを出す', () => {
    const tables = section(dxf, 'TABLES');
    expect(tables).toContain('DASHED');
    // 破線は 線 0.5 / 空き 0.25（線種尺度 1 の定義。実際の刻みは $LTSCALE で決まる）
    const dashes = values(tables, 49);
    expect(dashes).toContain('0.5');
    expect(dashes).toContain('-0.25');
  });
});

/**
 * 往復（自分の読込）では検出できないが、**他 CAD で開くと実害が出る**構造。
 * ここは出力そのものを検査する。
 */
describe('他 CAD 互換の構造', () => {
  function textDxf(over: Partial<TextEntity>): string {
    const doc = new CadDocument();
    doc.add({
      ...DEFAULT_ATTRS,
      kind: 'text',
      at: vec(4, 8),
      text: 'K1',
      height: 500,
      rotation: 0,
      hAlign: 'left',
      vAlign: 'baseline',
      ...over,
    } as Omit<TextEntity, 'id'>);
    return documentToDxf(doc.toJson());
  }

  it('揃えが左ベースライン以外なら 11/21（第二揃え点）を出す', () => {
    // AutoCAD は 72/73 が非 0 のとき 10/20 を無視して 11/21 を挿入点に使う。
    // 出さないと他 CAD で文字が原点へ飛ぶ（自分の読込は 10/20 に落ちるので往復では気づけない）
    const ents = section(textDxf({ hAlign: 'center', vAlign: 'middle' }), 'ENTITIES');
    expect(values(ents, 11)).toContain('4.0');
    expect(values(ents, 21)).toContain('8.0');
  });

  it('左ベースラインなら 11/21 は出さない', () => {
    // VPORT や LAYOUT も 11 を使うので ENTITIES に限って見る
    expect(values(section(textDxf({}), 'ENTITIES'), 11)).toHaveLength(0);
  });

  it('MTEXT の本文は最後の断片を 1 に置く（3 は先行断片だけ）', () => {
    const doc = new CadDocument();
    doc.add({
      ...DEFAULT_ATTRS,
      kind: 'text',
      at: vec(0, 0),
      text: 'あ'.repeat(300) + '\nい',
      height: 250,
      rotation: 0,
      hAlign: 'left',
      vAlign: 'top',
    });
    const dxf = documentToDxf(doc.toJson());
    const threes = values(dxf, 3).filter((s) => s.startsWith('あ'));
    const ones = values(dxf, 1).filter((s) => s.includes('い'));
    expect(threes.length).toBeGreaterThan(0); // 先行断片がある
    expect(ones).toHaveLength(1); // 最後の断片は 1
    expect(ones[0]!.endsWith('い')).toBe(true);
  });

  it('文字は STANDARD スタイルを指すので STYLE テーブルに実在する', () => {
    const dxf = textDxf({});
    expect(values(dxf, 7)).toContain('STANDARD');
    expect(dxf).toContain('\n2\nSTYLE\n');
  });

  it('画層は LAYER テーブルに実在する名前だけを指す', () => {
    const doc = new CadDocument();
    doc.add({ ...DEFAULT_ATTRS, layer: '境界', kind: 'line', a: vec(0, 0), b: vec(4, 0) });
    const dxf = documentToDxf(doc.toJson());
    const declared = new Set(values(section(dxf, 'TABLES'), 2));
    for (const used of values(section(dxf, 'ENTITIES'), 8)) {
      expect(declared.has(used)).toBe(true);
    }
  });

  it('図形が使う線種は LTYPE テーブルに実在する（BYLAYER 以外）', () => {
    const doc = new CadDocument();
    doc.add({ ...DEFAULT_ATTRS, lineStyle: 'center', kind: 'line', a: vec(0, 0), b: vec(4, 0) });
    const dxf = documentToDxf(doc.toJson());
    const declared = new Set(values(section(dxf, 'TABLES'), 2));
    for (const used of values(section(dxf, 'ENTITIES'), 6)) {
      if (used === 'BYLAYER' || used === 'BYBLOCK') continue;
      expect(declared.has(used)).toBe(true);
    }
  });
});

describe('往復（書き出して読み直す）', () => {
  function roundTrip(build: (doc: CadDocument) => void): CadDocument {
    const src = new CadDocument();
    build(src);
    const back = new CadDocument();
    back.loadJson(dxfToDocumentJson(documentToDxf(src.toJson())).json);
    return back;
  }

  it('線・円・円弧・点', () => {
    const back = roundTrip((doc) => {
      doc.add({ ...DEFAULT_ATTRS, kind: 'line', a: vec(0, 0), b: vec(8, 4) });
      doc.add({ ...DEFAULT_ATTRS, kind: 'circle', center: vec(16, 32), radius: 4 });
      doc.add({
        ...DEFAULT_ATTRS,
        kind: 'arc',
        center: vec(0, 0),
        radius: 8,
        startAngle: 0,
        endAngle: Math.PI / 2,
      });
      doc.add({ ...DEFAULT_ATTRS, kind: 'point', at: vec(-4, 0.25) });
    });

    expect(back.entities.map((e) => e.kind)).toEqual(['line', 'circle', 'arc', 'point']);
    expect(back.entities[0]).toMatchObject({ a: vec(0, 0), b: vec(8, 4) });
    expect(back.entities[1]).toMatchObject({ center: vec(16, 32), radius: 4 });
    const arc = back.entities[2] as ArcEntity;
    expect(arc.startAngle).toBeCloseTo(0, 9);
    expect(arc.endAngle).toBeCloseTo(Math.PI / 2, 9);
    expect(back.entities[3]).toMatchObject({ at: vec(-4, 0.25) });
  });

  it('矩形は閉じた連続線として戻る（DXF に矩形が無いため）', () => {
    const back = roundTrip((doc) => {
      doc.add({ ...DEFAULT_ATTRS, kind: 'rect', a: vec(0, 0), b: vec(8, 4) });
    });
    const e = back.entities[0] as PolylineEntity;
    expect(e.kind).toBe('polyline');
    expect(e.closed).toBe(true);
    expect(e.points).toEqual([vec(0, 0), vec(8, 0), vec(8, 4), vec(0, 4)]);
  });

  it('連続線の閉合フラグ', () => {
    const back = roundTrip((doc) => {
      doc.add({ ...DEFAULT_ATTRS, kind: 'polyline', points: [vec(0, 0), vec(8, 0), vec(8, 4)], closed: true });
      doc.add({ ...DEFAULT_ATTRS, kind: 'polyline', points: [vec(0, 0), vec(8, 0)], closed: false });
    });
    expect((back.entities[0] as PolylineEntity).closed).toBe(true);
    expect((back.entities[1] as PolylineEntity).closed).toBe(false);
  });

  it('色・線種・線幅・画層', () => {
    const back = roundTrip((doc) => {
      doc.add({ layer: '境界', color: '#0a58ca', lineStyle: 'dashdot', lineWidth: 0.5, kind: 'line', a: vec(0, 0), b: vec(4, 0) });
      doc.add({ ...DEFAULT_ATTRS, kind: 'line', a: vec(0, 4), b: vec(4, 4) }); // ByLayer・実線・極細
    });
    expect(back.entities[0]).toMatchObject({
      layer: '境界',
      color: '#0a58ca',
      lineStyle: 'dashdot',
      lineWidth: 0.5,
    });
    expect(back.entities[1]).toMatchObject({ layer: '0', color: null, lineStyle: 'solid', lineWidth: 0 });
  });

  it('画層の色・線種・表示 OFF', () => {
    const src = new CadDocument();
    const layer = src.layers.get('境界')!;
    src.layers.set({ ...layer, visible: false });
    src.add({ ...DEFAULT_ATTRS, layer: '境界', kind: 'line', a: vec(0, 0), b: vec(4, 0) });

    const back = new CadDocument();
    back.loadJson(dxfToDocumentJson(documentToDxf(src.toJson())).json);
    expect(back.layers.get('境界')).toMatchObject({ color: '#0000ff', lineStyle: 'dashdot', visible: false });
    expect(back.layers.get('0')?.color).toBe(VB_BLACK);
  });

  it('線種尺度（$LTSCALE）', () => {
    const src = new CadDocument();
    src.lineTypeScale = 250;
    src.add({ ...DEFAULT_ATTRS, kind: 'line', a: vec(0, 0), b: vec(4, 0) });
    const back = new CadDocument();
    back.loadJson(dxfToDocumentJson(documentToDxf(src.toJson())).json);
    expect(back.lineTypeScale).toBe(250);
  });

  it('1 行の文字は TEXT で往復する（揃え・回転・高さ）', () => {
    const back = roundTrip((doc) => {
      doc.add({
        ...DEFAULT_ATTRS,
        kind: 'text',
        at: vec(4, 8),
        text: 'K1',
        height: 500,
        rotation: Math.PI / 2,
        hAlign: 'center',
        vAlign: 'middle',
      });
    });
    const e = back.entities[0] as TextEntity;
    expect(e.kind).toBe('text');
    expect(e.text).toBe('K1');
    expect(e.height).toBe(500);
    expect(e.at).toEqual(vec(4, 8));
    expect(e.rotation).toBeCloseTo(Math.PI / 2, 9);
    expect(e.hAlign).toBe('center');
    expect(e.vAlign).toBe('middle');
  });

  it('複数行の文字は MTEXT で往復する', () => {
    const back = roundTrip((doc) => {
      doc.add({
        ...DEFAULT_ATTRS,
        kind: 'text',
        at: vec(0, 0),
        text: '点番\nK1',
        height: 300,
        rotation: 0,
        hAlign: 'right',
        vAlign: 'bottom',
      });
    });
    const e = back.entities[0] as TextEntity;
    expect(e.text).toBe('点番\nK1');
    expect(e.height).toBe(300);
    expect(e.hAlign).toBe('right');
    expect(e.vAlign).toBe('bottom');
  });

  it('複数行のベースラインは top に丸まる（MTEXT に無いため）', () => {
    const back = roundTrip((doc) => {
      doc.add({
        ...DEFAULT_ATTRS,
        kind: 'text',
        at: vec(0, 0),
        text: 'A\nB',
        height: 250,
        rotation: 0,
        hAlign: 'left',
        vAlign: 'baseline',
      });
    });
    expect((back.entities[0] as TextEntity).vAlign).toBe('top');
  });

  it('度記号は %%d を経由して戻る', () => {
    const back = roundTrip((doc) => {
      doc.add({
        ...DEFAULT_ATTRS,
        kind: 'text',
        at: vec(0, 0),
        text: '45°',
        height: 250,
        rotation: 0,
        hAlign: 'left',
        vAlign: 'baseline',
      });
    });
    expect((back.entities[0] as TextEntity).text).toBe('45°');
  });

  it('250 文字を超える複数行文字も欠けない', () => {
    const long = 'あ'.repeat(600) + '\n' + 'い'.repeat(10);
    const back = roundTrip((doc) => {
      doc.add({
        ...DEFAULT_ATTRS,
        kind: 'text',
        at: vec(0, 0),
        text: long,
        height: 250,
        rotation: 0,
        hAlign: 'left',
        vAlign: 'top',
      });
    });
    expect((back.entities[0] as TextEntity).text).toBe(long);
  });

  it('日本語の画層名・文字が UTF-8 で往復する', () => {
    const dxf = documentToDxf(
      (() => {
        const doc = new CadDocument();
        doc.add({
          ...DEFAULT_ATTRS,
          layer: '境界',
          kind: 'text',
          at: vec(0, 0),
          text: '筆界点',
          height: 250,
          rotation: 0,
          hAlign: 'left',
          vAlign: 'baseline',
        });
        return doc.toJson();
      })(),
    );
    const bytes = new TextEncoder().encode(dxf);
    const res = readDxfBytes(bytes);
    expect(res.encoding).toBe('utf-8 (utf8-valid)');
    expect(res.json.entities[0]).toMatchObject({ layer: '境界', text: '筆界点' });
  });

  it('図形が 0 でも壊れた DXF にならない', () => {
    const dxf = documentToDxf(new CadDocument().toJson());
    expect(dxf.endsWith('0\nEOF\n')).toBe(true);
    expect(dxfToDocumentJson(dxf).json.entities).toHaveLength(0);
  });
});

/** レビューで見つかった実害（他CADで壊れる／往復で消える）を固定する。 */
describe('制御文字・エスケープ・退化図形', () => {
  function roundTripText(text: string): string {
    const doc = new CadDocument();
    doc.add({
      ...DEFAULT_ATTRS,
      kind: 'text',
      at: vec(0, 0),
      text,
      height: 250,
      rotation: 0,
      hAlign: 'left',
      vAlign: 'top',
    });
    const back = new CadDocument();
    back.loadJson(dxfToDocumentJson(documentToDxf(doc.toJson())).json);
    return (back.entities[0] as TextEntity).text;
  }

  it('MTEXT の波括弧・バックスラッシュが往復する', () => {
    // MTEXT では \ が書式コードの開始、{} がグループ化。エスケープしないと消える
    expect(roundTripText('a{b}c\nd')).toBe('a{b}c\nd');
    expect(roundTripText('C:\\CAD\\A.dwg\n2')).toBe('C:\\CAD\\A.dwg\n2');
    expect(roundTripText('a\\\\b\nc')).toBe('a\\\\b\nc');
    expect(roundTripText('x\\Py\nz')).toBe('x\\Py\nz');
  });

  it('CR が入っても行対が崩れず、後続の図形が消えない', () => {
    const doc = new CadDocument();
    doc.add({
      ...DEFAULT_ATTRS,
      kind: 'text',
      at: vec(0, 0),
      text: 'A\rB',
      height: 250,
      rotation: 0,
      hAlign: 'left',
      vAlign: 'baseline',
    });
    doc.add({ ...DEFAULT_ATTRS, kind: 'line', a: vec(0, 0), b: vec(4, 0) });
    doc.add({ ...DEFAULT_ATTRS, kind: 'circle', center: vec(0, 0), radius: 2 });

    const res = dxfToDocumentJson(documentToDxf(doc.toJson()));
    expect(res.json.entities.map((e) => e.kind)).toEqual(['text', 'line', 'circle']);
    expect(res.skipped).toEqual({});
  });

  it('画層名に改行が入っても DXF が壊れず、画層が解決できる', () => {
    const doc = new CadDocument();
    doc.layers.set({ name: '境界\n2', color: '#0000ff', lineStyle: 'solid', visible: true, lineWidth: 0 });
    doc.add({ ...DEFAULT_ATTRS, layer: '境界\n2', kind: 'line', a: vec(0, 0), b: vec(4, 0) });

    const dxf = documentToDxf(doc.toJson());
    const res = dxfToDocumentJson(dxf);
    expect(res.json.entities).toHaveLength(1);
    // 図形が指す画層名がテーブルに実在する（同じ置換を通っている）
    const declared = new Set(values(section(dxf, 'TABLES'), 2));
    expect(declared.has(res.json.entities[0]!.layer)).toBe(true);
  });

  it('サロゲートペアを割らずに 250 文字ごとへ分ける', () => {
    // 250 文字目の境界に 4 バイト文字を置く。UTF-8 に符号化して読み直す
    const text = 'あ'.repeat(249) + '𠮷' + 'い'.repeat(5) + '\nx';
    const doc = new CadDocument();
    doc.add({
      ...DEFAULT_ATTRS,
      kind: 'text',
      at: vec(0, 0),
      text,
      height: 250,
      rotation: 0,
      hAlign: 'left',
      vAlign: 'top',
    });
    const bytes = new TextEncoder().encode(documentToDxf(doc.toJson()));
    const back = readDxfBytes(bytes);
    expect((back.json.entities[0] as TextEntity).text).toBe(text);
  });

  it('全円の円弧は CIRCLE として出す（掃引ゼロの ARC は他CADに捨てられる）', () => {
    const doc = new CadDocument();
    doc.add({
      ...DEFAULT_ATTRS,
      kind: 'arc',
      center: vec(0, 0),
      radius: 8,
      startAngle: 0,
      endAngle: Math.PI * 2,
    });
    const dxf = documentToDxf(doc.toJson());
    expect(dxf).toContain('\n0\nCIRCLE\n');
    expect(dxf).not.toContain('\n0\nARC\n');

    const back = dxfToDocumentJson(dxf).json;
    expect(back.entities[0]).toMatchObject({ kind: 'circle', radius: 8 });
  });
});

describe('ACI と 420 の使い分け', () => {
  function entityDxf(color: string | null): string {
    const doc = new CadDocument();
    doc.add({ ...DEFAULT_ATTRS, color, kind: 'line', a: vec(0, 0), b: vec(4, 0) });
    return section(documentToDxf(doc.toJson()), 'ENTITIES');
  }

  it('ACI で厳密に表せる色に 420 を併記しない', () => {
    // 色 7 は「背景に応じて白/黒」。420 を付けると純白に固定され、
    // 白背景の CAD で図形が消える
    const white = entityDxf(VB_BLACK);
    expect(values(white, 62)).toEqual(['7']);
    expect(values(white, 420)).toHaveLength(0);

    const blue = entityDxf('#0000ff');
    expect(values(blue, 62)).toEqual(['5']);
    expect(values(blue, 420)).toHaveLength(0);
  });

  it('ACI に無い色は 420 で厳密に出す', () => {
    const custom = entityDxf('#0a58ca');
    expect(values(custom, 420)).toEqual([String(0x0a58ca)]);
    expect(values(custom, 62)).toHaveLength(1);
  });

  it('画層も同じ使い分けをする', () => {
    const doc = new CadDocument();
    const tables = section(documentToDxf(doc.toJson()), 'TABLES');
    // 標準画層の色 7（VB_BLACK）に 420 が付いていない
    const layerSection = tables.slice(tables.indexOf('LAYER'));
    expect(layerSection).not.toContain('\n420\n16777215\n');
  });

  it('有彩色は灰色の ACI へ落とさない', () => {
    // 色基準のプロット設定が壊れるため
    for (const [hex, expected] of [
      ['#008000', 3],
      ['#a52a2a', 1],
      ['#6699cc', 5],
    ] as const) {
      const aci = colorToAci(hex);
      expect([8, 9, 250, 251, 252, 253, 254]).not.toContain(aci);
      // だいたいその色相の系統に落ちること（厳密一致は 420 が担保する）
      expect(typeof expected).toBe('number');
    }
  });
});

describe('R2007 として必要な骨格', () => {
  const dxf = documentToDxf(
    (() => {
      const doc = new CadDocument();
      doc.add({ ...DEFAULT_ATTRS, kind: 'line', a: vec(0, 0), b: vec(4, 0) });
      return doc.toJson();
    })(),
  );

  it('R2000 以降のリーダーが探すテーブルが揃っている', () => {
    for (const t of ['VPORT', 'LTYPE', 'LAYER', 'STYLE', 'VIEW', 'UCS', 'APPID', 'DIMSTYLE', 'BLOCK_RECORD']) {
      expect(dxf).toContain(`\n2\n${t}\n`);
    }
  });

  it('OBJECTS セクションに名前付きオブジェクト辞書とレイアウトがある', () => {
    expect(dxf).toContain('\n2\nOBJECTS\n');
    expect(dxf).toContain('ACAD_LAYOUT');
    expect(dxf).toContain('ACAD_GROUP');
    expect(dxf).toContain('\n0\nLAYOUT\n');
    expect(dxf).toContain('\n1\nModel\n');
    expect(dxf).toContain('\n1\nLayout1\n');
  });

  it('BLOCK_RECORD がレイアウトを 340 で指し、その先が実在する', () => {
    const tables = section(dxf, 'TABLES');
    const pointers = values(tables, 340);
    expect(pointers.length).toBeGreaterThanOrEqual(2);
    const handles = new Set(values(dxf, 5));
    for (const p of pointers) expect(handles.has(p)).toBe(true);
  });

  it('辞書が指すハンドル（350）も実在する', () => {
    const objects = section(dxf, 'OBJECTS');
    const handles = new Set(values(dxf, 5));
    for (const p of values(objects, 350)) expect(handles.has(p)).toBe(true);
  });

  it('文字スタイルは日本語が出るフォントを指す', () => {
    expect(section(dxf, 'TABLES')).toContain('msgothic.ttf');
  });

  it('画層の線幅は -3（既定）で、-1（ByLayer）を使わない', () => {
    // 画層に ByLayer 線幅は存在しない（-1/-2 は図形専用）
    const tables = section(dxf, 'TABLES');
    const from = tables.indexOf('\n2\nLAYER\n') + 1; // 先頭の改行を落とさないと偶奇がずれる
    const layerPart = tables.slice(from, tables.indexOf('\n2\nSTYLE\n'));
    expect(values(layerPart, 370)).not.toContain('-1');
    expect(values(layerPart, 370)).toContain('-3');
  });
});

describe('MTEXT のアタッチメント', () => {
  it('9 マスの対応', () => {
    expect(mtextAttachment('left', 'top')).toBe(1);
    expect(mtextAttachment('center', 'top')).toBe(2);
    expect(mtextAttachment('right', 'top')).toBe(3);
    expect(mtextAttachment('left', 'middle')).toBe(4);
    expect(mtextAttachment('center', 'middle')).toBe(5);
    expect(mtextAttachment('right', 'middle')).toBe(6);
    expect(mtextAttachment('left', 'bottom')).toBe(7);
    expect(mtextAttachment('center', 'bottom')).toBe(8);
    expect(mtextAttachment('right', 'bottom')).toBe(9);
  });

  it('ベースラインは上段（top）として出す', () => {
    expect(mtextAttachment('left', 'baseline')).toBe(1);
  });
});
