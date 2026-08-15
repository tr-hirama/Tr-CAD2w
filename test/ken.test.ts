import { describe, expect, it } from 'vitest';
import {
  checkSequence,
  confirmGosa,
  incompleteCount,
  cloneKenTable,
  emptyKenTable,
  isKenTableEmpty,
  kenNumber,
  normalizeKenTable,
  summarize,
  type KenRow,
} from '../src/survey/ken.js';
import { CadDocument } from '../src/core/document.js';
import { documentToTc2Json, tc2JsonToDocument } from '../src/io/tc2.js';

function row(name: string, calcDist: number, measured = '', unable = false): KenRow {
  return { name, measured, calcDist, unable };
}

describe('kenNumber', () => {
  it('K+数字から番号を採る', () => {
    expect(kenNumber('K1')).toBe(1);
    expect(kenNumber('K12')).toBe(12);
    expect(kenNumber('k3')).toBe(3);
  });

  it('前後の空白は無視する', () => {
    expect(kenNumber('  K7  ')).toBe(7);
  });

  it('K+数字の形でなければ null', () => {
    expect(kenNumber('T1')).toBeNull();
    expect(kenNumber('K')).toBeNull();
    expect(kenNumber('K1A')).toBeNull();
    expect(kenNumber('')).toBeNull();
    expect(kenNumber('K0')).toBeNull(); // 境界は K1 から
  });
});

describe('checkSequence', () => {
  it('K1 からの連番なら complete', () => {
    const c = checkSequence([row('K1', 8), row('K2', 4), row('K3', 8), row('K4', 4)]);
    expect(c.complete).toBe(true);
    expect(c.missing).toEqual([]);
  });

  it('順番が入れ替わっていても連番なら complete', () => {
    expect(checkSequence([row('K3', 1), row('K1', 1), row('K2', 1)]).complete).toBe(true);
  });

  /** issue #28 の受け入れ条件そのもの。 */
  it('K1 K2 K3 K7 は欠番として拾う', () => {
    const c = checkSequence([row('K1', 1), row('K2', 1), row('K3', 1), row('K7', 1)]);
    expect(c.complete).toBe(false);
    expect(c.missing).toEqual([4, 5, 6]);
  });

  it('K1 が無ければ欠番', () => {
    const c = checkSequence([row('K2', 1), row('K3', 1)]);
    expect(c.complete).toBe(false);
    expect(c.missing).toEqual([1]);
  });

  it('K+数字でない名前を拾う', () => {
    const c = checkSequence([row('K1', 1), row('T7', 1)]);
    expect(c.complete).toBe(false);
    expect(c.invalid).toEqual(['T7']);
  });

  it('番号の重複を拾う', () => {
    const c = checkSequence([row('K1', 1), row('K2', 1), row('K2', 1)]);
    expect(c.complete).toBe(false);
    expect(c.duplicated).toEqual([2]);
  });

  it('空なら complete ではない', () => {
    expect(checkSequence([]).complete).toBe(false);
  });
});

describe('summarize', () => {
  it('連番が揃っていれば周長を出す', () => {
    const s = summarize({ rows: [row('K1', 8), row('K2', 4), row('K3', 8), row('K4', 4)], keisanten: false });
    expect(s.perimeter).toBe(24);
    expect(s.reason).toBe('');
    expect(s.count).toBe(4);
  });

  /** 欠けた辺のぶんだけ短い値が出て、正しく見えてしまうのを防ぐ。 */
  it('欠番があれば周長を出さず、理由を返す', () => {
    const s = summarize({ rows: [row('K1', 8), row('K2', 4), row('K3', 8), row('K7', 4)], keisanten: false });
    expect(s.perimeter).toBeNull();
    expect(s.reason).toContain('K4 / K5 / K6 が欠番');
  });

  it('K+数字でない名前があれば周長を出さない', () => {
    const s = summarize({ rows: [row('K1', 8), row('境界A', 4)], keisanten: false });
    expect(s.perimeter).toBeNull();
    expect(s.reason).toContain('境界A');
  });

  it('「不可」の辺も周長には含める（測れないだけで辺は在る）', () => {
    const s = summarize({
      rows: [row('K1', 8), row('K2', 4, '', true), row('K3', 8), row('K4', 4)],
      keisanten: false,
    });
    expect(s.perimeter).toBe(24);
    expect(s.unableCount).toBe(1);
  });

  it('空なら周長は null', () => {
    const s = summarize(emptyKenTable());
    expect(s.perimeter).toBeNull();
    expect(s.reason).toBe('まわりけんがありません');
    expect(s.count).toBe(0);
  });

  it('周長は二進小数で厳密に足せる', () => {
    const s = summarize({ rows: [row('K1', 0.25), row('K2', 0.25), row('K3', 0.5)], keisanten: false });
    expect(s.perimeter).toBe(1);
  });
});

