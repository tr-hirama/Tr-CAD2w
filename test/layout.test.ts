import { describe, expect, it } from 'vitest';
import { vec } from '../src/core/geometry.js';
import {
  PAPER_LINETYPE_SCALE,
  fitScaleDenominator,
  makeLayout,
  makeViewport,
  modelToPaper,
  paperToModel,
  viewportModelExtent,
  viewportScale,
} from '../src/core/layout.js';
import { CadDocument, DEFAULT_LINETYPE_SCALE } from '../src/core/document.js';
import { DEFAULT_ATTRS } from '../src/core/entity.js';
import { deserialize, serialize } from '../src/core/file.js';

const RECT = { x: 20, y: 20, width: 200, height: 100 };

describe('用紙空間の線種尺度', () => {
  it('モデルと用紙で別の値を持つ', () => {
    // 同じ尺度だと A4 より長い破線になって実線に見えてしまう
    expect(PAPER_LINETYPE_SCALE).toBe(5);
    expect(DEFAULT_LINETYPE_SCALE).toBe(500);
    expect(makeLayout('レイアウト1').lineTypeScale).toBe(PAPER_LINETYPE_SCALE);
  });
});

describe('ビューポートの変換', () => {
  it('縮尺は 1/分母', () => {
    expect(viewportScale(makeViewport(1, RECT, vec(0, 0), 100))).toBe(0.01);
    // 不正な分母は等倍に倒す
    expect(viewportScale(makeViewport(1, RECT, vec(0, 0), 0))).toBe(1);
  });

  it('窓の中心に映るモデル座標が紙の窓の中心に来る', () => {
    const vp = makeViewport(1, RECT, vec(5000, 3000), 100);
    expect(modelToPaper(vp, vec(5000, 3000))).toEqual(vec(120, 70));
  });

  it('モデル 100mm は 1:100 で紙 1mm', () => {
    const vp = makeViewport(1, RECT, vec(0, 0), 100);
    const a = modelToPaper(vp, vec(0, 0));
    const b = modelToPaper(vp, vec(100, 0));
    expect(b.x - a.x).toBeCloseTo(1, 12);
  });

  it('紙 → モデルは モデル → 紙 の逆', () => {
    const vp = { ...makeViewport(1, RECT, vec(1234, -567), 250), rotation: Math.PI / 6 };
    const model = vec(2000, 800);
    const back = paperToModel(vp, modelToPaper(vp, model));
    expect(back.x).toBeCloseTo(model.x, 9);
    expect(back.y).toBeCloseTo(model.y, 9);
  });

  it('回転すると映る向きが変わる', () => {
    const vp = { ...makeViewport(1, RECT, vec(0, 0), 1), rotation: Math.PI / 2 };
    const p = modelToPaper(vp, vec(10, 0));
    // モデルの +X が紙の +Y へ回る
    expect(p.x).toBeCloseTo(120, 9);
    expect(p.y).toBeCloseTo(80, 9);
  });

  it('窓に映るモデル範囲', () => {
    const vp = makeViewport(1, RECT, vec(0, 0), 100);
    // 200×100mm の窓に 1:100 → モデル 20000×10000
    const ext = viewportModelExtent(vp);
    expect(ext.maxX - ext.minX).toBeCloseTo(20000, 6);
    expect(ext.maxY - ext.minY).toBeCloseTo(10000, 6);
    expect((ext.minX + ext.maxX) / 2).toBeCloseTo(0, 6);
  });

  it('窓に収める縮尺の分母を求める', () => {
    // 200×100 の窓に 20000×5000 を収める → 幅で決まって 1:100
    expect(fitScaleDenominator(RECT, 20000, 5000)).toBe(100);
    // 高さで決まる場合
    expect(fitScaleDenominator(RECT, 1000, 5000)).toBe(50);
    expect(fitScaleDenominator(RECT, 0, 0)).toBe(1);
  });
});

describe('レイアウトの保存と読込', () => {
  function docWithLayout(): CadDocument {
    const doc = new CadDocument();
    doc.add({ ...DEFAULT_ATTRS, kind: 'line', a: vec(0, 0), b: vec(1000, 500) });
    const layout = makeLayout('レイアウト1', 'A3', 'landscape');
    layout.viewports.push(makeViewport(1, RECT, vec(500, 250), 100));
    layout.entities.push({
      ...DEFAULT_ATTRS,
      id: 1000,
      kind: 'rect',
      a: vec(5, 5),
      b: vec(415, 292),
    });
    doc.layouts.push(layout);
    return doc;
  }

  it('JSON 往復でレイアウト・ビューポート・用紙が保たれる', () => {
    const back = new CadDocument();
    back.loadJson(deserialize(serialize(docWithLayout().toJson())));

    expect(back.layouts).toHaveLength(1);
    const l = back.layouts[0]!;
    expect(l).toMatchObject({ name: 'レイアウト1', paper: 'A3', orientation: 'landscape', lineTypeScale: 5 });
    expect(l.viewports[0]).toMatchObject({ scaleDenominator: 100, center: vec(500, 250) });
    expect(l.entities[0]).toMatchObject({ kind: 'rect' });
  });

  it('レイアウトが無い図面には layouts を出さない（古い読み手を驚かせない）', () => {
    const doc = new CadDocument();
    doc.add({ ...DEFAULT_ATTRS, kind: 'point', at: vec(0, 0) });
    expect('layouts' in doc.toJson()).toBe(false);
  });

  it('layouts が無い古いファイルも読める', () => {
    const json = new CadDocument().toJson();
    const back = new CadDocument();
    back.loadJson(json);
    expect(back.layouts).toEqual([]);
  });

  it('採番は用紙空間の図形とも重ならない', () => {
    const back = new CadDocument();
    back.loadJson(docWithLayout().toJson());
    // 用紙空間に id 1000 があるので次は 1001 から
    expect(back.add({ ...DEFAULT_ATTRS, kind: 'point', at: vec(0, 0) }).id).toBe(1001);
  });

  it('新規図面にするとレイアウトも消える', () => {
    const doc = docWithLayout();
    doc.clear();
    expect(doc.layouts).toEqual([]);
  });

  it('往復でビューポートの参照を共有しない', () => {
    const doc = docWithLayout();
    const json = doc.toJson();
    json.layouts![0]!.viewports[0]!.center = vec(9999, 9999);
    expect(doc.layouts[0]!.viewports[0]!.center).toEqual(vec(500, 250));
  });
});
