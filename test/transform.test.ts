import { describe, expect, it } from 'vitest';
import {
  affineApply,
  affineDet,
  controlPoints,
  emptyTransformRow,
  helmertApply,
  helmertRotationDeg,
  helmertScale,
  helmertToAffine,
  normalizeTransformRows,
  residuals,
  solveAffine,
  solveHelmert,
  type ControlPoint,
} from '../src/survey/transform.js';
import { CadDocument } from '../src/core/document.js';
import { documentToTc2Json, tc2JsonToDocument } from '../src/io/tc2.js';

function pt(sx: number, sy: number, tx: number, ty: number): ControlPoint {
  return { sx, sy, tx, ty };
}

describe('solveHelmert', () => {
  /**
   * **既知のパラメータを共通点から復元できるか**が唯一の確かめ方。
   * 倍率 2・回転 90°・平行移動 (10, 20) を掛けた点を与え、同じ値が戻るかを見る。
   * 回転 90° なら cos/sin が 0/1 に落ちるので、浮動小数の誤差が入らない。
   */
  it('倍率・回転・平行移動を復元する', () => {
    // A = s·cosθ = 0、B = s·sinθ = 2（s=2, θ=90°）
    // X' = 0·x − 2·y + 10、Y' = 2·x + 0·y + 20
    const src = [pt(0, 0, 10, 20), pt(1, 0, 10, 22), pt(0, 1, 8, 20)];
    const h = solveHelmert(src)!;
    expect(h.a).toBeCloseTo(0, 12);
    expect(h.b).toBeCloseTo(2, 12);
    expect(h.c).toBeCloseTo(10, 12);
    expect(h.d).toBeCloseTo(20, 12);
    expect(helmertScale(h)).toBeCloseTo(2, 12);
    expect(helmertRotationDeg(h)).toBeCloseTo(90, 12);
  });

  it('恒等変換は A=1・B=0・平行移動 0', () => {
    const h = solveHelmert([pt(0, 0, 0, 0), pt(4, 0, 4, 0), pt(0, 8, 0, 8)])!;
    expect(h.a).toBeCloseTo(1, 12);
    expect(h.b).toBeCloseTo(0, 12);
    expect(helmertScale(h)).toBeCloseTo(1, 12);
    expect(helmertRotationDeg(h)).toBeCloseTo(0, 12);
  });

  it('平行移動だけも解ける', () => {
    const h = solveHelmert([pt(0, 0, 4, 8), pt(1, 0, 5, 8)])!;
    expect(h.c).toBeCloseTo(4, 12);
    expect(h.d).toBeCloseTo(8, 12);
    expect(helmertScale(h)).toBeCloseTo(1, 12);
  });

  /**
   * A=3, B=4（倍率 5）、C=10, D=20 から点を作る。**すべて整数で厳密**なので
   * 残差はゼロになるはず。ここがゼロでなければ式が間違っている。
   */
  it('求めたパラメータで当てると残差がほぼ 0', () => {
    const src = [pt(0, 0, 10, 20), pt(1, 0, 13, 24), pt(0, 1, 6, 23), pt(2, 3, 4, 37)];
    const h = solveHelmert(src)!;
    expect(h.a).toBeCloseTo(3, 10);
    expect(h.b).toBeCloseTo(4, 10);
    expect(helmertScale(h)).toBeCloseTo(5, 10);
    const res = residuals(src, (x, y) => helmertApply(h, x, y));
    expect(res.max).toBeLessThan(1e-9);
    expect(res.rms).toBeLessThan(1e-9);
  });

  it('1 点では解けない（2 点以上要る）', () => {
    expect(solveHelmert([pt(0, 0, 1, 1)])).toBeNull();
    expect(solveHelmert([])).toBeNull();
  });

  /** 変換前の点が 1 か所に固まっていると、回転も倍率も決まらない。 */
  it('変換前の点がすべて同じ位置なら解けない', () => {
    expect(solveHelmert([pt(5, 5, 0, 0), pt(5, 5, 10, 10)])).toBeNull();
  });

  it('4 点目にズレを混ぜると残差に出る（最小二乗なので解は返る）', () => {
    const src = [pt(0, 0, 0, 0), pt(10, 0, 10, 0), pt(0, 10, 0, 10), pt(10, 10, 10.5, 10)];
    const h = solveHelmert(src)!;
    const res = residuals(src, (x, y) => helmertApply(h, x, y));
    expect(res.max).toBeGreaterThan(0.1);
  });
});

