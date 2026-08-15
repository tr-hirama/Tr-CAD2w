import { describe, expect, it } from 'vitest';
import {
  canEncodeShiftJis,
  encodeShiftJis,
  shiftJisTableSize,
  unmappableChars,
} from '../src/io/shift-jis.js';
import { CadDocument } from '../src/core/document.js';
import { DEFAULT_ATTRS } from '../src/core/entity.js';
import { vec } from '../src/core/geometry.js';
import { documentToDxf, documentToDxfBytes } from '../src/io/dxf-write.js';
import { readDxfBytes } from '../src/io/dxf.js';

/** 期待するバイト列を読みやすく書くための小道具。 */
function bytes(...v: number[]): Uint8Array {
  return new Uint8Array(v);
}

describe('Shift-JIS への符号化', () => {
  it('ASCII はそのまま 1 バイト', () => {
    expect(encodeShiftJis('AZ09').bytes).toEqual(bytes(0x41, 0x5a, 0x30, 0x39));
  });

  it('ひらがな・漢字が既知のバイト列になる', () => {
    // あ = 82A0、京 = 8B9E（Encoding Standard の shift_jis 索引）
    expect(encodeShiftJis('あ').bytes).toEqual(bytes(0x82, 0xa0));
    expect(encodeShiftJis('京').bytes).toEqual(bytes(0x8b, 0x9e));
  });

  it('半角カナは 1 バイト', () => {
    expect(encodeShiftJis('ｱ').bytes).toEqual(bytes(0xb1));
  });

  it('全角と半角が混ざっても順番どおり', () => {
    expect(encodeShiftJis('A あ ｱ').bytes).toEqual(bytes(0x41, 0x20, 0x82, 0xa0, 0x20, 0xb1));
  });

  it('Shift-JIS に無い文字は ? へ落とし、数を返す', () => {
    // 絵文字は JIS X 0208 にも CP932 拡張にも無い
    const r = encodeShiftJis('図面🙂です');
    expect(r.unmapped).toBe(1);
    // ? = 0x3F が 1 つだけ入る
    expect([...r.bytes].filter((b) => b === 0x3f)).toHaveLength(1);
  });

  it('落ちた文字を重複なく拾える', () => {
    expect(unmappableChars('🙂🙂🙂')).toEqual(['🙂']);
    expect(unmappableChars('境界点')).toEqual([]);
  });

  it('canEncodeShiftJis が書ける・書けないを見分ける', () => {
    expect(canEncodeShiftJis('境界点 K-12')).toBe(true);
    expect(canEncodeShiftJis('図面🙂')).toBe(false);
  });

  it('表は 9000 文字以上ある（JIS X 0208 + CP932 拡張）', () => {
    expect(shiftJisTableSize()).toBeGreaterThan(9000);
  });

  /**
   * **書いたものが読み側と一致することが唯一の正しさ**。表は `TextDecoder` から
   * 組んでいるので、同じデコーダに戻せば必ず元へ戻るはず。ここが崩れたら表が壊れている。
   */
  it('TextDecoder に戻すと元の文字列に一致する', () => {
    const src = 'あいうえお 漢字 ｶﾅ ABC 123 －①Ⅲ㈱';
    const { bytes: b, unmapped } = encodeShiftJis(src);
    expect(unmapped).toBe(0);
    expect(new TextDecoder('shift_jis').decode(b)).toBe(src);
  });

  it('空文字列は空のバイト列', () => {
    expect(encodeShiftJis('').bytes).toEqual(bytes());
    expect(encodeShiftJis('').unmapped).toBe(0);
  });
});

