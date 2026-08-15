/**
 * 描画ループで出た例外の受け皿。
 *
 * 描画は毎フレーム走るので、**同じ例外をそのまま報告すると 60fps でログが埋まり、
 * 本当の1件目が流れて見えなくなる**。ここで「初めて見たものだけ報告する」を担い、
 * 件数だけ数え続ける。
 *
 * 握りつぶすためのものではない。`CadApp.frame` は初出を必ずコンソールへ出す。
 */

export interface GuardReport {
  /** 利用者に見せる 1 行（ステータスバー用）。 */
  message: string;
  /** この種類の例外が出た通算回数（初出なら 1）。 */
  count: number;
}

/** 覚えておく例外の種類の上限。これを超えたら古いものから忘れる（際限なく溜めない）。 */
const MAX_KINDS = 64;

export class ErrorGuard {
  private readonly counts = new Map<string, number>();
  private totalCount = 0;

  /**
   * 例外を1件受ける。**初めて見る種類なら報告を返し、2 回目以降は `null`。**
   * 種類は「メッセージ＋スタックの先頭行」で見分ける（同じ場所の同じ失敗を1つと数える）。
   */
  report(err: unknown): GuardReport | null {
    this.totalCount++;
    const key = kindOf(err);
    const seen = this.counts.get(key) ?? 0;
    this.counts.set(key, seen + 1);
    if (this.counts.size > MAX_KINDS) {
      // Map は挿入順を保つので、いちばん古い種類を落とす
      const oldest = this.counts.keys().next();
      if (!oldest.done && oldest.value !== key) this.counts.delete(oldest.value);
    }
    if (seen > 0) return null;
    return { message: messageOf(err), count: 1 };
  }

  /** この種類の例外が出た通算回数（`report` が `null` を返した分も含む）。 */
  countOf(err: unknown): number {
    return this.counts.get(kindOf(err)) ?? 0;
  }

  /** 受けた例外の総数（種類を問わない）。 */
  get total(): number {
    return this.totalCount;
  }

  /** 覚えている種類の数。 */
  get kinds(): number {
    return this.counts.size;
  }

  /** 忘れる（新しい図面を開いたときなど、また報告してほしい場面で呼ぶ）。 */
  reset(): void {
    this.counts.clear();
    this.totalCount = 0;
  }
}

/** 利用者に見せる 1 行。`Error` 以外（文字列 throw など）も受ける。 */
export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message === '' ? err.name : err.message;
  if (typeof err === 'string') return err;
  if (err === undefined) return 'undefined を投げました';
  if (err === null) return 'null を投げました';
  try {
    return String(err);
  } catch {
    // toString が壊れているオブジェクトを投げられても、ここで落ちてはいけない
    return '文字列にできない値を投げました';
  }
}

/**
 * 例外の「種類」。メッセージが同じでも**投げた場所が違えば別物**として数える。
 * スタックの先頭行だけを使う（全体を使うと呼び出し元の違いで別物になり過ぎる）。
 */
function kindOf(err: unknown): string {
  const msg = messageOf(err);
  if (!(err instanceof Error) || typeof err.stack !== 'string') return msg;
  // stack の 1 行目はメッセージなので、2 行目（最初のフレーム）を採る
  const frame = err.stack.split('\n')[1]?.trim() ?? '';
  return `${msg} ${frame}`;
}
