import { describe, expect, it } from 'vitest';
import { vec } from '../src/core/geometry.js';
import {
  DEFAULT_ATTRS,
  DEFAULT_DIM_STYLE,
  type DimEntity,
  cloneEntity,
  entityBounds,
  entityLength,
  hitTest,
  rotateEntity,
  scaleEntity,
  snapPoints,
  translateEntity,
} from '../src/core/entity.js';
import { dimExplode, dimGeometry, resolveDimText } from '../src/core/dim-geom.js';
import { documentToTc2Json, tc2JsonToDocument, type Tc2DocDto } from '../src/io/tc2.js';
import { documentToDxf } from '../src/io/dxf-write.js';
import { FILE_FORMAT_VERSION, type DocumentJson } from '../src/core/document.js';
import { STANDARD_LAYERS } from '../src/core/layer.js';

/** 水平に 8 だけ離れた 2 点を、上へ 4 離した位置で測る直線寸法。 */
function linearDim(over: Partial<DimEntity> = {}): DimEntity {
  return {
    ...DEFAULT_ATTRS,
    ...DEFAULT_DIM_STYLE,
    id: 1,
    kind: 'dim',
    dimType: 'linear',
    points: [vec(0, 0), vec(8, 0), vec(4, 4)],
    // 自動値だと計測長に依存するので、テストでは固定する
    height: 1,
    arrow: 1,
    ...over,
  };
}

describe('直線寸法の幾何', () => {
  it('計測値は 2 点間の距離', () => {
    const g = dimGeometry(linearDim());
    expect(g?.text).toBe('8.00');
  });

  it('寸法線は 3 点目の「垂直距離」まで動く（水平位置は効かない）', () => {
    const a = dimGeometry(linearDim())!;
    const b = dimGeometry(linearDim({ points: [vec(0, 0), vec(8, 0), vec(100, 4)] }))!;
    // 寸法線本体は lines[2]
    expect(a.lines[2]).toEqual(b.lines[2]);
    expect(a.lines[2]![0]).toEqual(vec(0, 4));
    expect(a.lines[2]![1]).toEqual(vec(8, 4));
  });

  it('矢印は寸法線の両端に、内向きに付く', () => {
    const g = dimGeometry(linearDim())!;
    expect(g.arrows).toHaveLength(2);
    // 先端は寸法線の端点そのもの
    expect(g.arrows[0]![0]).toEqual(vec(0, 4));
    expect(g.arrows[1]![0]).toEqual(vec(8, 4));
    // 左の矢印は右向き（+x）、右の矢印は左向き（-x）に開く
    expect(g.arrows[0]![1]!.x).toBeCloseTo(1, 12);
    expect(g.arrows[1]![1]!.x).toBeCloseTo(7, 12);
    // 幅は矢印長の半分（±0.25）
    expect(g.arrows[0]![1]!.y).toBeCloseTo(4.25, 12);
    expect(g.arrows[0]![2]!.y).toBeCloseTo(3.75, 12);
  });

  it('引出線は計測点から少し離れて始まり、寸法線を少し越える', () => {
    const g = dimGeometry(linearDim())!;
    // 文字高 1 なので gap=0.5 / ext=0.6
    expect(g.lines[0]![0]).toEqual(vec(0, 0.5));
    expect(g.lines[0]![1]).toEqual(vec(0, 4.6));
  });

  it('3 点目が下側なら寸法線も引出線も下へ出る', () => {
    const g = dimGeometry(linearDim({ points: [vec(0, 0), vec(8, 0), vec(4, -4)] }))!;
    expect(g.lines[2]![0]).toEqual(vec(0, -4));
    expect(g.lines[0]![0]).toEqual(vec(0, -0.5));
    expect(g.text).toBe('8.00');
  });

  it('計測点が重なっていると幾何を作れない', () => {
    expect(dimGeometry(linearDim({ points: [vec(3, 3), vec(3, 3), vec(3, 5)] }))).toBeNull();
  });

  it('点が足りないと幾何を作れない', () => {
    expect(dimGeometry(linearDim({ points: [vec(0, 0), vec(8, 0)] }))).toBeNull();
  });

  it('文字は上下逆さにならない（右→左でも読める向き）', () => {
    const g = dimGeometry(linearDim({ points: [vec(8, 0), vec(0, 0), vec(4, 4)] }))!;
    expect(g.textAngle).toBe(0);
  });

  it('斜めでも文字の傾きは (-90°, 90°] に収まる', () => {
    for (const [x, y] of [
      [1, 1],
      [-1, 1],
      [-1, -1],
      [1, -1],
      [0, 1],
      [0, -1],
    ] as const) {
      const g = dimGeometry(linearDim({ points: [vec(0, 0), vec(x * 8, y * 8), vec(0, 4)] }))!;
      expect(g.textAngle).toBeGreaterThan(-Math.PI / 2);
      expect(g.textAngle).toBeLessThanOrEqual(Math.PI / 2);
    }
  });
});

