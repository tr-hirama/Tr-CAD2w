import { describe, expect, it } from 'vitest';
import {
  calcLevel,
  emptyLevelRow,
  normalizeLevelRows,
  parseNumber,
  referencedPoint,
  summarizeLevel,
  type LevelRow,
} from '../src/survey/level.js';
import { CadDocument } from '../src/core/document.js';
import { documentToTc2Json, tc2JsonToDocument } from '../src/io/tc2.js';

/** 読みやすさのための組み立て（未指定の列は空文字）。 */
function r(name: string, part: Partial<LevelRow> = {}): LevelRow {
  return { ...emptyLevelRow(name), ...part };
}

describe('parseNumber', () => {
  it('ふつうの数値を読む', () => {
    expect(parseNumber('1.5')).toBe(1.5);
    expect(parseNumber('-0.25')).toBe(-0.25);
    expect(parseNumber('  8  ')).toBe(8);
  });

  it('空欄と非数値は null', () => {
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('   ')).toBeNull();
    expect(parseNumber('BM')).toBeNull();
    expect(parseNumber('[K1]')).toBeNull();
  });

  it('全角の数字も読む（現場の入力に混ざる）', () => {
    expect(parseNumber('１．２５')).toBe(1.25);
    expect(parseNumber('－０．５')).toBe(-0.5);
  });

  it('桁区切りのカンマを外す', () => {
    expect(parseNumber('1,234.5')).toBe(1234.5);
  });
});

describe('referencedPoint', () => {
  it('[点番] から点番を採る', () => {
    expect(referencedPoint('[BM1]')).toBe('BM1');
    expect(referencedPoint('  [ K3 ] ')).toBe('K3');
  });

  it('参照でなければ null', () => {
    expect(referencedPoint('1.5')).toBeNull();
    expect(referencedPoint('')).toBeNull();
    expect(referencedPoint('[]')).toBeNull();
  });
});

