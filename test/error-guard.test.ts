import { describe, expect, it } from 'vitest';
import { ErrorGuard, messageOf } from '../src/ui/error-guard.js';

/** 同じ場所から投げるためのヘルパ（スタックの先頭行が揃う）。 */
function throwHere(message: string): unknown {
  try {
    throw new Error(message);
  } catch (e) {
    return e;
  }
}

describe('messageOf', () => {
  it('Error はメッセージを返す', () => {
    expect(messageOf(new Error('落ちました'))).toBe('落ちました');
  });

  it('メッセージが空の Error は名前を返す', () => {
    expect(messageOf(new TypeError(''))).toBe('TypeError');
  });

  it('文字列 throw をそのまま返す', () => {
    expect(messageOf('文字列を投げた')).toBe('文字列を投げた');
  });

  it('undefined / null も 1 行にする', () => {
    expect(messageOf(undefined)).toBe('undefined を投げました');
    expect(messageOf(null)).toBe('null を投げました');
  });

  it('toString が壊れた値でも落ちない', () => {
    const broken = {
      toString() {
        throw new Error('toString が壊れている');
      },
    };
    expect(messageOf(broken)).toBe('文字列にできない値を投げました');
  });
});

describe('ErrorGuard', () => {
  it('初出だけ報告し、2 回目以降は黙る', () => {
    const g = new ErrorGuard();
    const err = throwHere('同じ例外');
    expect(g.report(err)).not.toBeNull();
    expect(g.report(err)).toBeNull();
    expect(g.report(err)).toBeNull();
  });

  it('黙っている間も件数は数え続ける', () => {
    const g = new ErrorGuard();
    const err = throwHere('数える');
    g.report(err);
    g.report(err);
    g.report(err);
    expect(g.countOf(err)).toBe(3);
    expect(g.total).toBe(3);
    expect(g.kinds).toBe(1);
  });

  it('メッセージが違えばそれぞれ報告する', () => {
    const g = new ErrorGuard();
    expect(g.report(throwHere('A'))).not.toBeNull();
    expect(g.report(throwHere('B'))).not.toBeNull();
    expect(g.kinds).toBe(2);
  });

  it('同じメッセージでも投げた場所が違えば別物として報告する', () => {
    const g = new ErrorGuard();
    const a = new Error('同じ文言');
    a.stack = 'Error: 同じ文言\n    at drawHatch (renderer.ts:1:1)';
    const b = new Error('同じ文言');
    b.stack = 'Error: 同じ文言\n    at drawDim (renderer.ts:2:2)';
    expect(g.report(a)).not.toBeNull();
    expect(g.report(b)).not.toBeNull();
    expect(g.kinds).toBe(2);
  });

  it('報告の message はステータスバーに出す 1 行', () => {
    const g = new ErrorGuard();
    const first = g.report(new Error('画層が見つかりません'));
    expect(first?.message).toBe('画層が見つかりません');
    expect(first?.count).toBe(1);
  });

  it('Error 以外を投げられても受けられる', () => {
    const g = new ErrorGuard();
    expect(g.report('文字列')).not.toBeNull();
    expect(g.report('文字列')).toBeNull();
    expect(g.report(undefined)).not.toBeNull();
    expect(g.total).toBe(3);
  });

  it('reset でまた報告するようになる', () => {
    const g = new ErrorGuard();
    const err = throwHere('戻す');
    g.report(err);
    expect(g.report(err)).toBeNull();
    g.reset();
    expect(g.report(err)).not.toBeNull();
    expect(g.total).toBe(1);
  });

  it('種類が増え続けても覚える数に上限がある', () => {
    const g = new ErrorGuard();
    for (let i = 0; i < 200; i++) g.report(new Error(`種類 ${i}`));
    expect(g.kinds).toBeLessThanOrEqual(64);
    expect(g.total).toBe(200);
  });

  it('上限を超えて忘れた種類は、また来たときに報告する', () => {
    const g = new ErrorGuard();
    const first = new Error('いちばん古い');
    g.report(first);
    for (let i = 0; i < 100; i++) g.report(new Error(`後から来た ${i}`));
    expect(g.report(first)).not.toBeNull();
  });
});