describe('DXF の Shift-JIS 書き出し（issue #4）', () => {
  function sample(): CadDocument {
    const doc = new CadDocument();
    doc.addAll([
      { ...DEFAULT_ATTRS, layer: '境界', kind: 'line', a: vec(0, 0), b: vec(8, 4) },
      {
        ...DEFAULT_ATTRS,
        layer: '点番',
        kind: 'text',
        at: vec(4, 8),
        text: '境界点 K-12',
        height: 2.5,
        rotation: 0,
        hAlign: 'left',
        vAlign: 'baseline',
      },
    ]);
    return doc;
  }

  it('既定は UTF-8 / R2007（AC1021）で $DWGCODEPAGE を出さない', () => {
    const text = documentToDxf(sample().toJson());
    expect(text).toContain('AC1021');
    expect(text).not.toContain('$DWGCODEPAGE');
  });

  it('shift_jis では R2000（AC1015）＋ $DWGCODEPAGE=ANSI_932 を出す', () => {
    const text = documentToDxf(sample().toJson(), { encoding: 'shift_jis' });
    expect(text).toContain('AC1015');
    expect(text).toContain('$DWGCODEPAGE');
    expect(text).toContain('ANSI_932');
    expect(text).not.toContain('AC1021');
  });

  it('バイト列が Shift-JIS になっている（UTF-8 とは別物）', () => {
    const json = sample().toJson();
    const utf8 = documentToDxfBytes(json);
    const sjis = documentToDxfBytes(json, { encoding: 'shift_jis' });
    expect(utf8.encoding).toBe('utf-8');
    expect(sjis.encoding).toBe('shift_jis');
    // 「境」は UTF-8 では 3 バイト、Shift-JIS では 2 バイト。日本語のぶんだけ縮む
    expect(sjis.bytes.length).toBeLessThan(utf8.bytes.length);
    // Shift-JIS のバイト列に UTF-8 の「境」(E5 A2 83) は現れない
    const hasUtf8Kyou = [...sjis.bytes].some(
      (b, i) => b === 0xe5 && sjis.bytes[i + 1] === 0xa2 && sjis.bytes[i + 2] === 0x83,
    );
    expect(hasUtf8Kyou).toBe(false);
  });

  /** 読込側は `$DWGCODEPAGE` を見て Shift-JIS と判定する。ここが往復の要。 */
  it('Shift-JIS で書いた DXF を読み直すと日本語が化けない', () => {
    const src = sample();
    const { bytes: b } = documentToDxfBytes(src.toJson(), { encoding: 'shift_jis' });
    const res = readDxfBytes(b);
    expect(res.encoding).toBe('shift_jis (codepage)');

    const back = new CadDocument();
    back.loadJson(res.json);
    expect(back.count).toBe(2);
    expect(back.entities[0]!.layer).toBe('境界');
    expect(back.entities[1]!.layer).toBe('点番');
    expect(back.entities[1]).toMatchObject({ kind: 'text', text: '境界点 K-12' });
  });

  it('Shift-JIS でも座標・色・線種が UTF-8 と同じに戻る', () => {
    const src = sample();
    const readBack = (encoding: 'utf-8' | 'shift_jis'): CadDocument => {
      const doc = new CadDocument();
      doc.loadJson(readDxfBytes(documentToDxfBytes(src.toJson(), { encoding }).bytes).json);
      return doc;
    };
    const strip = (d: CadDocument): unknown =>
      JSON.stringify(d.entities.map(({ id: _id, ...rest }) => rest));
    expect(strip(readBack('shift_jis'))).toEqual(strip(readBack('utf-8')));
  });

  it('書けない文字は ? になり、件数と文字を返す', () => {
    const doc = new CadDocument();
    doc.add({
      ...DEFAULT_ATTRS,
      kind: 'text',
      at: vec(0, 0),
      text: '完了🙂',
      height: 2.5,
      rotation: 0,
      hAlign: 'left',
      vAlign: 'baseline',
    });
    const r = documentToDxfBytes(doc.toJson(), { encoding: 'shift_jis' });
    expect(r.unmapped).toBe(1);
    expect(r.unmappedChars).toEqual(['🙂']);

    const back = new CadDocument();
    back.loadJson(readDxfBytes(r.bytes).json);
    expect(back.entities[0]).toMatchObject({ text: '完了?' });
  });

  it('UTF-8 では絵文字も落ちない（Shift-JIS を選んだときだけの代償）', () => {
    const doc = new CadDocument();
    doc.add({
      ...DEFAULT_ATTRS,
      kind: 'text',
      at: vec(0, 0),
      text: '完了🙂',
      height: 2.5,
      rotation: 0,
      hAlign: 'left',
      vAlign: 'baseline',
    });
    const r = documentToDxfBytes(doc.toJson());
    expect(r.unmapped).toBe(0);
    const back = new CadDocument();
    back.loadJson(readDxfBytes(r.bytes).json);
    expect(back.entities[0]).toMatchObject({ text: '完了🙂' });
  });
});