describe('calcLevel（器高式）', () => {
  /**
   * いちばん基本の形。
   * BM（GH=10）で後視 1.5 → 器械高 11.5。次の点を前視 0.5 で見て GH=11。
   */
  it('後視で器械高を作り、前視で地盤高を出す', () => {
    const c = calcLevel([r('BM', { bs: '1.5', gh: '10' }), r('No.1', { fs: '0.5' })]);
    expect(c.rows).toHaveLength(2);
    expect(c.rows[0]).toMatchObject({ name: 'BM', gh: 10, ih: 11.5, bs: 1.5, kind: 'instrument' });
    expect(c.rows[1]).toMatchObject({ name: 'No.1', gh: 11, fs: 0.5, kind: 'foresight' });
  });

  it('地盤高の入力が無い既知点は GH=0 として器械高を作る', () => {
    const c = calcLevel([r('BM', { bs: '2' }), r('No.1', { fs: '0.5' })]);
    expect(c.rows[0]).toMatchObject({ gh: 0, ih: 2 });
    expect(c.rows[1]).toMatchObject({ gh: 1.5 });
  });

  it('転換点をまたいでも累加する', () => {
    // BM(GH=0) BS=1.0 → IH=1.0 / TP1 FS=0.25 → GH=0.75 / TP1 BS=1.5 → IH=2.25 / No.2 FS=0.25 → GH=2.0
    const c = calcLevel([
      r('BM', { bs: '1.0' }),
      r('TP1', { fs: '0.25' }),
      r('TP1', { bs: '1.5' }),
      r('No.2', { fs: '0.25' }),
    ]);
    expect(c.rows.map((x) => x.gh)).toEqual([0, 0.75, 0.75, 2]);
    expect(c.rows[2]).toMatchObject({ ih: 2.25 });
  });

  /**
   * **転換点（同じ行に前視と後視）**。issue #52。
   *
   * 到達した点をその場で読んで、そのまま器械を据え直す書き方（従来の TrCad2D 方式）。
   * BM(GH=10) BS=1.5 → IH=11.5 / TP1 は TP=0.5 で GH=11、そこへ BS=1.25 で IH=12.25 /
   * No.2 FS=0.25 → GH=12。
   *
   * **後視を先に見ると TP1 の GH が 0 になり**、IH=1.25、No.2 の GH=1 と全部ずれる。
   */
  it('同じ行に前視と後視があるとき、前視で地盤高を出してから器械を据え直す', () => {
    const c = calcLevel([
      r('BM', { bs: '1.5', gh: '10' }),
      r('TP1', { bs: '1.25', tp: '0.5' }),
      r('No.2', { fs: '0.25' }),
    ]);
    expect(c.rows[1]).toMatchObject({ name: 'TP1', gh: 11, bs: 1.25, fs: 0.5, ih: 12.25, kind: 'turning' });
    expect(c.rows[2]).toMatchObject({ name: 'No.2', gh: 12 });
    expect(c.fixed.get('TP1')).toBe(11);
  });

  /** `FS` 列に書く現場もある。TP と同じ結果になる。 */
  it('転換点は FS 列でも同じに解ける', () => {
    const c = calcLevel([r('BM', { bs: '1.5', gh: '10' }), r('TP1', { bs: '1.25', fs: '0.5' })]);
    expect(c.rows[1]).toMatchObject({ gh: 11, ih: 12.25, kind: 'turning' });
  });

  /** 器械がまだ無ければ、後視が同じ行にあっても地盤高は出せない（デスクトップ版も GH 空）。 */
  it('器械高より前の転換点は解決できない行として残す', () => {
    const c = calcLevel([r('TP1', { bs: '1.25', tp: '0.5' })]);
    expect(c.rows).toHaveLength(0);
    expect(c.unresolved[0]!.reason).toContain('器械高');
  });

  /** 転換点の後視も合計に入る（帳票の B 列に出るため）。 */
  it('転換点の後視と前視は両方とも合計に入る', () => {
    const s = summarizeLevel(
      calcLevel([r('BM', { bs: '1.5', gh: '10' }), r('TP1', { bs: '1.25', tp: '0.5' }), r('No.2', { fs: '0.25' })]),
    );
    expect(s.totalBs).toBe(2.75);
    expect(s.totalFs).toBe(0.75);
  });

  /** `TP` 列に入っていても前視として読む。見ないと「与点」に落ちて計算が狂う。 */
  it('TP 列の値を前視として読む', () => {
    const c = calcLevel([r('BM', { bs: '1.0' }), r('TP1', { tp: '0.4' })]);
    expect(c.rows[1]).toMatchObject({ name: 'TP1', gh: 0.6, fs: 0.4, kind: 'foresight' });
  });

  it('FS があれば TP より FS を優先する', () => {
    const c = calcLevel([r('BM', { bs: '1.0' }), r('TP1', { fs: '0.25', tp: '0.4' })]);
    expect(c.rows[1]).toMatchObject({ gh: 0.75, fs: 0.25 });
  });

  it('[点番] 参照は参照点の地盤高に前視を足す', () => {
    const c = calcLevel([
      r('BM', { bs: '1.0', gh: '5' }), // IH = 6
      r('A', { bs: '[BM]', fs: '0.5' }), // GH = 5 + 0.5 = 5.5、C 列は 6 - 5.5 = 0.5
    ]);
    expect(c.rows[1]).toMatchObject({ name: 'A', gh: 5.5, fs: 0.5, kind: 'reference' });
  });

  it('与点（BS も FS も無く GH だけ）はその値を使う', () => {
    const c = calcLevel([r('KBM', { gh: '12.345' })]);
    expect(c.rows[0]).toMatchObject({ name: 'KBM', gh: 12.345, fs: 12.345, kind: 'given' });
  });

  /**
   * **確定 GH は初回のみ**。既知点へ点検の前視を打っても上書きしない。
   * 上書きすると点検の誤差が器械高へ伝播し、以降が全部ずれる。
   */
  it('既知点への点検の前視で地盤高を上書きしない', () => {
    const c = calcLevel([
      r('BM', { bs: '1.0', gh: '10' }), // GH=10 で確定、IH=11
      r('No.1', { fs: '0.5' }), // GH=10.5
      r('No.1', { bs: '2.0' }), // 据え直し。確定済み GH=10.5 を使って IH=12.5
      r('BM', { fs: '2.6' }), // 点検。GH は 9.9 と出るが、確定値 10 は動かさない
      r('BM', { bs: '1.0' }), // 再据付。確定値 10 を使うので IH=11
    ]);
    expect(c.fixed.get('BM')).toBe(10);
    expect(c.rows[2]).toMatchObject({ ih: 12.5 });
    expect(c.rows[4]).toMatchObject({ ih: 11 });
  });

  it('器械高より前の前視は解決できない行として残す', () => {
    const c = calcLevel([r('No.1', { fs: '0.5' })]);
    expect(c.rows).toHaveLength(0);
    expect(c.unresolved[0]).toMatchObject({ name: 'No.1' });
    expect(c.unresolved[0]!.reason).toContain('器械高');
  });

  it('参照先が未確定なら解決できない行として残す', () => {
    const c = calcLevel([r('BM', { bs: '1.0' }), r('A', { bs: '[XX]', fs: '0.5' })]);
    expect(c.unresolved[0]!.reason).toContain('[XX]');
  });

  it('数値がどこにも無い行は解決できない行として残す', () => {
    const c = calcLevel([r('BM', { bs: '1.0' }), r('メモ', { remarks: '雨天中断' })]);
    expect(c.unresolved[0]).toMatchObject({ name: 'メモ' });
  });

  it('名前の無い行（表の空行）は黙って飛ばす', () => {
    const c = calcLevel([r(''), r('BM', { bs: '1.0' }), r('   ')]);
    expect(c.rows).toHaveLength(1);
    expect(c.unresolved).toHaveLength(0);
  });

  it('1 行の欠けで計算を止めない', () => {
    const c = calcLevel([
      r('BM', { bs: '1.0' }),
      r('こわれた行', {}),
      r('No.1', { fs: '0.25' }), // ここは解ける
    ]);
    expect(c.rows.map((x) => x.name)).toEqual(['BM', 'No.1']);
    expect(c.unresolved).toHaveLength(1);
  });

  it('地盤高は二進小数で厳密に出る', () => {
    const c = calcLevel([r('BM', { bs: '1.25', gh: '0.5' }), r('No.1', { fs: '0.25' })]);
    expect(c.rows[0]!.ih).toBe(1.75);
    expect(c.rows[1]!.gh).toBe(1.5);
  });
});