describe('KenTable の器', () => {
  it('空の表は isKenTableEmpty', () => {
    expect(isKenTableEmpty(emptyKenTable())).toBe(true);
  });

  it('計算点ありだけでも空ではない', () => {
    expect(isKenTableEmpty({ rows: [], keisanten: true })).toBe(false);
  });

  it('複製は元と切り離れている', () => {
    const src = { rows: [row('K1', 8)], keisanten: true };
    const copy = cloneKenTable(src);
    copy.rows[0]!.name = 'K9';
    copy.keisanten = false;
    expect(src.rows[0]!.name).toBe('K1');
    expect(src.keisanten).toBe(true);
  });

  it('壊れた値を既定へ落として受ける', () => {
    const t = normalizeKenTable({
      rows: [
        { name: 'K1', measured: '8.00', calcDist: 8, unable: false },
        // @ts-expect-error 壊れた行を意図的に渡す
        { name: 123, measured: null, calcDist: 'x', unable: 'yes' },
      ],
      keisanten: true,
    });
    expect(t.rows[0]).toEqual({ name: 'K1', measured: '8.00', calcDist: 8, unable: false });
    expect(t.rows[1]).toEqual({ name: '', measured: '', calcDist: 0, unable: false });
    expect(t.keisanten).toBe(true);
  });

  it('null / undefined でも空の表になる', () => {
    expect(normalizeKenTable(null)).toEqual(emptyKenTable());
    expect(normalizeKenTable(undefined)).toEqual(emptyKenTable());
  });
});

describe('.tc2 との往復（issue #28）', () => {
  /** `.tc2` の DocDto を最小構成で組む。 */
  function docDto(extra: Record<string, unknown>): Record<string, unknown> {
    return {
      Layers: [{ Name: '0', Color: 0xffffffff, Visible: true }],
      CurrentLayer: '0',
      Entities: [],
      ...extra,
    };
  }

  it('Ken と Keisanten を読み込む', () => {
    const { json } = tc2JsonToDocument(
      docDto({
        Ken: [
          { Name: 'K1', Measured: '8.005', CalcDist: 8, Unable: false },
          { Name: 'K2', Measured: '', CalcDist: 4, Unable: true },
        ],
        Keisanten: true,
      }) as never,
    );
    expect(json.ken).toEqual({
      rows: [
        { name: 'K1', measured: '8.005', calcDist: 8, unable: false },
        { name: 'K2', measured: '', calcDist: 4, unable: true },
      ],
      keisanten: true,
    });
  });

  it('Ken が無ければ ken を持たない', () => {
    const { json } = tc2JsonToDocument(docDto({}) as never);
    expect(json.ken).toBeUndefined();
  });

  /** まわりけんは取り込むので「落ちたもの」に挙げてはいけない。 */
  it('まわりけんは droppedSections に出ない', () => {
    const { droppedSections } = tc2JsonToDocument(
      docDto({ Ken: [{ Name: 'K1', Measured: '8', CalcDist: 8, Unable: false }] }) as never,
    );
    expect(droppedSections).not.toContain('まわりけん');
  });

  it('書き出すと Ken / Keisanten が出る', () => {
    const doc = new CadDocument();
    doc.ken = {
      rows: [{ name: 'K1', measured: '8.005', calcDist: 8, unable: false }],
      keisanten: true,
    };
    const out = documentToTc2Json(doc.toJson());
    expect(out.Ken).toEqual([{ Name: 'K1', Measured: '8.005', CalcDist: 8, Unable: false }]);
    expect(out.Keisanten).toBe(true);
  });

  it('まわりけんが無ければ Ken を出さない（デスクトップ版に合わせる）', () => {
    const out = documentToTc2Json(new CadDocument().toJson());
    expect(out.Ken).toBeUndefined();
    expect(out.Keisanten).toBeUndefined();
  });

  it('.tc2 を往復しても値が変わらない', () => {
    const doc = new CadDocument();
    doc.ken = {
      rows: [
        { name: 'K1', measured: '8.005', calcDist: 8, unable: false },
        { name: 'K2', measured: '', calcDist: 4, unable: true },
        { name: 'K3', measured: '12.250', calcDist: 12.25, unable: false },
      ],
      keisanten: false,
    };
    const { json } = tc2JsonToDocument(documentToTc2Json(doc.toJson()) as never);
    const back = new CadDocument();
    back.loadJson(json);
    expect(back.ken).toEqual(doc.ken);
  });

  it('.tc2w（JSON）でも往復する', () => {
    const doc = new CadDocument();
    doc.ken = { rows: [{ name: 'K1', measured: '8', calcDist: 8, unable: false }], keisanten: true };
    const back = new CadDocument();
    back.loadJson(JSON.parse(JSON.stringify(doc.toJson())));
    expect(back.ken).toEqual(doc.ken);
  });

  it('新規図面にするとまわりけんも消える', () => {
    const doc = new CadDocument();
    doc.ken = { rows: [{ name: 'K1', measured: '8', calcDist: 8, unable: false }], keisanten: true };
    doc.clear();
    expect(doc.ken).toEqual(emptyKenTable());
  });
});

