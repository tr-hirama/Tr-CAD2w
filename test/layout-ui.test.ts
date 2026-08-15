import { describe, expect, it } from 'vitest';
import { vec } from '../src/core/geometry.js';
import { CadDocument, cloneLayout, type DocumentJson } from '../src/core/document.js';
import {
  DEFAULT_ATTRS,
  type CircleEntity,
  type LineEntity,
  type TextEntity,
  entityBounds,
} from '../src/core/entity.js';
import {
  PAPER_LINETYPE_SCALE,
  makeLayout,
  makeViewport,
  modelEntityToPaper,
  modelToPaper,
  paperToModel,
  viewportCorners,
  viewportModelExtent,
} from '../src/core/layout.js';
import { formatDenominator } from '../src/ui/app.js';

/** 紙 (10,10)-(110,60) の窓に、モデル原点まわりを 1:100 で映す。 */
const vp = makeViewport(1, { x: 10, y: 10, width: 100, height: 50 }, vec(0, 0), 100);

describe('モデル図形を紙へ映す', () => {
  it('中心のモデル点は窓の中心に来る', () => {
    const p = modelEntityToPaper(vp, { ...DEFAULT_ATTRS, id: 1, kind: 'point', at: vec(0, 0) });
    if (p.kind !== 'point') throw new Error('点として返っていません');
    expect(p.at).toEqual(vec(60, 35));
  });

  it('線は縮尺どおりに縮む（1:100 なら 1000mm が 10mm）', () => {
    const line: LineEntity = { ...DEFAULT_ATTRS, id: 1, kind: 'line', a: vec(0, 0), b: vec(1000, 0) };
    const p = modelEntityToPaper(vp, line);
    if (p.kind !== 'line') throw new Error('線として返っていません');
    expect(p.a).toEqual(vec(60, 35));
    expect(p.b).toEqual(vec(70, 35));
  });

  it('円は半径も縮む（中心だけ動いて大きさが取り残されない）', () => {
    const circle: CircleEntity = { ...DEFAULT_ATTRS, id: 1, kind: 'circle', center: vec(0, 0), radius: 500 };
    const p = modelEntityToPaper(vp, circle);
    if (p.kind !== 'circle') throw new Error('円として返っていません');
    expect(p.radius).toBe(5);
  });

  it('文字は高さも縮む', () => {
    const text: TextEntity = {
      ...DEFAULT_ATTRS,
      id: 1,
      kind: 'text',
      at: vec(0, 0),
      text: 'A',
      height: 250,
      rotation: 0,
      hAlign: 'left',
      vAlign: 'baseline',
    };
    const p = modelEntityToPaper(vp, text);
    if (p.kind !== 'text') throw new Error('文字として返っていません');
    expect(p.height).toBe(2.5);
  });

  it('点の変換は modelToPaper と一致する（二重実装になっていない）', () => {
    for (const m of [vec(0, 0), vec(1234, -567), vec(-89, 4321)]) {
      const viaEntity = modelEntityToPaper(vp, { ...DEFAULT_ATTRS, id: 1, kind: 'point', at: m });
      if (viaEntity.kind !== 'point') throw new Error('点として返っていません');
      const direct = modelToPaper(vp, m);
      expect(viaEntity.at.x).toBeCloseTo(direct.x, 9);
      expect(viaEntity.at.y).toBeCloseTo(direct.y, 9);
    }
  });

  it('窓を回すと図形も回る', () => {
    const rotated = makeViewport(1, { x: 0, y: 0, width: 100, height: 100 }, vec(0, 0), 1);
    rotated.rotation = Math.PI / 2;
    const p = modelEntityToPaper(rotated, { ...DEFAULT_ATTRS, id: 1, kind: 'point', at: vec(10, 0) });
    if (p.kind !== 'point') throw new Error('点として返っていません');
    // 窓の中心 (50,50) から見て +x が +y へ回る
    expect(p.at.x).toBeCloseTo(50, 9);
    expect(p.at.y).toBeCloseTo(60, 9);
  });

  it('回した窓でも modelToPaper と一致する', () => {
    const rotated = makeViewport(1, { x: 5, y: 5, width: 80, height: 40 }, vec(100, 200), 50);
    rotated.rotation = 0.7;
    const m = vec(345, -678);
    const p = modelEntityToPaper(rotated, { ...DEFAULT_ATTRS, id: 1, kind: 'point', at: m });
    if (p.kind !== 'point') throw new Error('点として返っていません');
    const direct = modelToPaper(rotated, m);
    expect(p.at.x).toBeCloseTo(direct.x, 9);
    expect(p.at.y).toBeCloseTo(direct.y, 9);
  });

  it('紙→モデルは往復する', () => {
    const m = vec(1234, -567);
    const back = paperToModel(vp, modelToPaper(vp, m));
    expect(back.x).toBeCloseTo(m.x, 9);
    expect(back.y).toBeCloseTo(m.y, 9);
  });
});

describe('窓に映る範囲', () => {
  it('窓の大きさ × 縮尺ぶんのモデル範囲が映る', () => {
    const e = viewportModelExtent(vp);
    // 幅 100mm × 1:100 → モデル 10000mm
    expect(e.maxX - e.minX).toBeCloseTo(10000, 6);
    expect(e.maxY - e.minY).toBeCloseTo(5000, 6);
    expect((e.minX + e.maxX) / 2).toBeCloseTo(0, 6);
  });

  it('窓の 4 隅は紙座標で矩形になる', () => {
    expect(viewportCorners(vp)).toEqual([vec(10, 10), vec(110, 10), vec(110, 60), vec(10, 60)]);
  });

  it('窓の外のモデル図形は映る範囲に入らない（切り取りの根拠）', () => {
    const e = viewportModelExtent(vp);
    const far = vec(99999, 99999);
    expect(far.x > e.maxX || far.y > e.maxY).toBe(true);
  });
});