describe('寸法値の書式', () => {
  it('小数桁で丸める', () => {
    expect(dimGeometry(linearDim({ decimals: 0 }))?.text).toBe('8');
    expect(dimGeometry(linearDim({ decimals: 3 }))?.text).toBe('8.000');
  });

  it('計測倍率を掛ける（実寸→表記）', () => {
    expect(dimGeometry(linearDim({ measureScale: 0.001, decimals: 3 }))?.text).toBe('0.008');
  });

  it('倍率 0 は 1 とみなす（既定値の取り違えで 0 表示にしない）', () => {
    expect(dimGeometry(linearDim({ measureScale: 0 }))?.text).toBe('8.00');
  });

  it('接尾（単位）を付ける', () => {
    expect(dimGeometry(linearDim({ suffix: 'm' }))?.text).toBe('8.00m');
  });

  it('手動上書きはそのまま出る', () => {
    expect(dimGeometry(linearDim({ text: '実測' }))?.text).toBe('実測');
  });

  it('<> は計測値に置き換わる', () => {
    expect(dimGeometry(linearDim({ text: '約<>cm' }))?.text).toBe('約8.00cm');
  });

  it('<> が複数あればすべて置き換わる', () => {
    expect(dimGeometry(linearDim({ text: '<>+<>' }))?.text).toBe('8.00+8.00');
  });

  it('上書きがあると接尾は付かない（<> で好きな位置に書く）', () => {
    expect(dimGeometry(linearDim({ text: '<>', suffix: 'm' }))?.text).toBe('8.00');
  });

  it('resolveDimText は接頭も付けられる', () => {
    expect(resolveDimText(linearDim(), 4, 'R', '')).toBe('R4.00');
  });
});

describe('半径・直径寸法', () => {
  const radial = (over: Partial<DimEntity> = {}): DimEntity =>
    linearDim({ dimType: 'radius', points: [vec(0, 0), vec(4, 0)], ...over });

  it('半径は R を付け、中心から円周へ 1 本引く', () => {
    const g = dimGeometry(radial())!;
    expect(g.text).toBe('R4.00');
    expect(g.lines).toHaveLength(1);
    expect(g.lines[0]).toEqual([vec(0, 0), vec(4, 0)]);
    expect(g.arrows).toHaveLength(1);
    expect(g.arrows[0]![0]).toEqual(vec(4, 0));
  });

  it('直径は Ø を付け、円を横切って両端に矢印を付ける', () => {
    const g = dimGeometry(radial({ dimType: 'diameter' }))!;
    expect(g.text).toBe('Ø8.00');
    expect(g.lines[0]).toEqual([vec(-4, 0), vec(4, 0)]);
    expect(g.arrows).toHaveLength(2);
  });

  it('中心と円周上の点が同じだと作れない', () => {
    expect(dimGeometry(radial({ points: [vec(1, 1), vec(1, 1)] }))).toBeNull();
  });
});

describe('角度寸法', () => {
  const angular = (over: Partial<DimEntity> = {}): DimEntity =>
    linearDim({ dimType: 'angular', points: [vec(0, 0), vec(4, 0), vec(0, 4)], ...over });

  it('直角は 90.00°', () => {
    expect(dimGeometry(angular())?.text).toBe('90.00°');
  });

  it('向きが逆でも同じ角（絶対値で測る）', () => {
    expect(dimGeometry(angular({ points: [vec(0, 0), vec(0, 4), vec(4, 0)] }))?.text).toBe('90.00°');
  });

  it('4 点目が反対側にあれば優角（270°）を測る', () => {
    // 最短回りの中央は右上（45°）なので、その反対側（左下）を通す
    const g = dimGeometry(angular({ points: [vec(0, 0), vec(4, 0), vec(0, 4), vec(-4, -4)] }))!;
    expect(g.text).toBe('270.00°');
  });

  it('4 点目が最短回り側なら劣角（90°）のまま', () => {
    const g = dimGeometry(angular({ points: [vec(0, 0), vec(4, 0), vec(0, 4), vec(4, 4)] }))!;
    expect(g.text).toBe('90.00°');
  });

  it('角度の文字は水平（読み違えない）', () => {
    expect(dimGeometry(angular())?.textAngle).toBe(0);
  });
});