describe('solveAffine', () => {
  /** せん断を含む 6 パラメータを復元する（ヘルマートでは表せない形）。 */
  it('せん断つきのパラメータを復元する', () => {
    // X' = 2x + 0.5y + 3、Y' = 0x + 4y − 1
    const f = (x: number, y: number): [number, number] => [2 * x + 0.5 * y + 3, 4 * y - 1];
    const src = [pt(0, 0, ...f(0, 0)), pt(1, 0, ...f(1, 0)), pt(0, 1, ...f(0, 1)), pt(2, 4, ...f(2, 4))];
    const a = solveAffine(src)!;
    expect(a.m11).toBeCloseTo(2, 10);
    expect(a.m12).toBeCloseTo(0.5, 10);
    expect(a.tx).toBeCloseTo(3, 10);
    expect(a.m21).toBeCloseTo(0, 10);
    expect(a.m22).toBeCloseTo(4, 10);
    expect(a.ty).toBeCloseTo(-1, 10);
    expect(affineDet(a)).toBeCloseTo(8, 10);
  });

  it('求めたパラメータで当てると残差がほぼ 0', () => {
    const src = [pt(0, 0, 3, -1), pt(1, 0, 5, -1), pt(0, 1, 3.5, 3), pt(2, 4, 9, 15)];
    const a = solveAffine(src)!;
    const res = residuals(src, (x, y) => affineApply(a, x, y));
    expect(res.max).toBeLessThan(1e-9);
  });

  it('2 点では解けない（3 点以上要る）', () => {
    expect(solveAffine([pt(0, 0, 0, 0), pt(1, 0, 1, 0)])).toBeNull();
  });

  /** 3 点が一直線に並ぶと、直線に直交する向きが決まらない。 */
  it('共通点が同一直線上なら解けない', () => {
    expect(solveAffine([pt(0, 0, 0, 0), pt(1, 1, 2, 2), pt(2, 2, 4, 4)])).toBeNull();
  });

  /** **ヘルマートはアフィンの特別な場合**（M11=M22, M12=−M21）。 */
  it('ヘルマートの解はアフィンとしても同じ結果になる', () => {
    // ヘルマートで厳密に表せる点でないと、自由度の高いアフィンは別解を出す
    const src = [pt(0, 0, 10, 20), pt(1, 0, 13, 24), pt(0, 1, 6, 23), pt(2, 3, 4, 37)];
    const h = solveHelmert(src)!;
    const a = solveAffine(src)!;
    expect(a.m11).toBeCloseTo(h.a, 8);
    expect(a.m22).toBeCloseTo(h.a, 8);
    expect(a.m12).toBeCloseTo(-h.b, 8);
    expect(a.m21).toBeCloseTo(h.b, 8);
  });

  it('helmertToAffine は同じ点へ写す', () => {
    const h = solveHelmert([pt(0, 0, 10, 20), pt(1, 0, 13, 24), pt(0, 1, 6, 23)])!;
    const a = helmertToAffine(h);
    for (const [x, y] of [
      [0, 0],
      [4, 8],
      [-16, 32],
    ]) {
      const p1 = helmertApply(h, x!, y!);
      const p2 = affineApply(a, x!, y!);
      expect(p2.x).toBeCloseTo(p1.x, 12);
      expect(p2.y).toBeCloseTo(p1.y, 12);
    }
  });
});

