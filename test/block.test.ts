import { describe, expect, it } from 'vitest';
import { vec } from '../src/core/geometry.js';
import { CadDocument, FILE_FORMAT_VERSION, type DocumentJson } from '../src/core/document.js';
import {
  DEFAULT_ATTRS,
  type CircleEntity,
  type Entity,
  type InsertEntity,
  type LineEntity,
  type TextEntity,
  scaleEntity,
  translateEntity,
} from '../src/core/entity.js';
import { MAX_BLOCK_DEPTH, explodeInsert, makeBlock, type BlockDef, type BlockSource } from '../src/core/block.js';
import { STANDARD_LAYERS } from '../src/core/layer.js';
import { documentToDxf } from '../src/io/dxf-write.js';

const line: LineEntity = { ...DEFAULT_ATTRS, id: 1, kind: 'line', a: vec(0, 0), b: vec(2, 0) };
const circle: CircleEntity = { ...DEFAULT_ATTRS, id: 2, kind: 'circle', center: vec(1, 1), radius: 1 };

function source(...blocks: BlockDef[]): BlockSource {
  return { getBlock: (name) => blocks.find((b) => b.name === name) };
}

function insert(over: Partial<InsertEntity> = {}): InsertEntity {
  return {
    ...DEFAULT_ATTRS,
    id: 10,
    kind: 'insert',
    blockName: 'A',
    at: vec(0, 0),
    scale: 1,
    scaleY: 0,
    rotation: 0,
    ...over,
  };
}

describe('ブロックの展開', () => {
  it('挿入点ぶん平行移動する', () => {
    const out = explodeInsert(source(makeBlock('A', [line])), insert({ at: vec(10, 5) }));
    expect(out).toHaveLength(1);
    const e = out[0] as LineEntity;
    expect(e.a).toEqual(vec(10, 5));
    expect(e.b).toEqual(vec(12, 5));
  });

  it('展開した図形には「展開由来」の印が付く（測点の取得から外すため）', () => {
    const out = explodeInsert(source(makeBlock('A', [line, circle])), insert());
    expect(out.every((e) => e.fromBlock === true)).toBe(true);
  });

  it('倍率は円の半径にも効く（中心だけ動いて大きさが取り残されない）', () => {
    const out = explodeInsert(source(makeBlock('A', [circle])), insert({ scale: 3 }));
    const c = out[0] as CircleEntity;
    expect(c.radius).toBe(3);
    expect(c.center).toEqual(vec(3, 3));
  });

  it('回転は文字の向きにも効く', () => {
    const text: TextEntity = {
      ...DEFAULT_ATTRS,
      id: 3,
      kind: 'text',
      at: vec(1, 0),
      text: 'A',
      height: 2,
      rotation: 0,
      hAlign: 'left',
      vAlign: 'baseline',
    };
    const out = explodeInsert(source(makeBlock('A', [text])), insert({ rotation: Math.PI / 2 }));
    const t = out[0] as TextEntity;
    expect(t.rotation).toBeCloseTo(Math.PI / 2, 12);
    expect(t.at.x).toBeCloseTo(0, 12);
    expect(t.at.y).toBeCloseTo(1, 12);
  });

  it('倍率は文字高にも効く', () => {
    const text: TextEntity = {
      ...DEFAULT_ATTRS,
      id: 3,
      kind: 'text',
      at: vec(0, 0),
      text: 'A',
      height: 2,
      rotation: 0,
      hAlign: 'left',
      vAlign: 'baseline',
    };
    const out = explodeInsert(source(makeBlock('A', [text])), insert({ scale: 2.5 }));
    expect((out[0] as TextEntity).height).toBe(5);
  });

  it('Y 倍率 0 は X と同じ（等倍）', () => {
    const out = explodeInsert(source(makeBlock('A', [line])), insert({ scale: 2, scaleY: 0 }));
    expect((out[0] as LineEntity).b).toEqual(vec(4, 0));
  });

  it('Y 倍率を別に与えると非等倍になる', () => {
    const vertical: LineEntity = { ...DEFAULT_ATTRS, id: 1, kind: 'line', a: vec(0, 0), b: vec(0, 2) };
    const out = explodeInsert(source(makeBlock('A', [vertical])), insert({ scale: 1, scaleY: 3 }));
    expect((out[0] as LineEntity).b).toEqual(vec(0, 6));
  });

  it('回した矩形は閉じた連続線になる（矩形のままだと形が変わる）', () => {
    const rect: Entity = { ...DEFAULT_ATTRS, id: 4, kind: 'rect', a: vec(0, 0), b: vec(2, 1) };
    const out = explodeInsert(source(makeBlock('A', [rect])), insert({ rotation: Math.PI / 4 }));
    expect(out[0]!.kind).toBe('polyline');
  });

  it('回していない矩形は矩形のまま', () => {
    const rect: Entity = { ...DEFAULT_ATTRS, id: 4, kind: 'rect', a: vec(0, 0), b: vec(2, 1) };
    const out = explodeInsert(source(makeBlock('A', [rect])), insert({ at: vec(5, 5) }));
    expect(out[0]!.kind).toBe('rect');
  });

  it('定義が無い挿入は何も出さない（例外にしない）', () => {
    expect(explodeInsert(source(), insert())).toEqual([]);
  });

  it('入れ子のブロックも展開する', () => {
    const inner = makeBlock('inner', [line]);
    const outer = makeBlock('outer', [insert({ blockName: 'inner', at: vec(1, 0) })]);
    const out = explodeInsert(source(inner, outer), insert({ blockName: 'outer', at: vec(10, 0) }));
    expect(out).toHaveLength(1);
    expect((out[0] as LineEntity).a).toEqual(vec(11, 0));
  });

  it('入れ子でも外側の倍率が中まで効く', () => {
    const inner = makeBlock('inner', [line]);
    const outer = makeBlock('outer', [insert({ blockName: 'inner', at: vec(1, 0) })]);
    const out = explodeInsert(source(inner, outer), insert({ blockName: 'outer', scale: 2 }));
    const e = out[0] as LineEntity;
    expect(e.a).toEqual(vec(2, 0));
    expect(e.b).toEqual(vec(6, 0));
  });

  it('自分を含むブロック（循環参照）でも止まる', () => {
    const self = makeBlock('self', [insert({ blockName: 'self' }), line]);
    const out = explodeInsert(source(self), insert({ blockName: 'self' }));
    // 中の line は出るが、自分の再展開は打ち切られる
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('line');
  });

  it('2 つのブロックが互いを含んでいても止まる', () => {
    const a = makeBlock('A', [insert({ blockName: 'B' }), line]);
    const b = makeBlock('B', [insert({ blockName: 'A' }), circle]);
    const out = explodeInsert(source(a, b), insert({ blockName: 'A' }));
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(100); // 無限に増えない
  });

  it('深い入れ子は上限で打ち切る', () => {
    const blocks: BlockDef[] = [];
    for (let i = 0; i < MAX_BLOCK_DEPTH + 5; i++) {
      blocks.push(makeBlock(`b${i}`, [insert({ blockName: `b${i + 1}` })]));
    }
    blocks.push(makeBlock(`b${MAX_BLOCK_DEPTH + 5}`, [line]));
    const out = explodeInsert(source(...blocks), insert({ blockName: 'b0' }));
    expect(out).toEqual([]); // 底まで届かないので何も出ない（落ちない）
  });

  it('ブロック定義は中身を複製して持つ（元の図面を変えても影響しない）', () => {
    const src = [line];
    const blk = makeBlock('A', src);
    expect(blk.entities[0]).not.toBe(src[0]);
  });
});