describe('自動値', () => {
  it('文字高 0 は計測長の 5%', () => {
    const g = dimGeometry(linearDim({ height: 0, arrow: 0 }))!;
    expect(g.textHeight).toBeCloseTo(0.4, 12);
  });

  it('矢印 0 は文字高の 1.2 倍', () => {
    const g = dimGeometry(linearDim({ height: 2, arrow: 0 }))!;
    // 先端 (0,4) から内向きに 2.4 伸びる
    expect(g.arrows[0]![1]!.x).toBeCloseTo(2.4, 12);
  });
});

describe('図形としての振る舞い', () => {
  it('外接矩形は引出線と文字まで含む', () => {
    const b = entityBounds(linearDim());
    expect(b.minX).toBeLessThanOrEqual(0);
    expect(b.maxX).toBeGreaterThanOrEqual(8);
    expect(b.minY).toBeLessThanOrEqual(0);
    // 寸法線 4 ＋ 引出線の出っ張り 0.6 ＋ 文字
    expect(b.maxY).toBeGreaterThan(4.6);
  });

  it('寸法線の上をクリックすると当たる', () => {
    expect(hitTest(linearDim(), vec(4, 4), 0.1)).toBe(true);
  });

  it('離れた場所では当たらない', () => {
    expect(hitTest(linearDim(), vec(4, -3), 0.1)).toBe(false);
  });

  it('平行移動は計測点をそのまま動かす', () => {
    const moved = translateEntity(linearDim(), vec(10, 5)) as DimEntity;
    expect(moved.points[0]).toEqual(vec(10, 5));
    expect(moved.points[1]).toEqual(vec(18, 5));
    expect(dimGeometry(moved)?.text).toBe('8.00');
  });

  it('回転しても計測値は変わらない', () => {
    const r = rotateEntity(linearDim(), vec(0, 0), Math.PI / 4) as DimEntity;
    expect(dimGeometry(r)?.text).toBe('8.00');
  });

  it('拡縮は計測値も文字高も倍になる', () => {
    const s = scaleEntity(linearDim(), vec(0, 0), 2) as DimEntity;
    expect(dimGeometry(s)?.text).toBe('16.00');
    expect(s.height).toBe(2);
    expect(s.arrow).toBe(2);
  });

  it('自動の文字高（0）は拡縮しても自動のまま', () => {
    const s = scaleEntity(linearDim({ height: 0, arrow: 0 }), vec(0, 0), 2) as DimEntity;
    expect(s.height).toBe(0);
    expect(s.arrow).toBe(0);
  });

  it('吸着点は計測点', () => {
    const pts = snapPoints(linearDim());
    expect(pts).toHaveLength(3);
    expect(pts.map((p) => p.at)).toEqual([vec(0, 0), vec(8, 0), vec(4, 4)]);
  });

  it('長さは数えない（引出線の合計を長さと呼ばない）', () => {
    expect(entityLength(linearDim())).toBe(0);
  });

  it('複製は計測点の配列を共有しない（Undo とコピペで値が消えない）', () => {
    const src = linearDim();
    const copy = cloneEntity(src) as DimEntity;
    expect(copy.points).toEqual(src.points);
    expect(copy.points).not.toBe(src.points);
  });
});

describe('分解（DXF 出力用）', () => {
  it('線分・矢印・文字に分かれる', () => {
    const parts = dimExplode(linearDim());
    const kinds = parts.map((p) => p.kind);
    expect(kinds.filter((k) => k === 'line')).toHaveLength(3);
    expect(kinds.filter((k) => k === 'polyline')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'text')).toHaveLength(1);
  });

  it('矢印は閉じた三角形として出る', () => {
    const tri = dimExplode(linearDim()).find((p) => p.kind === 'polyline');
    expect(tri).toBeDefined();
    if (tri?.kind !== 'polyline') throw new Error('矢印が連続線ではありません');
    expect(tri.points).toHaveLength(3);
    expect(tri.closed).toBe(true);
  });

  it('画層・色・線幅は寸法から受け継ぐ', () => {
    const parts = dimExplode(linearDim({ layer: '境界', color: '#ff0000', lineWidth: 0.5 }));
    for (const p of parts) {
      expect(p.layer).toBe('境界');
      expect(p.color).toBe('#ff0000');
      expect(p.lineWidth).toBe(0.5);
    }
  });

  it('分解した文字は寸法値そのもの', () => {
    const t = dimExplode(linearDim({ text: '約<>cm' })).find((p) => p.kind === 'text');
    if (t?.kind !== 'text') throw new Error('文字が出ていません');
    expect(t.text).toBe('約8.00cm');
    expect(t.hAlign).toBe('center');
  });

  it('幾何を作れない寸法は何も出さない', () => {
    expect(dimExplode(linearDim({ points: [vec(0, 0)] }))).toEqual([]);
  });
});