describe('誤差の判定（confirmGosa・デスクトップ版 MawarikenRow の移植）', () => {
  /** `.tc2` の Measured / CalcDist はどちらも m。誤差だけ mm で判定する。 */
  function g(measured: string, calcDist: number, unable = false): ReturnType<typeof confirmGosa> {
    return confirmGosa({ name: 'K1', measured, calcDist, unable });
  }

  it('誤差 10mm は水色（数値を m で出す）', () => {
    const r = g('10.010', 10);
    expect(r.level).toBe('ok');
    expect(r.text).toBe('0.010');
    expect(r.mm).toBeCloseTo(10, 9);
  });

  it('しきい値ちょうど 20mm は水色', () => {
    expect(g('10.020', 10).level).toBe('ok');
  });

  it('誤差 35mm は金', () => {
    const r = g('10.035', 10);
    expect(r.level).toBe('warn');
    expect(r.text).toBe('0.035');
  });

  it('しきい値ちょうど 50mm は金', () => {
    expect(g('10.050', 10).level).toBe('warn');
  });

  it('誤差 60mm は Over（赤）', () => {
    const r = g('10.060', 10);
    expect(r.level).toBe('ng');
    expect(r.text).toBe('Over');
  });

  it('非数値は － （赤）', () => {
    expect(g('abc', 10)).toMatchObject({ text: '－', level: 'ng' });
  });

  it('未入力は空（判定なし）', () => {
    expect(g('', 10)).toMatchObject({ text: '', level: 'none' });
    expect(g('   ', 10)).toMatchObject({ text: '', level: 'none' });
  });

  it('計算値が無ければ No point（赤）', () => {
    expect(g('10.5', 0)).toMatchObject({ text: 'No point', level: 'ng' });
    expect(g('10.5', -1)).toMatchObject({ text: 'No point', level: 'ng' });
  });

  /** 判定の順番を守る。不可は他のどれより先に見る。 */
  it('不可は入力があっても 不可（赤）', () => {
    expect(g('10.010', 10, true)).toMatchObject({ text: '不可', level: 'ng' });
  });

  it('マイナス方向の誤差も絶対値で見る', () => {
    expect(g('9.990', 10).level).toBe('ok');
    expect(g('9.940', 10).level).toBe('ng');
  });

  /**
   * **境界値は等号側に入れる**（利用者の指示）。
   *
   * 引き算の浮動小数のズレは**座標が大きいほど育つ**。実際の測量座標は 6 桁以上あり、
   * `123456.050 - 123456.000` は mm にすると `50.00000000291038` になる。
   * 固定の許容値（1e-9 など）では吸収しきれず、ちょうど 50mm が Over に落ちていた。
   */
  describe('境界値は座標が大きくても等号側に入る', () => {
    it('6 桁の座標でちょうど 50mm は金', () => {
      expect(Math.abs(123456.05 - 123456) * 1000).toBeGreaterThan(50); // 素直に引くと 50 を超える
      expect(g('123456.050', 123456).level).toBe('warn');
    });

    it('7 桁の座標でちょうど 20mm は水色', () => {
      expect(Math.abs(1234567.02 - 1234567) * 1000).toBeGreaterThan(20);
      expect(g('1234567.020', 1234567).level).toBe('ok');
    });

    it('6 桁の座標でちょうど 20mm は水色', () => {
      expect(g('123456.020', 123456).level).toBe('ok');
    });

    /** 丸めで消すのは浮動小数のゴミだけ。入力から生じる差は残す。 */
    it('入力どおりの 51mm は座標が大きくても Over', () => {
      expect(g('123456.051', 123456).level).toBe('ng');
    });

    it('入力どおりの 21mm は座標が大きくても金', () => {
      expect(g('123456.021', 123456).level).toBe('warn');
    });

    it('丸めた誤差を表示にも使う（0.050 と出す）', () => {
      expect(g('123456.050', 123456).text).toBe('0.050');
      expect(g('123456.050', 123456).mm).toBe(50);
    });
  });
});

describe('incompleteCount', () => {
  function row2(measured: string, calcDist: number, unable = false): KenRow {
    return { name: 'K1', measured, calcDist, unable };
  }

  it('Ok と Warn は完了とみなす', () => {
    expect(incompleteCount([row2('10.010', 10), row2('10.035', 10)])).toBe(0);
  });

  it('Over・非数値・未入力は入れ直しが要る', () => {
    expect(incompleteCount([row2('10.060', 10), row2('abc', 10), row2('', 10)])).toBe(3);
  });

  /** 測れない辺は対象外。数えると永久に 0 にならない。 */
  it('不可の辺は数えない', () => {
    expect(incompleteCount([row2('', 10, true), row2('abc', 10, true)])).toBe(0);
  });
});
