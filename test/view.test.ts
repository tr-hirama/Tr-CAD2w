import { describe, expect, it } from 'vitest';
import { CadView } from '../src/core/view.js';
import { vec } from '../src/core/geometry.js';

function view(): CadView {
  const v = new CadView();
  v.resize(800, 600);
  v.center = vec(0, 0);
  v.scale = 2;
  return v;
}

describe('CadView', () => {
  it('ワールドは Y 上向き・画面は Y 下向き', () => {
    const v = view();
    expect(v.toScreen(vec(0, 0))).toEqual(vec(400, 300));
    // ワールドで上（+Y）は画面で上（Y が小さい）
    expect(v.toScreen(vec(0, 100))).toEqual(vec(400, 100));
  });

  it('toWorld は toScreen の逆変換', () => {
    const v = view();
    const w = vec(123.5, -64.25);
    const back = v.toWorld(v.toScreen(w));
    expect(back.x).toBeCloseTo(w.x, 9);
    expect(back.y).toBeCloseTo(w.y, 9);
  });

  it('カーソル固定ズームはカーソル下のワールド座標を動かさない', () => {
    const v = view();
    const cursor = vec(600, 200);
    const before = v.toWorld(cursor);
    v.zoomAt(cursor, 4);
    const after = v.toWorld(cursor);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    expect(v.scale).toBe(8);
  });

  it('全体表示は範囲を中央に収める', () => {
    const v = view();
    v.zoomToFit({ minX: 0, minY: 0, maxX: 400, maxY: 200 }, 0);
    expect(v.center).toEqual(vec(200, 100));
    // 幅 400 が 800px、高さ 200 が 600px。厳しい方（幅）に合わせて 2 倍
    expect(v.scale).toBe(2);
  });

  it('空の範囲では何も変えない', () => {
    const v = view();
    v.zoomToFit({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
    expect(v.scale).toBe(2);
    expect(v.center).toEqual(vec(0, 0));
  });

  it('パンは画面ドラッグと同じ向きに図面が動く', () => {
    const v = view();
    v.panByScreen(100, 0); // 右へドラッグ → 図面は右へ動く = 中心は左へ
    expect(v.center.x).toBe(-50);
  });
});