describe('summarizeLevel', () => {
  it('後視・前視の合計と高低差を出す', () => {
    const c = calcLevel([
      r('BM', { bs: '1.5' }),
      r('TP1', { fs: '0.5' }),
      r('TP1', { bs: '1.25' }),
      r('No.2', { fs: '0.25' }),
    ]);
    const s = summarizeLevel(c);
    expect(s.totalBs).toBe(2.75);
    expect(s.totalFs).toBe(0.75);
    expect(s.difference).toBe(2);
    expect(s.resolved).toBe(4);
    expect(s.unresolved).toBe(0);
  });

  it('解けなかった行の数も返す', () => {
    const s = summarizeLevel(calcLevel([r('No.1', { fs: '0.5' })]));
    expect(s.resolved).toBe(0);
    expect(s.unresolved).toBe(1);
  });
});

describe('normalizeLevelRows', () => {
  it('壊れた値を空文字へ落とす', () => {
    const rows = normalizeLevelRows([
      { name: 'BM', bs: '1.5', fs: '', gh: '10', remarks: '', tp: '', ck: '' },
      { name: 123, bs: null, fs: undefined },
    ]);
    expect(rows[0]!.name).toBe('BM');
    expect(rows[1]).toEqual(emptyLevelRow());
  });

  it('配列でなければ空', () => {
    expect(normalizeLevelRows(null)).toEqual([]);
    expect(normalizeLevelRows('x')).toEqual([]);
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

  it('Level を読み込む（全 7 列）', () => {
    const { json } = tc2JsonToDocument(
      docDto({
        Level: [
          { Name: 'BM', BS: '1.5', FS: '', GH: '10', Remarks: '基準点', TP: '', CK: '' },
          { Name: 'No.1', BS: '', FS: '0.5', GH: '', Remarks: '', TP: '', CK: '0.002' },
        ],
      }) as never,
    );
    expect(json.level).toEqual([
      { name: 'BM', bs: '1.5', fs: '', gh: '10', remarks: '基準点', tp: '', ck: '' },
      { name: 'No.1', bs: '', fs: '0.5', gh: '', remarks: '', tp: '', ck: '0.002' },
    ]);
  });

  it('Level が無ければ level を持たない', () => {
    expect(tc2JsonToDocument(docDto({}) as never).json.level).toBeUndefined();
  });

  /** レベルは取り込むので「落ちたもの」に挙げてはいけない。 */
  it('レベルは droppedSections に出ない', () => {
    const { droppedSections } = tc2JsonToDocument(
      docDto({ Level: [{ Name: 'BM', BS: '1.5', FS: '', GH: '', Remarks: '', TP: '', CK: '' }] }) as never,
    );
    expect(droppedSections).not.toContain('レベル');
  });

  it('書き出すと Level が出る', () => {
    const doc = new CadDocument();
    doc.level = [r('BM', { bs: '1.5', gh: '10', remarks: '基準点' })];
    const out = documentToTc2Json(doc.toJson());
    expect(out.Level).toEqual([
      { Name: 'BM', BS: '1.5', FS: '', GH: '10', Remarks: '基準点', TP: '', CK: '' },
    ]);
  });

  it('レベルが無ければ Level を出さない（デスクトップ版に合わせる）', () => {
    expect(documentToTc2Json(new CadDocument().toJson()).Level).toBeUndefined();
  });

  it('.tc2 を往復しても値が変わらない', () => {
    const doc = new CadDocument();
    doc.level = [
      r('BM', { bs: '1.5', gh: '10', remarks: '基準点' }),
      r('TP1', { fs: '0.5', tp: '0.5' }),
      r('No.2', { fs: '0.25', ck: '0.002' }),
    ];
    const { json } = tc2JsonToDocument(documentToTc2Json(doc.toJson()) as never);
    const back = new CadDocument();
    back.loadJson(json);
    expect(back.level).toEqual(doc.level);
  });

  it('.tc2w（JSON）でも往復する', () => {
    const doc = new CadDocument();
    doc.level = [r('BM', { bs: '1.5' })];
    const back = new CadDocument();
    back.loadJson(JSON.parse(JSON.stringify(doc.toJson())));
    expect(back.level).toEqual(doc.level);
  });

  it('新規図面にするとレベルも消える', () => {
    const doc = new CadDocument();
    doc.level = [r('BM', { bs: '1.5' })];
    doc.clear();
    expect(doc.level).toEqual([]);
  });
});
