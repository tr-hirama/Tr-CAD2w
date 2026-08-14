---
name: trcad2w-cycle
description: Tr-CAD2w の改修1件を、issue→ブランチ→実装→テスト→ブラウザ実機検証→コミット→PR→マージまで一定の品質で通す手順。「コミット〜マージ」「起動」だけを指示されたときの動作もここで定義する。Tr-CAD2w のコードを触るときは常にこの手順に従う。
---

# Tr-CAD2w 改修サイクル

**改修1件＝issue1本＝ブランチ1本＝コミット1本＝PR1本。** これを崩さない。

前提となるリポジトリの事実（座標系・色の置き場・型の罠）は `CLAUDE.md` にある。この文書は**順番**を定義する。

## 0. 指示は GitHub から受け取る

**指示は issue / PR の上で出る。自分で次の issue を選んで着手しない。** 取り決めは issue #18。

| 合図 | 動作 |
|---|---|
| **新しい issue が立った** | **必ず読んで報告する**（ラベルが無くても）。着手はしないが、見落とさない |
| issue に **`着手可`** ラベル | その issue に着手（複数あれば**番号の小さい順**）。着手したら `作業中` に差し替え、PR を出したら外す |
| issue の**コメント** | 仕様の指示・質問への回答として読み、実装に反映する |
| PR の **approve** | `main` へ merge commit → ブランチ削除 → issue が閉じたか確認 |
| PR の **changes requested** / コメント | 指摘を直して同じブランチへ push |

**巡回では必ず「新規 issue」も見る。** ラベルとコメントだけを見ていると、ラベルの付いていない新しい issue を丸ごと見落とす（実際に #19「スラックへ通知」を 13 時間見落とした）。

```bash
gh issue list --state open --search "created:>=<前回巡回時刻>" --json number,title,author
```

判断が必要になったら **`要確認` を付けて issue にコメントし、返事があるまでその issue は止める**（他の `着手可` は進めてよい）。依存がある issue は `着手可` が付いていても**依存先が済むまで着手せず、その旨をコメント**する。

指示が無ければ何もしない。**「指示が無いから代わりにこれをやる」は禁止。**

## 1. 着手前 — issue を選び、ブランチを切り、ベースラインを取る

```bash
gh issue list --state open
gh issue view <番号>
```

最新 `origin/main` から改修用ブランチを作る（`issue-<番号>-<英語スラッグ>`。issue 無しは `chore-<スラッグ>`）:

```bash
git fetch --all --prune
git switch -c issue-<番号>-<スラッグ> origin/main
```

**変更前に**テストを走らせ、件数を記録する:

```bash
npm test
npm run build
```

これを省くと「元から落ちていたテスト」を自分の変更のせいだと誤診し、無関係な箇所を壊す。**現状は全 pass。** 落ちたら自分の変更が原因。

## 2. 実装

デスクトップ版（`C:\claude\TrCad2D`）を読むのは、**利用者がデスクトップ版／VB 版を引き合いに出したときだけ。** 毎サイクルの必須手順ではない。条件に当たったときは推測で実装せず該当箇所を読み、参照をコミットに残す。

- 触る値が既に一元管理されていないか確認する（画層色なら `layer.ts` の `STANDARD_LAYERS`）。**同じ値を2箇所に書かない**
- 図形を1種類足したら `entity.ts` の switch をすべて埋め、`cloneEntity` も見る（抜けると Undo とコピペで値が消える）
- 図面を変える処理の直前に `doc.beginEdit()`。呼び忘れるとその操作が Undo で戻らない
- **純ロジックは `src/core` の純関数に切り出す。** UI（`src/ui`）に埋めるとテストが書けない
- 検出したい振る舞いに対応するテストを `test/*.test.ts` に**追加する**（既存ファイルに1件足すのが基本）

## 3. 検証 — 3点セット。1つでも欠けたら未完了