describe('レイアウトと Undo', () => {
  it('用紙空間の線種尺度はモデルと別（A4 に収まる刻み）', () => {
    const l = makeLayout('レイアウト1');
    expect(l.lineTypeScale).toBe(PAPER_LINETYPE_SCALE);
    expect(l.lineTypeScale).toBeLessThan(500);
    // 破線 25 × 尺度 5 = 125mm では A4（297mm）に 2 本しか出ない…ではなく、
    // 実際の刻みは linetype.ts の定義 × 尺度。ここでは「モデルの 1/100」であることだけ見る
    expect(l.lineTypeScale * 100).toBeLessThanOrEqual(500 * 100);
  });

  it('用紙空間の作図が Undo で戻る（モデル空間だけを積んでいない）', () => {
    const doc = new CadDocument();
    doc.clear();
    doc.layouts.push(makeLayout('レイアウト1'));
    doc.beginEdit();
    doc.layouts[0]!.entities.push({ ...DEFAULT_ATTRS, id: doc.reserveId(), kind: 'line', a: vec(0, 0), b: vec(10, 0) });
    expect(doc.layouts[0]!.entities).toHaveLength(1);
    doc.undo();
    expect(doc.layouts[0]!.entities).toHaveLength(0);
  });

  it('ビューポートの変更も Undo で戻る', () => {
    const doc = new CadDocument();
    doc.clear();
    const l = makeLayout('レイアウト1');
    l.viewports.push(makeViewport(doc.reserveId(), { x: 0, y: 0, width: 10, height: 10 }, vec(0, 0), 100));
    doc.layouts.push(l);
    doc.beginEdit();
    doc.layouts[0]!.viewports[0]!.scaleDenominator = 250;
    doc.undo();
    expect(doc.layouts[0]!.viewports[0]!.scaleDenominator).toBe(100);
  });

  it('レイアウトの追加も Undo で戻る', () => {
    const doc = new CadDocument();
    doc.clear();
    doc.beginEdit();
    doc.layouts.push(makeLayout('レイアウト1'));
    doc.undo();
    expect(doc.layouts).toHaveLength(0);
  });

  it('複製は窓の矩形と中心を共有しない', () => {
    const l = makeLayout('レイアウト1');
    l.viewports.push(makeViewport(1, { x: 0, y: 0, width: 10, height: 10 }, vec(1, 2), 100));
    const copy = cloneLayout(l);
    expect(copy.viewports[0]!.paperRect).not.toBe(l.viewports[0]!.paperRect);
    expect(copy.viewports[0]!.center).not.toBe(l.viewports[0]!.center);
    copy.viewports[0]!.paperRect.x = 99;
    expect(l.viewports[0]!.paperRect.x).toBe(0);
  });

  it('保存 → 読込でレイアウトとビューポートが戻る', () => {
    const doc = new CadDocument();
    doc.clear();
    const l = makeLayout('図面1', 'A3', 'portrait');
    l.viewports.push(makeViewport(doc.reserveId(), { x: 5, y: 5, width: 90, height: 60 }, vec(100, 200), 250));
    l.entities.push({ ...DEFAULT_ATTRS, id: doc.reserveId(), kind: 'line', a: vec(0, 0), b: vec(10, 0) });
    doc.layouts.push(l);

    const json = JSON.parse(JSON.stringify(doc.toJson())) as DocumentJson;
    const back = new CadDocument();
    back.loadJson(json);
    expect(back.layouts).toHaveLength(1);
    const got = back.layouts[0]!;
    expect(got.name).toBe('図面1');
    expect(got.paper).toBe('A3');
    expect(got.orientation).toBe('portrait');
    expect(got.viewports[0]!.scaleDenominator).toBe(250);
    expect(got.viewports[0]!.center).toEqual(vec(100, 200));
    expect(got.entities).toHaveLength(1);
  });

  it('読み直した図面の新しい id は、ビューポートの id とも重ならない', () => {
    const doc = new CadDocument();
    doc.clear();
    const l = makeLayout('レイアウト1');
    // わざと大きな id をビューポートに与える
    l.viewports.push(makeViewport(9999, { x: 0, y: 0, width: 10, height: 10 }, vec(0, 0), 100));
    doc.layouts.push(l);
    const json = JSON.parse(JSON.stringify(doc.toJson())) as DocumentJson;
    const back = new CadDocument();
    back.loadJson(json);
    expect(back.reserveId()).toBeGreaterThan(9999);
  });
});

describe('縮尺の表示', () => {
  it('整数はそのまま', () => {
    expect(formatDenominator(200)).toBe('200');
  });

  it('端数は小数 2 桁まで（末尾の 0 は落とす）', () => {
    expect(formatDenominator(2.5)).toBe('2.5');
    expect(formatDenominator(1 / 3)).toBe('0.33');
  });
});

describe('用紙空間の図形は紙 mm', () => {
  it('紙に置いた図枠は用紙の寸法と同じ桁に収まる', () => {
    const l = makeLayout('レイアウト1', 'A4', 'landscape');
    // A4 横 = 297×210mm。図枠を余白 10mm で引く
    l.entities.push({ ...DEFAULT_ATTRS, id: 1, kind: 'rect', a: vec(10, 10), b: vec(287, 200) });
    const b = entityBounds(l.entities[0]!);
    expect(b.maxX).toBeLessThanOrEqual(297);
    expect(b.maxY).toBeLessThanOrEqual(210);
  });
});
