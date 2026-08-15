import { describe, expect, it } from 'vitest';
import { vec } from '../src/core/geometry.js';
import { CadDocument, FILE_FORMAT_VERSION, type DocumentJson } from '../src/core/document.js';
import { DEFAULT_ATTRS } from '../src/core/entity.js';
import { STANDARD_LAYERS } from '../src/core/layer.js';
import {
  DEFAULT_POINT_STYLE,
  POINT_SCREEN_HALF_PX,
  baseMode,
  hasCircle,
  hasSquare,
  isPointVisible,
  markerHalfPx,
  normalizeMode,
  pointMarker,
  pointModeLabel,
} from '../src/core/point-style.js';
import { documentToDxf } from '../src/io/dxf-write.js';
import { dxfToDocumentJson } from '../src/io/dxf.js';
import { documentToTc2Json, tc2JsonToDocument, type Tc2DocDto } from '../src/io/tc2.js';

const at = vec(100, 50);

describe('モードの読み解き', () => {
  it('下位 5 ビットが基本の形', () => {
    expect(baseMode(0)).toBe(0);
    expect(baseMode(3)).toBe(3);
    expect(baseMode(35)).toBe(3); // 32 + 3
    expect(baseMode(98)).toBe(2); // 64 + 32 + 2
  });

  it('32 で外接円、64 で外接四角', () => {
    expect(hasCircle(32)).toBe(true);
    expect(hasSquare(64)).toBe(true);
    expect(hasCircle(96)).toBe(true);
    expect(hasSquare(96)).toBe(true);
    expect(hasCircle(3)).toBe(false);
    expect(hasSquare(3)).toBe(false);
  });

  it('モード 1 は描かない', () => {
    expect(isPointVisible(1)).toBe(false);
    expect(isPointVisible(0)).toBe(true);
  });

  it('モード 1 でも外接円・四角が付いていれば描く', () => {
    expect(isPointVisible(33)).toBe(true);
    expect(isPointVisible(65)).toBe(true);
  });

  it('壊れた値は 0 に落とす（描けなくならない）', () => {
    expect(normalizeMode(-5)).toBe(0);
    expect(normalizeMode(Number.NaN)).toBe(0);
    expect(normalizeMode(2.7)).toBe(2);
  });

  it('名前が引ける', () => {
    expect(pointModeLabel(2)).toBe('＋');
    expect(pointModeLabel(35)).toBe('×と円');
    expect(pointModeLabel(999)).toBe('モード 999');
  });
});

describe('マーカーの大きさ', () => {
  it('サイズ 0 は画面固定（ズームに追従しない）', () => {
    expect(markerHalfPx({ mode: 2, size: 0 }, 0.05)).toBe(POINT_SCREEN_HALF_PX);
    expect(markerHalfPx({ mode: 2, size: 0 }, 8)).toBe(POINT_SCREEN_HALF_PX);
  });

  it('サイズが正ならズームに追従する（ワールド寸法）', () => {
    // 直径 400mm → 半サイズ 200mm。倍率 0.5 で 100px
    expect(markerHalfPx({ mode: 2, size: 400 }, 0.5)).toBe(100);
    expect(markerHalfPx({ mode: 2, size: 400 }, 0.25)).toBe(50);
  });

  it('縮小しすぎても消えない（下限 0.5px）', () => {
    expect(markerHalfPx({ mode: 2, size: 1 }, 1e-6)).toBe(0.5);
  });

  it('サイズが壊れていたら画面固定にする', () => {
    expect(markerHalfPx({ mode: 2, size: Number.NaN }, 1)).toBe(POINT_SCREEN_HALF_PX);
  });
});

describe('マーカーの組み立て', () => {
  it('0 は塗り丸だけ（線は無い）', () => {
    const m = pointMarker({ mode: 0, size: 0 }, at, 1);
    expect(m.lines).toHaveLength(0);
    expect(m.dotRadius).toBeGreaterThan(0);
    expect(m.circle).toBe(false);
    expect(m.square).toBe(false);
  });

  it('2（＋）は水平と垂直の 2 本', () => {
    const m = pointMarker({ mode: 2, size: 0 }, at, 1);
    expect(m.lines).toHaveLength(2);
    const h = m.lines[0]!;
    expect(h[0]).toEqual(vec(at.x - 3, at.y));
    expect(h[1]).toEqual(vec(at.x + 3, at.y));
    const v = m.lines[1]!;
    expect(v[0]).toEqual(vec(at.x, at.y - 3));
    expect(v[1]).toEqual(vec(at.x, at.y + 3));
    expect(m.dotRadius).toBe(0);
  });

  it('3（×）は斜め 2 本', () => {
    const m = pointMarker({ mode: 3, size: 0 }, at, 1);
    expect(m.lines).toHaveLength(2);
    expect(m.lines[0]![0]).toEqual(vec(at.x - 3, at.y - 3));
    expect(m.lines[0]![1]).toEqual(vec(at.x + 3, at.y + 3));
  });

  it('4（｜）は上向きの短線 1 本（画面は Y 下向きなので -y へ）', () => {
    const m = pointMarker({ mode: 4, size: 0 }, at, 1);
    expect(m.lines).toHaveLength(1);
    expect(m.lines[0]![0]).toEqual(at);
    expect(m.lines[0]![1]).toEqual(vec(at.x, at.y - 3));
  });

  it('1（描かない）は線も丸も無い', () => {
    const m = pointMarker({ mode: 1, size: 0 }, at, 1);
    expect(m.lines).toHaveLength(0);
    expect(m.dotRadius).toBe(0);
  });

  it('32 を足すと外接円が付く（形はそのまま）', () => {
    const m = pointMarker({ mode: 34, size: 0 }, at, 1);
    expect(m.lines).toHaveLength(2); // ＋ のまま
    expect(m.circle).toBe(true);
    expect(m.square).toBe(false);
  });

  it('64 を足すと外接四角が付く', () => {
    const m = pointMarker({ mode: 67, size: 0 }, at, 1);
    expect(m.lines).toHaveLength(2); // × のまま
    expect(m.square).toBe(true);
  });

  it('96 は円と四角の両方', () => {
    const m = pointMarker({ mode: 96, size: 0 }, at, 1);
    expect(m.circle).toBe(true);
    expect(m.square).toBe(true);
  });

  it('ワールドサイズならマーカーもズームで伸びる', () => {
    const small = pointMarker({ mode: 2, size: 400 }, at, 0.1);
    const large = pointMarker({ mode: 2, size: 400 }, at, 0.4);
    expect(large.half).toBe(small.half * 4);
  });
});