1. **自動テスト** — `npm test` と `npm run build`（型検査込み）。ベースラインと件数を比べる
2. **ブラウザ実機** — `npm run dev` で実際に動かす。合成 `PointerEvent` を投げれば作図・選択・パン・ズームまで自動で追える:

   ```js
   const app = window.TrCad2w;                    // アプリ本体
   const c = document.getElementById('canvas');
   const r = c.getBoundingClientRect();
   const ev = (t, x, y, b = 0) => new PointerEvent(t, {
     clientX: r.left + x, clientY: r.top + y, bubbles: true,
     button: b, buttons: b === 0 ? 1 : b === 1 ? 4 : 2,
     pointerId: 1, pointerType: 'mouse', isPrimary: true,
   });
   app.setTool('line');
   for (const p of [[200, 200], [400, 300]]) {
     c.dispatchEvent(ev('pointermove', ...p));
     c.dispatchEvent(ev('pointerdown', ...p));
     c.dispatchEvent(ev('pointerup', ...p));
   }
   app.snapshot();                                // 現在の描画を PNG データ URL で取得
   ```

   **見た目の確認は `canvas.getImageData` でピクセルを数える**のが確実（「青い線が4辺すべてに出ているか」等）。ブラウザペインのスクリーンショットは撮れないことがある
3. **反証** — 直した箇所をわざと元に戻し、**追加したテストが落ちることを確認する**

反証で落ちなければ、そのテストは何も守っていない。書き直す。

## 4. 起動確認

**「起動」** と言われたら dev サーバを立てて URL を報告する（`C:\claude\.claude\launch.json` の `tr-cad2w`、port 5173）。ビルド版を見せるときは `npm run build` → `npm run preview`。

## 5. コミット

日本語。1行目は利用者の言葉で「何が変わるか」（実装用語ではなく症状・機能の言葉）。

```
<1行要約>

■ 症状（または ■ 目的）
利用者に見えていた不具合。具体値を入れる。新機能なら目的。

■ 原因
なぜそうなっていたか（識別子で指す。行番号は書かない）。

■ 修正
何をどう変えたか。判断を伴う点は理由も。

■ テスト
件数の before → after、ブラウザ実機で確かめた数値、反証の結果。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

利用者に影響する副作用（既定値が変わる・保存形式が変わる等）は**必ず書き、口頭でも伝える**。保存形式を変えたら `FILE_FORMAT_VERSION` を上げるか、後方互換で読めることをテストで示す。

## 6. コミット〜PR〜マージ

**通常（ループ含む）は PR 作成まで。マージは PR の承認（approve）が付いてから行う**（利用者が直接マージしても可）:

```bash
git add -A
git commit -m "..."
git push -u origin <ブランチ名>
gh pr create --base main --head <ブランチ名> --title "<コミット1行目と同じ>" --body "..."
```

PR body はコミット本文と同じ内容を Markdown（表つき）で書き、`Closes #<番号>` を入れ、末尾に `🤖 Generated with [Claude Code](https://claude.com/claude-code)` を付ける。
承認待ちの間も次の改修は新ブランチで並行してよい（依存がある場合は待ち、PR に明記する）。

承認後（または「コミット〜マージ」と明示指示されたとき）:

```bash
gh pr merge <N> --merge
git fetch --all --prune
git switch main
git merge --ff-only origin/main
git branch -d <ブランチ名>
```

マージ後、他の open PR にコンフリクトが出ていないかを確認し、出ていればそのブランチへ `origin/main` を取り込んで解消→テストを再実行する。

## 7. やらないこと

- **`gh auth` などトークン/パスワードの入力を代行しない。** 状態だけ報告し、入力は利用者本人に依頼する
- 頼まれていないリファクタを混ぜない。1コミット1目的
- テストが落ちたまま「完了」と報告しない。落ちたら出力ごと報告する
- 落ちたテストを、原因を調べずにテスト側を緩めて通さない
- 範囲外で気づいた問題は直さず `gh issue create` で残す
- **実行時依存（npm パッケージ）を勝手に増やさない。** 必要なら理由を PR に書いて相談する
