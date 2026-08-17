import { describe, expect, it } from 'vitest';
// 実物の HTML を文字列で取り込む（`?raw` は vite の機能。追加の依存は要らない）
import indexHtml from '../index.html?raw';
import { conditionalKeys, isButtonUsable, type ToolbarContext } from '../src/ui/toolbar.js';

/** 何もない状態（新規図面・選択なし・モデル空間）。 */
const EMPTY: ToolbarContext = {
  tool: 'select',
  inLayout: false,
  canUndo: false,
  canRedo: false,
  hasSelection: false,
  hasSelectedDim: false,
  hasSelectedViewport: false,
  hasBlocks: false,
  hasLevel: false,
  hasCheckedComment: false,
};

function ctx(over: Partial<ToolbarContext> = {}): ToolbarContext {
  return { ...EMPTY, ...over };
}

/** `index.html` のボタンを `cmd:xxx` / `tool:xxx` の形で全部拾う。 */
function buttonKeys(): string[] {
  return [...indexHtml.matchAll(/data-(cmd|tool)="([^"]+)"/g)].map((m) => `${m[1]}:${m[2]}`);
}

describe('前提の無いボタンは常に出る', () => {
  it('ファイル操作と作図ツールは何もない状態でも出る', () => {
    for (const key of ['cmd:new', 'cmd:open', 'cmd:save', 'cmd:export-dxf', 'cmd:print', 'cmd:bg']) {
      expect(isButtonUsable(key, EMPTY)).toBe(true);
    }
    for (const key of ['tool:select', 'tool:line', 'tool:circle', 'tool:text', 'tool:move']) {
      expect(isButtonUsable(key, EMPTY)).toBe(true);
    }
  });

  it('知らないキーは出す（条件を書き忘れてもボタンが消えない）', () => {
    expect(isButtonUsable('cmd:未知のコマンド', EMPTY)).toBe(true);
  });
});

describe('押しても断られるボタンは出さない', () => {
  it('帳票Excel はレベルが入っているときだけ', () => {
    expect(isButtonUsable('cmd:export-report', EMPTY)).toBe(false);
    expect(isButtonUsable('cmd:export-report', ctx({ hasLevel: true }))).toBe(true);
  });

  it('注記文の編集は番号を選んでいるときだけ', () => {
    expect(isButtonUsable('cmd:comment-text', EMPTY)).toBe(false);
    expect(isButtonUsable('cmd:comment-text', ctx({ hasCheckedComment: true }))).toBe(true);
  });

  it('寸法値は寸法を選んでいるときだけ（図形を選んだだけでは出ない）', () => {
    expect(isButtonUsable('cmd:dim-text', EMPTY)).toBe(false);
    expect(isButtonUsable('cmd:dim-text', ctx({ hasSelection: true }))).toBe(false);
    expect(isButtonUsable('cmd:dim-text', ctx({ hasSelection: true, hasSelectedDim: true }))).toBe(true);
  });

  it('窓の縮尺・窓に合わせるはビューポートを選んでいるときだけ', () => {
    const picked = ctx({ inLayout: true, hasSelection: true, hasSelectedViewport: true });
    for (const key of ['cmd:vp-scale', 'cmd:vp-fit']) {
      expect(isButtonUsable(key, ctx({ inLayout: true }))).toBe(false);
      expect(isButtonUsable(key, picked)).toBe(true);
    }
  });

  it('ビューポートとレイアウト削除は用紙空間だけ（モデル空間では出ない）', () => {
    for (const key of ['tool:viewport', 'cmd:layout-remove']) {
      expect(isButtonUsable(key, EMPTY)).toBe(false);
      expect(isButtonUsable(key, ctx({ inLayout: true }))).toBe(true);
    }
  });

  it('ブロック挿入は読み込んだブロックがあるときだけ', () => {
    expect(isButtonUsable('tool:insert', EMPTY)).toBe(false);
    expect(isButtonUsable('tool:insert', ctx({ hasBlocks: true }))).toBe(true);
  });

  it('柄はハッチツールを選んでいるときだけ', () => {
    expect(isButtonUsable('cmd:hatch-pattern', EMPTY)).toBe(false);
    expect(isButtonUsable('cmd:hatch-pattern', ctx({ tool: 'hatch' }))).toBe(true);
  });

  it('元に戻す・やり直しは履歴があるときだけ（別々に効く）', () => {
    expect(isButtonUsable('cmd:undo', EMPTY)).toBe(false);
    expect(isButtonUsable('cmd:redo', EMPTY)).toBe(false);
    expect(isButtonUsable('cmd:undo', ctx({ canUndo: true }))).toBe(true);
    expect(isButtonUsable('cmd:redo', ctx({ canUndo: true }))).toBe(false);
    expect(isButtonUsable('cmd:redo', ctx({ canRedo: true }))).toBe(true);
  });

  it('削除は選択があるときだけ', () => {
    expect(isButtonUsable('cmd:delete', EMPTY)).toBe(false);
    expect(isButtonUsable('cmd:delete', ctx({ hasSelection: true }))).toBe(true);
  });
});

/**
 * 条件のキーが `index.html` の実物と食い違っていないか。
 * `data-cmd` の名前を変えたときに条件が黙って死ぬ（＝押せないボタンが出続ける）のを防ぐ。
 */
describe('条件のキーは index.html のボタンに実在する', () => {
  const present = new Set(buttonKeys());

  it('ボタンを 40 個以上拾えている（正規表現が壊れていない）', () => {
    expect(present.size).toBeGreaterThan(40);
  });

  it('条件付きのキーはすべて HTML にある', () => {
    const missing = conditionalKeys().filter((k) => !present.has(k));
    expect(missing).toEqual([]);
  });
});

/**
 * 新規図面を開いた直後に何が出ているか。**ここが「画面の最適化」の見た目**なので、
 * 隠れる数を固定して不意に増減したら気づけるようにする。
 */
describe('新規図面の直後', () => {
  it('12 個が隠れ、残りは出る', () => {
    const hidden = buttonKeys().filter((k) => !isButtonUsable(k, EMPTY));
    expect(hidden.sort()).toEqual(
      [
        'cmd:comment-text',
        'cmd:delete',
        'cmd:dim-text',
        'cmd:export-report',
        'cmd:hatch-pattern',
        'cmd:layout-remove',
        'cmd:redo',
        'cmd:undo',
        'cmd:vp-fit',
        'cmd:vp-scale',
        'tool:insert',
        'tool:viewport',
      ].sort(),
    );
  });
});