describe('DXF 書出', () => {
  const docJson = (e: DimEntity): DocumentJson => ({
    format: 'tr-cad2w',
    version: FILE_FORMAT_VERSION,
    lineTypeScale: 500,
    layers: [...STANDARD_LAYERS],
    entities: [e],
  });

  it('DIMENSION ではなく線分・文字として出る（寸法スタイル依存を避ける）', () => {
    const dxf = documentToDxf(docJson(linearDim()));
    expect(dxf).not.toContain('\nDIMENSION\n');
    expect(dxf).toContain('\nLINE\n');
    expect(dxf).toContain('\nLWPOLYLINE\n');
    expect(dxf).toContain('8.00');
  });

  it('線分は 3 本出る（引出線 2＋寸法線 1）', () => {
    const dxf = documentToDxf(docJson(linearDim()));
    expect(dxf.split('\nLINE\n')).toHaveLength(4);
  });
});

describe('.tc2 との往復', () => {
  const roundTrip = (e: DimEntity): DimEntity => {
    const json: DocumentJson = {
      format: 'tr-cad2w',
      version: FILE_FORMAT_VERSION,
      lineTypeScale: 500,
      layers: [...STANDARD_LAYERS],
      entities: [e],
    };
    const back = tc2JsonToDocument(documentToTc2Json(json) as Tc2DocDto).json;
    const first = back.entities[0];
    if (first?.kind !== 'dim') throw new Error('寸法として戻ってきていません');
    return first;
  };

  it('スタイルがそのまま往復する', () => {
    const src = linearDim({ decimals: 3, measureScale: 0.001, suffix: 'm', text: '約<>', height: 2, arrow: 1.5 });
    const back = roundTrip(src);
    expect(back.dimType).toBe('linear');
    expect(back.decimals).toBe(3);
    expect(back.measureScale).toBe(0.001);
    expect(back.suffix).toBe('m');
    expect(back.text).toBe('約<>');
    expect(back.height).toBe(2);
    expect(back.arrow).toBe(1.5);
    expect(back.points).toEqual(src.points);
  });

  it('4 種すべての寸法が種類を保って往復する', () => {
    expect(roundTrip(linearDim()).dimType).toBe('linear');
    expect(roundTrip(linearDim({ dimType: 'radius', points: [vec(0, 0), vec(4, 0)] })).dimType).toBe('radius');
    expect(roundTrip(linearDim({ dimType: 'diameter', points: [vec(0, 0), vec(4, 0)] })).dimType).toBe('diameter');
    expect(roundTrip(linearDim({ dimType: 'angular' })).dimType).toBe('angular');
  });

  it('デスクトップ版が書く形（DimType 省略）は直線寸法として読む', () => {
    const dto: Tc2DocDto = {
      Layers: [{ Name: '0', Color: 0xffffffff, Visible: true }],
      CurrentLayer: '0',
      Entities: [{ Kind: 'Dimension', Pts: [0, 0, 8, 0, 4, 4], Color: 0xffffffff, Height: 1 }],
    };
    const e = tc2JsonToDocument(dto).json.entities[0];
    if (e?.kind !== 'dim') throw new Error('寸法として読めていません');
    expect(e.dimType).toBe('linear');
    expect(e.decimals).toBe(2);
    expect(e.measureScale).toBe(1);
  });

  it('点が足りない寸法は読み飛ばして件数に数える', () => {
    const dto: Tc2DocDto = {
      Layers: [{ Name: '0', Color: 0xffffffff, Visible: true }],
      CurrentLayer: '0',
      Entities: [{ Kind: 'Dimension', Pts: [0, 0, 8, 0], Color: 0xffffffff }],
    };
    const r = tc2JsonToDocument(dto);
    expect(r.json.entities).toHaveLength(0);
    expect(r.skipped['Dimension']).toBe(1);
  });

  it('半径寸法は 2 点で読める', () => {
    const dto: Tc2DocDto = {
      Layers: [{ Name: '0', Color: 0xffffffff, Visible: true }],
      CurrentLayer: '0',
      Entities: [{ Kind: 'Dimension', Pts: [0, 0, 4, 0], Color: 0xffffffff, DimType: 'Radius' }],
    };
    const r = tc2JsonToDocument(dto);
    expect(r.json.entities).toHaveLength(1);
    expect(r.skipped['Dimension']).toBeUndefined();
  });
});
