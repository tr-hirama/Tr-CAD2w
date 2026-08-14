# Tr-CAD2w

TypeScript + Canvas のブラウザ版2D測量CAD。**デスクトップ版 [TrCad2D](https://github.com/tr-hirama/TrCad2D)（WPF / .NET 10 + SkiaSharp）の移植**であり、仕様の正はデスクトップ版。

- 機能一覧・画面構成・キー操作・ファイル構成は README.md にある（ここに重複して書かない）
- 依存は最小（`typescript` / `vite` / `vitest` のみ）。**実行時の依存は入れない**方針。増やすときは理由を PR に書く

> この文書は**行番号を書かない**（改修のたびにずれて嘘になるため）。位置は `CadDocument` の `loadJson` のように**識別子**で指す。

## 仕様の正はデスクトップ版

```
C:\claude\TrCad2D\      C#/WPF 版（さらにその正は VB.NET 版 C:\claude\cad-trcad\vbSurvey\frmTrCAD.vb）
```

**デスクトップ版を読むのは「利用者がデスクトップ版／VB 版を引き合いに出したとき」だけ。** 毎回の改修サイクルの必須手順ではない。

読む条件に当たったら**推測で実装せず**該当箇所を読み、参照をコミットメッセージに残す。既存コードは「デスクトップ版の `LayerStyle.cs` に対応」の形でコメントに書いている。

移植で数値や規則を写すときは、**値の出どころをコメントに残す**（例: 破線の刻み 250 / 125 は線種尺度 500 のとき）。

## 開発と検証

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # vitest（core / render の純ロジック）
npm run build    # tsc --noEmit → vite build
```

- **型検査は `npm run build` に含まれる。** `tsc` は `strict` に加えて `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` / `noUnusedLocals` を有効にしている。配列アクセスは `arr[i]!` の形になるのが普通
- import は**拡張子つきの `.js`**（`./geometry.js`）で書く。ESM + bundler resolution の約束
- テストは `test/*.test.ts`。**検証値は二進小数として厳密な値（1/64・1/32・4・8 など）を使う**。丸めが浮動小数誤差でぶれない。三角関数を通る値だけ `toBeCloseTo`

### 検証の3点セット（1つでも欠けたら未完了）

1. **自動テスト** — `npm test` と `npm run build`。**着手前にベースラインを取る**
2. **ブラウザ実機** — `npm run dev` で描画・操作を実際に確かめる。合成 `PointerEvent` を投げれば作図・選択・パン・ズームまで自動で追える（`window.TrCad2w` にアプリ本体が入っている。`TrCad2w.snapshot()` で現在の描画を PNG データ URL で取得できる）
3. **反証** — 直した箇所をわざと元に戻し、**追加したテストが落ちることを確認する**。落ちないテストは何も守っていない

## 触る前に知っておく罠

### `Omit<Entity, 'id'>` は書かない

`Entity` はユニオンなので `Omit` がユニオンに分配されず、共通プロパティだけの型に潰れる（`kind: 'line'` なのに `a` を渡せなくなる）。**`NewEntity`（`entity.ts` の分配 Omit）を使う。**

### 図形を1種類足したら `entity.ts` の switch をすべて埋める

`entityBounds` / `hitTest` / `translateEntity` / `rotateEntity` / `scaleEntity` / `snapPoints` / `flatten` / `entityAnchor`。`kind` を網羅していないと型検査で落ちるので、**落ちた箇所が直すべき箇所の一覧**になる。

フィールドを増やしたときは `cloneEntity` も見る。**抜けると Undo（スナップショット複製）とコピペで値が消える。**

### 色は `layer.ts` が唯一の置き場

- 画層の色・線種の定義はすべて `STANDARD_LAYERS`。デスクトップ版 `LayerStyle.cs` の移植先
- **黒で見せたい画層は `VB_BLACK`（= 白 / AutoCAD の色 7）として持つ。** `#000000` を直接書いてはいけない
- 明背景で黒く見えるのは `effectiveColor` が反転させているからで、色そのものは白
- **描画側で色を直に決めず、必ず `effectiveColor(e, ctx)` を通す**

### 線種の刻みは図面寸法・線幅は画面固定

刻み（mm）= 線種定義 × 線種尺度（`lineTypeScale`、新規図面は 500）。ズームすると画面上の破線の本数が変わる（AutoCAD と同じ）。**線幅だけはズーム非依存**で、これはデスクトップ版に合わせた意図的な非対称。

### 座標系

ワールドは **Y 上向き・単位 mm**、画面は Y 下向き。**変換は `CadView` だけが知っている。** 描画・入力側で `height - y` のような式を書かない。円弧の角度は反時計回り（DXF ARC と同じ）で、Canvas へ渡すときに符号を反転している。

### Undo はスナップショット

**図面を変える処理の直前に `doc.beginEdit()` を呼ぶ。** 呼び忘れるとその操作が Undo で戻らない。1 操作 = `beginEdit()` 1 回（複写の連続のように 1 クリックごとに確定する操作は、クリックごとに呼ぶ）。

## git の運び方

| 項目 | 値 |
|---|---|
| remote | `tr-hirama/Tr-CAD2w` |
| デフォルトブランチ | `main` |
| 作業ブランチ | issue ごとに最新 `origin/main` から作成（`issue-<番号>-<英語スラッグ>`。issue 無しは `chore-<スラッグ>`） |
| マージ先 | `main`（merge commit。squash / rebase にしない） |
| マージ条件 | **自動マージしない。PR の承認が付いてからマージする**（利用者が直接マージしても可） |

**改修1件＝issue1本＝ブランチ1本＝コミット1本＝PR1本。** 手順は `.claude/skills/trcad2w-cycle/SKILL.md`（`/trcad2w-cycle`）。着手順は milestone（M1 DXF入出力 → M2 編集操作 → M3 測量 → M4 図面表現と出力）。

コミットメッセージは日本語。1行目は利用者の言葉で「何が変わるか」。本文は `■ 症状` / `■ 原因` / `■ 修正` / `■ テスト` の見出しで書き、末尾に `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`。

## やらないこと

- **`gh auth` 等のトークン / パスワード入力を代行しない。** 状態だけ報告し、入力は利用者本人に依頼する
- 頼まれていないリファクタを混ぜない。1コミット1目的
- テストが落ちたまま「完了」と報告しない。落ちたら出力ごと報告する
- 落ちたテストを、原因を調べずにテスト側を緩めて通さない
- 範囲外で気づいた問題は直さず `gh issue create` で残す