describe('residuals', () => {
  it('ズレの向きと大きさを点ごとに返す', () => {
    const src = [pt(0, 0, 0, 0), pt(4, 0, 4, 3)];
    const res = residuals(src, (x, y) => ({ x, y }));
    expect(res.each[0]).toMatchObject({ dx: 0, dy: 0, distance: 0 });
    expect(res.each[1]).toMatchObject({ dx: 0, dy: -3, distance: 3 });
    expect(res.max).toBe(3);
  });

  it('点が無ければ 0', () => {
    const res = residuals([], (x, y) => ({ x, y }));
    expect(res.max).toBe(0);
    expect(res.rms).toBe(0);
  });

  it('rms は二乗平均平方根', () => {
    const src = [pt(0, 0, 3, 0), pt(0, 0, 4, 0)];
    const res = residuals(src, () => ({ x: 0, y: 0 }));
    // ズレは 3 と 4 → rms = √((9+16)/2) = 3.5355…
    expect(res.rms).toBeCloseTo(Math.sqrt(12.5), 12);
  });
});

describe('controlPoints', () => {
  it('4 つとも数値の行だけを採る', () => {
    const { points, skipped } = controlPoints([
      { name: 'T1', sx: '0', sy: '0', tx: '10', ty: '20' },
      { name: 'T2', sx: '100', sy: '0', tx: '108', ty: '120' },
    ]);
    expect(points).toHaveLength(2);
    expect(skipped).toBe(0);
  });

  it('欠けた行は落として数える', () => {
    const { points, skipped } = controlPoints([
      { name: 'T1', sx: '0', sy: '0', tx: '10', ty: '20' },
      { name: 'T2', sx: '100', sy: '', tx: '108', ty: '120' },
      { name: 'T3', sx: 'abc', sy: '0', tx: '0', ty: '0' },
    ]);
    expect(points).toHaveLength(1);
    expect(skipped).toBe(2);
  });

  /** 表の余白（すべて空）は「欠け」ではない。 */
  it('空行は欠けに数えない', () => {
    const { points, skipped } = controlPoints([emptyTransformRow(), emptyTransformRow()]);
    expect(points).toHaveLength(0);
    expect(skipped).toBe(0);
  });
});

describe('normalizeTransformRows', () => {
  it('壊れた値を空文字へ落とす', () => {
    const rows = normalizeTransformRows([
      { name: 'T1', sx: '0', sy: '0', tx: '1', ty: '2' },
      { name: 5, sx: null },
    ]);
    expect(rows[0]!.name).toBe('T1');
    expect(rows[1]).toEqual(emptyTransformRow());
  });

  it('配列でなければ空', () => {
    expect(normalizeTransformRows(null)).toEqual([]);
  });
});

