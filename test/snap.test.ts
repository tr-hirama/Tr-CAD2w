import { describe, expect, it } from 'vitest';
import { CadDocument } from '../src/core/document.js';
import { DEFAULT_ATTRS } from '../src/core/entity.js';
import { vec } from '../src/core/geometry.js';
import { DEFAULT_SNAP, applyGrid, findSnap, segmentIntersection } from '../src/core/snap.js';

function crossDoc(): CadDocument {
  const doc = new CadDocument();
  doc.add({ ...DEFAULT_ATTRS, kind: 'line', a: vec(-8, 0), b: vec(8, 0) });
  doc.add({ ...DEFAULT_ATTRS, kind: 'line', a: vec(0, -8), b: vec(0, 8) });
  return doc;
}

describe('findSnap', () => {
  it('端点は中点より優先される', () => {
    const doc = new CadDocument();
    doc.add({ ...DEFAULT_ATTRS, kind: 'line', a: vec(0, 0), b: vec(8, 0) });
    // 端点(0,0)と中点(4,0)のどちらも許容内に入る位置から引く
    const r = findSnap(doc, vec(1.5, 0), 4, DEFAULT_SNAP);
    expect(r?.kind).toBe('end');
    expect(r?.at).toEqual(vec(0, 0));
  });

  it('交点を拾う', () => {
    const r = findSnap(crossDoc(), vec(0.5, 0.5), 2, DEFAULT_SNAP);
    expect(r?.at.x).toBeCloseTo(0, 9);
    expect(r?.at.y).toBeCloseTo(0, 9);
  });

  it('許容外なら吸着しない', () => {
    const doc = crossDoc();
    expect(findSnap(doc, vec(100, 100), 1, DEFAULT_SNAP)).toBeUndefined();
  });

  it('オブジェクト吸着 OFF では拾わない', () => {
    const doc = crossDoc();
    expect(findSnap(doc, vec(0.1, 0.1), 2, { ...DEFAULT_SNAP, objectSnap: false })).toBeUndefined();
  });

  it('図形が無ければグリッド吸着が効く', () => {
    const doc = new CadDocument();
    const r = findSnap(doc, vec(9, 1), 4, { ...DEFAULT_SNAP, gridSnap: true, gridSize: 8 });
    expect(r).toEqual({ at: vec(8, 0), kind: 'grid' });
  });
});

describe('applyGrid', () => {
  it('OFF なら素通し', () => {
    expect(applyGrid(vec(3, 3), DEFAULT_SNAP)).toEqual(vec(3, 3));
  });

  it('ON なら最近傍の格子へ丸める', () => {
    expect(applyGrid(vec(3, -3), { ...DEFAULT_SNAP, gridSnap: true, gridSize: 4 })).toEqual(vec(4, -4));
  });
});

describe('segmentIntersection', () => {
  it('交差する線分', () => {
    expect(segmentIntersection(vec(-4, 0), vec(4, 0), vec(0, -4), vec(0, 4))).toEqual(vec(0, 0));
  });

  it('平行な線分は交点なし', () => {
    expect(segmentIntersection(vec(0, 0), vec(4, 0), vec(0, 2), vec(4, 2))).toBeUndefined();
  });

  it('延長線上で交わるだけなら交点なし', () => {
    expect(segmentIntersection(vec(0, 0), vec(4, 0), vec(8, -4), vec(8, 4))).toBeUndefined();
  });
});
