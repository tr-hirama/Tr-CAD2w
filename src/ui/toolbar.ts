/**
 * ツールバーのボタンを**今出すかどうか**の判定（issue #58「使用していないボタンは表示しない」）。
 *
 * 基準は「**押しても断られるボタンは出さない**」。
 * 各コマンドは前提を満たさないと `setStatus` で断って何もしない作りになっている
 * （`editDimText` の「寸法を選択してから実行してください」など）。
 * その前提をそのまま表示条件にしているので、**出ているボタンは必ず効く**。
 *
 * 判定を DOM から切り離して純関数にしてあるのはテストのため。
 * 実際の出し入れは `CadApp.updateToolbar` が `hidden` で行う。
 */

/** ボタンの識別子。`index.html` の `data-cmd` / `data-tool` に対応する。 */
export type ToolbarKey = `cmd:${string}` | `tool:${string}`;

/** 表示条件の判定に使う、そのときの画面の状態。 */
export interface ToolbarContext {
  /** 選んでいるツール名（`data-tool` の値）。 */
  tool: string;
  /** 用紙空間（レイアウト）を開いているか。false ならモデル空間。 */
  inLayout: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** 図形を 1 つ以上選んでいるか。 */
  hasSelection: boolean;
  /** 選択の中に寸法があるか。 */
  hasSelectedDim: boolean;
  /** 選択の中にビューポート（紙の窓）があるか。 */
  hasSelectedViewport: boolean;
  /** ブロック定義を読み込んでいるか。 */
  hasBlocks: boolean;
  /** レベル（水準）が入っているか。 */
  hasLevel: boolean;
  /** 注記文の番号を選んでいるか。 */
  hasCheckedComment: boolean;
}

/**
 * ボタンごとの前提。ここに無いボタンは常に出す。
 *
 * **値はそのボタンを押したときに実際に見られる条件と同じもの**にする。
 * コマンド側の前提を変えたらここも直す（片方だけ直すと、出ているのに断られる／
 * 効くのに出ないボタンができる）。
 */
const REQUIREMENT: Readonly<Record<string, (ctx: ToolbarContext) => boolean>> = {
  // レベルが無い図面では帳票にする中身が無い（`exportReport` が断る）
  'cmd:export-report': (c) => c.hasLevel,
  // 注記文の番号を選んでいないと直す対象が無い（`editCommentText` が断る）
  'cmd:comment-text': (c) => c.hasCheckedComment,
  // 寸法を選んでいないと書き換える対象が無い（`editDimText` が断る）
  'cmd:dim-text': (c) => c.hasSelectedDim,
  // 窓を選んでいないと縮尺も全体合わせもできない（`editViewport` / `fitViewport` が断る）
  'cmd:vp-scale': (c) => c.hasSelectedViewport,
  'cmd:vp-fit': (c) => c.hasSelectedViewport,
  // モデル空間は削除できない（`removeLayout` が断る）
  'cmd:layout-remove': (c) => c.inLayout,
  // 窓は紙の上にしか開けない
  'tool:viewport': (c) => c.inLayout,
  // 読み込んだブロックが無いと置くものが無い
  'tool:insert': (c) => c.hasBlocks,
  // 柄はハッチ専用の設定
  'cmd:hatch-pattern': (c) => c.tool === 'hatch',
  // 履歴が無いときは戻る先／進む先が無い
  'cmd:undo': (c) => c.canUndo,
  'cmd:redo': (c) => c.canRedo,
  // 選択が無いと消す対象が無い
  'cmd:delete': (c) => c.hasSelection,
};

/** そのボタンを今出すか。前提の無いボタンは常に `true`。 */
export function isButtonUsable(key: string, ctx: ToolbarContext): boolean {
  return REQUIREMENT[key]?.(ctx) ?? true;
}

/** 前提を持つボタンのキー一覧（テストと、条件の抜けを見つけるために公開する）。 */
export function conditionalKeys(): string[] {
  return Object.keys(REQUIREMENT);
}
