import { describe, expect, it } from 'vitest';
import { CadDocument } from '../src/core/document.js';
import { deserialize, serialize } from '../src/core/file.js';
import { DEFAULT_ATTRS } from '../src/core/entity.js';
import { vec } from '../src/core/geometry.js';

function docWithLines(n: number): CadDocument {
  const doc = new CadDocument();
  for (let i = 0; i < n; i++) {
    doc.add({ ...DEFAULT_ATTRS, kind: 'line', a: vec(i * 16, 0), b: vec(i * 16 + 8, 0) });
  }
  return doc;
}

describe('CadDocument', () => {
  it('id は 1 から採番される', () => {
    const doc = docWithLines(3);
    expect(doc.entities.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it('Undo は beginEdit の直前へ戻す', () => {
    const doc = docWithLines(2);
    doc.beginEdit();
    doc.remove([1, 2]);
    expect(doc.count).toBe(0);
    expect(doc.undo()).toBe(true);
    expect(doc.count).toBe(2);
    expect(doc.redo()).toBe(true);
    expect(doc.count).toBe(0);
  });

  it('Undo の履歴が無ければ false', () => {
    const doc = new CadDocument();
    expect(doc.undo()).toBe(false);
    expect(doc.canUndo).toBe(false);
  });

  it('新しい編集で redo 履歴は捨てられる', () => {
    const doc = docWithLines(1);
    doc.beginEdit();
    doc.remove([1]);
    doc.undo();
    expect(doc.canRedo).toBe(true);
    doc.beginEdit();
    expect(doc.canRedo).toBe(false);
  });

  it('pick は最前面（配列の後ろ）を返す', () => {
    const doc = new CadDocument();
    doc.add({ ...DEFAULT_ATTRS, kind: 'line', a: vec(0, 0), b: vec(8, 0) });
    const front = doc.add({ ...DEFAULT_ATTRS, kind: 'line', a: vec(0, 0), b: vec(8, 0) });
    expect(doc.pick(vec(4, 0), 0.5)?.id).toBe(front.id);
  });

  it('表示 OFF の画層は拾わない', () => {
    const doc = new CadDocument();
    doc.add({ ...DEFAULT_ATTRS, layer: '境界', kind: 'line', a: vec(0, 0), b: vec(8, 0) });
    expect(doc.pick(vec(4, 0), 0.5)).toBeDefined();
    const layer = doc.layers.get('境界')!;
    doc.layers.set({ ...layer, visible: false });
    expect(doc.pick(vec(4, 0), 0.5)).toBeUndefined();
  });

  it('窓選択は内側だけ・交差選択は触れていれば選ぶ', () => {
    const doc = docWithLines(3); // 0-8, 16-24, 32-40
    const box = { minX: -1, minY: -1, maxX: 20, maxY: 1 };
    expect(doc.pickBox(box, false).map((e) => e.id)).toEqual([1]);
    expect(doc.pickBox(box, true).map((e) => e.id)).toEqual([1, 2]);
  });

  it('最前面へ／最背面へで描画順が変わる', () => {
    const doc = docWithLines(3);
    doc.bringToFront([1]);
    expect(doc.entities.map((e) => e.id)).toEqual([2, 3, 1]);
    doc.sendToBack([1]);
    expect(doc.entities.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it('bounds は全図形を囲う', () => {
    const doc = docWithLines(2);
    expect(doc.bounds()).toEqual({ minX: 0, minY: 0, maxX: 24, maxY: 0 });
  });

  it('選択図形へ属性を一括適用できる', () => {
    const doc = docWithLines(2);
    doc.selection.add(1);
    expect(doc.applyAttributes({ color: '#ff0000', layer: '境界' })).toBe(1);
    expect(doc.get(1)).toMatchObject({ color: '#ff0000', layer: '境界' });
    expect(doc.get(2)).toMatchObject({ color: null, layer: '0' });
  });

  it('削除した図形は選択からも外れる', () => {
    const doc = docWithLines(2);
    doc.selection.add(1);
    doc.remove([1]);
    expect(doc.selection.has(1)).toBe(false);
  });
});

describe('保存と読込', () => {
  it('JSON 往復で図形・画層・線種尺度が保たれる', () => {
    const doc = docWithLines(2);
    doc.lineTypeScale = 250;
    doc.add({
      ...DEFAULT_ATTRS,
      layer: '境界',
      color: '#0000ff',
      kind: 'text',
      at: vec(1, 2),
      text: '点番\nK1',
      height: 500,
      rotation: 0,
      hAlign: 'left',
      vAlign: 'baseline',
    });

    const round = new CadDocument();
    round.loadJson(deserialize(serialize(doc.toJson())));

    expect(round.count).toBe(3);
    expect(round.lineTypeScale).toBe(250);
    expect(round.get(3)).toMatchObject({ kind: 'text', text: '点番\nK1', layer: '境界' });
    expect(round.layers.get('境界')?.lineStyle).toBe('dashdot');
  });

  it('読込後の採番は既存 id の後ろから続く', () => {
    const doc = docWithLines(3);
    const round = new CadDocument();
    round.loadJson(doc.toJson());
    expect(round.add({ ...DEFAULT_ATTRS, kind: 'point', at: vec(0, 0) }).id).toBe(4);
  });

  it('形式違いは読み込まない', () => {
    expect(() => deserialize('{"format":"other","version":1,"entities":[]}')).toThrow();
    expect(() => deserialize('not json')).toThrow();
  });

  it('未知の画層は読込時に作られる', () => {
    const doc = new CadDocument();
    const json = doc.toJson();
    json.entities.push({
      ...DEFAULT_ATTRS,
      id: 1,
      layer: '新しい画層',
      kind: 'point',
      at: vec(0, 0),
    });
    const round = new CadDocument();
    round.loadJson(json);
    expect(round.layers.get('新しい画層')).toBeDefined();
  });
});