describe('保存と往復', () => {
  const docJson = (mode: number, size: number): DocumentJson => ({
    format: 'tr-cad2w',
    version: FILE_FORMAT_VERSION,
    lineTypeScale: 500,
    layers: [...STANDARD_LAYERS],
    entities: [{ ...DEFAULT_ATTRS, id: 1, kind: 'point', at: vec(0, 0) }],
    pointStyle: { mode, size },
  });

  it('.tc2w（JSON）で往復する', () => {
    const doc = new CadDocument();
    doc.clear();
    doc.pointStyle = { mode: 35, size: 250 };
    const back = new CadDocument();
    back.loadJson(JSON.parse(JSON.stringify(doc.toJson())) as DocumentJson);
    expect(back.pointStyle).toEqual({ mode: 35, size: 250 });
  });

  it('新規図面で既定へ戻る（前の図面の設定を持ち越さない）', () => {
    const doc = new CadDocument();
    doc.pointStyle = { mode: 96, size: 500 };
    doc.clear();
    expect(doc.pointStyle).toEqual(DEFAULT_POINT_STYLE);
  });

  it('点スタイルが無い古いファイルも読める（既定になる）', () => {
    const doc = new CadDocument();
    const json = docJson(2, 0);
    delete json.pointStyle;
    doc.loadJson(json);
    expect(doc.pointStyle).toEqual(DEFAULT_POINT_STYLE);
  });

  it('壊れた値は既定へ落とす', () => {
    const doc = new CadDocument();
    doc.loadJson({ ...docJson(-3, -5) });
    expect(doc.pointStyle.mode).toBe(0);
    expect(doc.pointStyle.size).toBe(DEFAULT_POINT_STYLE.size);
  });

  it('.tc2 は PointMode / PointSize で往復する（デスクトップ版の名前）', () => {
    const dto = documentToTc2Json(docJson(35, 250));
    expect(dto.PointMode).toBe(35);
    expect(dto.PointSize).toBe(250);
    const back = tc2JsonToDocument(dto as Tc2DocDto).json;
    expect(back.pointStyle).toEqual({ mode: 35, size: 250 });
  });

  it('.tc2 に点スタイルが無ければ既定で読む', () => {
    const dto: Tc2DocDto = {
      Layers: [{ Name: '0', Color: 0xffffffff, Visible: true }],
      CurrentLayer: '0',
      Entities: [],
    };
    expect(tc2JsonToDocument(dto).json.pointStyle).toEqual(DEFAULT_POINT_STYLE);
  });

  it('DXF は $PDMODE / $PDSIZE で往復する', () => {
    const dxf = documentToDxf(docJson(35, 250));
    expect(dxf).toContain('$PDMODE');
    expect(dxf).toContain('$PDSIZE');
    const back = dxfToDocumentJson(dxf).json;
    expect(back.pointStyle).toEqual({ mode: 35, size: 250 });
  });

  it('DXF の $PDSIZE が負なら画面固定（0）にする', () => {
    // 正の値で書いたものを負に差し替える。0 で書くと「置換が効かなくても通る」テストになる
    const src = documentToDxf(docJson(2, 250));
    const dxf = src.replace(/(\$PDSIZE\n40\n)[^\n]+/, '$1-1.5');
    expect(dxf).not.toBe(src);
    expect(dxfToDocumentJson(dxf).json.pointStyle?.size).toBe(0);
  });

  it('$PDMODE が無い DXF も読める', () => {
    const dxf = documentToDxf(docJson(2, 0)).replace('$PDMODE', '$XXUNUSED');
    expect(dxfToDocumentJson(dxf).json.pointStyle?.mode).toBe(DEFAULT_POINT_STYLE.mode);
  });
});