describe('.tc2 との往復（issue #29）', () => {
  function docDto(extra: Record<string, unknown>): Record<string, unknown> {
    return {
      Layers: [{ Name: '0', Color: 0xffffffff, Visible: true }],
      CurrentLayer: '0',
      Entities: [],
      ...extra,
    };
  }

  it('Transform を読み込む', () => {
    const { json } = tc2JsonToDocument(
      docDto({
        Transform: [
          { Name: 'T1', Sx: '0', Sy: '0', Tx: '10', Ty: '20' },
          { Name: 'T2', Sx: '1', Sy: '0', Tx: '13', Ty: '24' },
        ],
      }) as never,
    );
    expect(json.transform).toEqual([
      { name: 'T1', sx: '0', sy: '0', tx: '10', ty: '20' },
      { name: 'T2', sx: '1', sy: '0', tx: '13', ty: '24' },
    ]);
  });

  it('Transform が無ければ transform を持たない', () => {
    expect(tc2JsonToDocument(docDto({}) as never).json.transform).toBeUndefined();
  });

  /** 座標変換は取り込むので「落ちたもの」に挙げてはいけない。 */
  it('座標変換は droppedSections に出ない', () => {
    const { droppedSections } = tc2JsonToDocument(
      docDto({ Transform: [{ Name: 'T1', Sx: '0', Sy: '0', Tx: '0', Ty: '0' }] }) as never,
    );
    expect(droppedSections).not.toContain('座標変換');
  });

  it('書き出すと Transform が出る', () => {
    const doc = new CadDocument();
    doc.transform = [{ name: 'T1', sx: '0', sy: '0', tx: '10', ty: '20' }];
    expect(documentToTc2Json(doc.toJson()).Transform).toEqual([
      { Name: 'T1', Sx: '0', Sy: '0', Tx: '10', Ty: '20' },
    ]);
  });

  it('共通点が無ければ Transform を出さない（デスクトップ版に合わせる）', () => {
    expect(documentToTc2Json(new CadDocument().toJson()).Transform).toBeUndefined();
  });

  it('.tc2 を往復しても値が変わらない', () => {
    const doc = new CadDocument();
    doc.transform = [
      { name: 'T1', sx: '0', sy: '0', tx: '10', ty: '20' },
      { name: 'T2', sx: '1', sy: '0', tx: '13', ty: '24' },
      { name: 'T3', sx: '', sy: '', tx: '', ty: '' },
    ];
    const { json } = tc2JsonToDocument(documentToTc2Json(doc.toJson()) as never);
    const back = new CadDocument();
    back.loadJson(json);
    expect(back.transform).toEqual(doc.transform);
  });

  it('.tc2w（JSON）でも往復する', () => {
    const doc = new CadDocument();
    doc.transform = [{ name: 'T1', sx: '0', sy: '0', tx: '1', ty: '2' }];
    const back = new CadDocument();
    back.loadJson(JSON.parse(JSON.stringify(doc.toJson())));
    expect(back.transform).toEqual(doc.transform);
  });

  it('新規図面にすると共通点も消える', () => {
    const doc = new CadDocument();
    doc.transform = [{ name: 'T1', sx: '0', sy: '0', tx: '1', ty: '2' }];
    doc.clear();
    expect(doc.transform).toEqual([]);
  });

  /** 読んだ行から共通点を採り、そのまま解けることを通しで確かめる。 */
  it('読み込んだ行からヘルマートが解ける', () => {
    const { json } = tc2JsonToDocument(
      docDto({
        Transform: [
          { Name: 'T1', Sx: '0', Sy: '0', Tx: '10', Ty: '20' },
          { Name: 'T2', Sx: '1', Sy: '0', Tx: '13', Ty: '24' },
          { Name: 'T3', Sx: '0', Sy: '1', Tx: '6', Ty: '23' },
        ],
      }) as never,
    );
    const { points } = controlPoints(json.transform!);
    const h = solveHelmert(points)!;
    expect(helmertScale(h)).toBeCloseTo(5, 10);
  });
});

/**
 * ガウス消去の**部分ピボット**が要ることを固定する。
 *
 * 正規方程式の左上が他の要素よりずっと小さいと、そこを軸に消去したときに
 * 桁が飛び、**特異でない行列を「特異」と誤判定する**。測量の座標は
 * 平面直角座標のように大きく（10^6 のオーダー）、x 方向のばらつきだけが
 * 小さいことがあるので、机上の話ではない。
 */
describe('数値の安定性（部分ピボット）', () => {
  it('桁が大きく違う共通点でもアフィンが解ける', () => {
    const src = [pt(1e-9, 1e6, 5, 0), pt(2e-9, 2e6, 9, 0), pt(1e-9, 3e6, 13, 0)];
    const a = solveAffine(src);
    expect(a).not.toBeNull();
    // 解けたなら残差も見る（解が出ても合っていなければ意味がない）
    const res = residuals(src, (x, y) => affineApply(a!, x, y));
    expect(res.max).toBeLessThan(1e-6);
  });
});
