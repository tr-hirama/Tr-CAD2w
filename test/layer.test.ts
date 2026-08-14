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