describe('図面に置いたブロック', () => {
  const docWithBlock = (): CadDocument => {
    const doc = new CadDocument();
    doc.clear();
    doc.setBlock(makeBlock('A', [line, circle]));
    return doc;
  };

  it('外接矩形は中身の広がりで決まる（挿入点だけにならない）', () => {
    const doc = docWithBlock();
    doc.add({ ...insert({ at: vec(10, 10) }) });
    const b = doc.bounds();
    expect(b.minX).toBeCloseTo(10, 9);
    expect(b.maxX).toBeCloseTo(12, 9);
    expect(b.maxY).toBeCloseTo(12, 9);
  });

  it('中身のどこを押しても挿入そのものが掴める', () => {
    const doc = docWithBlock();
    const ins = doc.add({ ...insert({ at: vec(10, 10) }) });
    const hit = doc.pick(vec(11, 10), 0.1);
    expect(hit?.id).toBe(ins.id);
    expect(hit?.kind).toBe('insert');
  });

  it('展開結果はブロック定義を差し替えると作り直される', () => {
    const doc = docWithBlock();
    const ins = doc.add({ ...insert() });
    expect(doc.explode(ins)).toHaveLength(2);
    doc.setBlock(makeBlock('A', [line]));
    expect(doc.explode(ins)).toHaveLength(1);
  });

  it('保存して読み直してもブロックが残る', () => {
    const doc = docWithBlock();
    doc.add({ ...insert({ at: vec(3, 4) }) });
    const json = JSON.parse(JSON.stringify(doc.toJson())) as DocumentJson;
    const back = new CadDocument();
    back.loadJson(json);
    expect(back.blocks).toHaveLength(1);
    expect(back.getBlock('A')?.entities).toHaveLength(2);
    expect(back.flatEntities()).toHaveLength(2);
  });

  it('ブロックが無い図面は blocks を書かない（古い読み手を驚かせない）', () => {
    const doc = new CadDocument();
    doc.clear();
    doc.add({ ...line });
    expect(doc.toJson().blocks).toBeUndefined();
  });

  it('DXF へは展開した実体が出る（INSERT を作らない）', () => {
    const json: DocumentJson = {
      format: 'tr-cad2w',
      version: FILE_FORMAT_VERSION,
      lineTypeScale: 500,
      layers: [...STANDARD_LAYERS],
      entities: [insert({ at: vec(10, 0) })],
      blocks: [makeBlock('A', [line])],
    };
    const dxf = documentToDxf(json);
    expect(dxf).not.toContain('\nINSERT\n');
    expect(dxf).toContain('\nLINE\n');
    // 展開後の座標が出る
    expect(dxf).toContain('12.0');
  });

  it('定義が無い挿入は DXF に何も出さない', () => {
    const json: DocumentJson = {
      format: 'tr-cad2w',
      version: FILE_FORMAT_VERSION,
      lineTypeScale: 500,
      layers: [...STANDARD_LAYERS],
      entities: [insert()],
    };
    expect(documentToDxf(json)).not.toContain('\nLINE\n');
  });
});

describe('挿入そのものの変形', () => {
  it('平行移動は挿入点を動かす', () => {
    const m = translateEntity(insert({ at: vec(1, 1) }), vec(2, 3)) as InsertEntity;
    expect(m.at).toEqual(vec(3, 4));
  });

  it('拡縮は倍率も変える。Y 倍率 0（＝X と同じ）は 0 のまま保つ', () => {
    const s = scaleEntity(insert({ scale: 2, scaleY: 0 }), vec(0, 0), 3) as InsertEntity;
    expect(s.scale).toBe(6);
    expect(s.scaleY).toBe(0);
  });
});
