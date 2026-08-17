import { describe, expect, it } from 'vitest';
import { DEFAULT_ATTRS, type Entity } from '../src/core/entity.js';
import { vec } from '../src/core/geometry.js';
import {
  LayerTable,
  VB_BLACK,
  effectiveColor,
  effectiveLineStyle,
  isLightBackground,
  layerOfPointName,
  parseColor,
} from '../src/core/layer.js';

function ent(over: Partial<Entity> = {}): Entity {
  return { ...DEFAULT_ATTRS, id: 1, kind: 'point', at: vec(0, 0), ...over } as Entity;
}

describe('effectiveColor', () => {
  const layers = new LayerTable();

  it('黒画層（内部は白）は明背景で黒く描かれる', () => {
    const e = ent({ layer: '0' });
    expect(layers.get('0')?.color).toBe(VB_BLACK);
    expect(effectiveColor(e, { layers, background: '#ffffff', darkBoost: 0 })).toBe('#000000');
  });

  it('暗背景では白のまま', () => {
    const e = ent({ layer: '0' });
    expect(effectiveColor(e, { layers, background: '#1e1e1e', darkBoost: 0 })).toBe(VB_BLACK);
  });

  it('有彩色は明背景ではそのまま', () => {
    const e = ent({ layer: '境界' });
    expect(effectiveColor(e, { layers, background: '#ffffff', darkBoost: 0.6 })).toBe('#0000ff');
  });

  it('暗背景では有彩色を darkBoost の分だけ持ち上げる', () => {
    const e = ent({ layer: '境界' });
    // 青 (0,0,255) を 0.5 持ち上げ → (128,128,255)
    expect(effectiveColor(e, { layers, background: '#000000', darkBoost: 0.5 })).toBe('#8080ff');
  });

  it('図形の個別色は画層色より優先される', () => {
    const e = ent({ layer: '境界', color: '#00ff00' });
    expect(effectiveColor(e, { layers, background: '#ffffff', darkBoost: 0 })).toBe('#00ff00');
  });

  /**
   * issue #55。`.tc2` のペイントは真っ黒（`#000000`）を図形の色として持っている。
   * 明背景で反転すると白になって消えるので、**衝突しない側は入れ替えない**。
   */
  it('明背景では黒はそのまま黒（.tc2 のペイントが消えない）', () => {
    const e = ent({ layer: 'ペイント', color: '#000000' });
    expect(effectiveColor(e, { layers, background: '#ffffff', darkBoost: 0 })).toBe('#000000');
  });

  it('暗背景では黒を白にする', () => {
    const e = ent({ layer: 'ペイント', color: '#000000' });
    expect(effectiveColor(e, { layers, background: '#1e1e1e', darkBoost: 0 })).toBe(VB_BLACK);
  });

  it('デスクトップ版の既定色 #e6e6e6 は明背景で黒になる', () => {
    const e = ent({ layer: '0', color: '#e6e6e6' });
    expect(effectiveColor(e, { layers, background: '#ffffff', darkBoost: 0 })).toBe('#000000');
  });

  /** 中間グレーは色 7 ではない（デスクトップ版 `IsMono` と同じ扱い）。 */
  it('中間グレーは図面の色として尊重する', () => {
    const e = ent({ layer: '0', color: '#808080' });
    expect(effectiveColor(e, { layers, background: '#ffffff', darkBoost: 0 })).toBe('#808080');
    expect(effectiveColor(e, { layers, background: '#1e1e1e', darkBoost: 0 })).toBe('#808080');
  });

  /** 境界値もデスクトップ版に合わせる（`max - min > 16` は有彩色、`min <= 0x20` はほぼ黒）。 */
  it('無彩色の許容幅を超えたら有彩色として扱う', () => {
    // #e6e6d0 は max-min=22 で有彩色 → 明背景でも黒くしない
    expect(
      effectiveColor(ent({ layer: '0', color: '#e6e6d0' }), {
        layers,
        background: '#ffffff',
        darkBoost: 0,
      }),
    ).toBe('#e6e6d0');
    // #0a0a12 は max-min=8 でほぼ黒 → 明背景ではそのまま／暗背景では白
    const dark = ent({ layer: '0', color: '#0a0a12' });
    expect(effectiveColor(dark, { layers, background: '#ffffff', darkBoost: 0 })).toBe('#0a0a12');
    expect(effectiveColor(dark, { layers, background: '#1e1e1e', darkBoost: 0 })).toBe(VB_BLACK);
  });
});

describe('effectiveLineStyle', () => {
  const layers = new LayerTable();

  it('実線指定なら画層の線種に従う', () => {
    expect(effectiveLineStyle(ent({ layer: '境界' }), layers)).toBe('dashdot');
  });

  it('図形に線種があればそれを使う', () => {
    expect(effectiveLineStyle(ent({ layer: '境界', lineStyle: 'dotted' }), layers)).toBe('dotted');
  });
});

describe('点番レター → 画層', () => {
  it('デスクトップ版と同じ対応', () => {
    expect(layerOfPointName('K1')).toBe('境界');
    expect(layerOfPointName('h12')).toBe('家屋');
    expect(layerOfPointName('D3')).toBe('電柱');
  });

  it('対応の無いレターは画層 0', () => {
    expect(layerOfPointName('T1')).toBe('0');
    expect(layerOfPointName('')).toBe('0');
  });
});

describe('LayerTable', () => {
  it('画層 0 は消せない', () => {
    const t = new LayerTable();
    expect(t.remove('0')).toBe(false);
    expect(t.remove('境界')).toBe(true);
  });

  it('ensure は無ければ作る', () => {
    const t = new LayerTable();
    expect(t.get('未知')).toBeUndefined();
    expect(t.ensure('未知').color).toBe(VB_BLACK);
    expect(t.get('未知')).toBeDefined();
  });
});

describe('色の解析', () => {
  it('#rgb と #rrggbb', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor('#0a58ca')).toEqual({ r: 10, g: 88, b: 202 });
    expect(parseColor('rebeccapurple')).toBeNull();
  });

  it('背景の明暗判定', () => {
    expect(isLightBackground('#ffffff')).toBe(true);
    expect(isLightBackground('#1e1e1e')).toBe(false);
  });
});
