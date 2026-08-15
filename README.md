# Tr-CAD2w

ブラウザで動く速度優先の2D測量CAD（TypeScript + Canvas）。デスクトップ版 [TrCad2D](https://github.com/tr-hirama/TrCad2D)（WPF / .NET 10 + SkiaSharp）の **Web 版**。

インストール不要・オフライン動作（静的ファイルのみ）で、図面ファイルはブラウザ内で完結します。

## 設計の考え方

デスクトップ版と同じ**イミディエイトモード描画**を採る。図形ごとに DOM 要素（SVG）を作ると数千図形で操作が重くなるため、`<canvas>` 1 枚へ毎フレーム描き直す。

| 方針 | 実装 |
|---|---|
| 画面内の候補だけ描く | 均一グリッドの**空間インデックス**（`SpatialIndex`）。スナップ・ヒットテストも近傍候補のみ評価 |
| 描き過ぎない | **LOD**（サブピクセル間引き・小さすぎる円は点・読めない文字は省略）、縮小しすぎた破線は実線に落とす |
| GPU へ差し替えられる | 描画の入口は `Renderer` 1 クラスのみ。WebGL 実装を差し込める |
| 座標系はデスクトップ版準拠 | ワールドは **Y 上向き・単位 mm**、変換は `CadView` が一手に引き受ける |

## いまできること

- **作図**: 線 / 矩形 / 円 / 円弧 / 連続線 / 点 / 文字（複数行・揃え指定あり）
- **選択**: クリック / Shift+クリックで追加・解除 / 左ドラッグで矩形選択（**右→左は交差選択**）
- **編集**: 移動・複写（基点→先の2クリック・点線プレビュー）・削除・Undo / Redo・重ね順（最前面 / 最背面）
- **画層**: 標準画層（境界・道路・家屋・電柱ほか）の色と線種、表示 / 非表示、作図先の切替
- **色**: 図形の個別色 or ByLayer。無彩色は**背景に応じて反転**（明背景で黒・暗背景で白）、有彩色は暗背景で持ち上げ
- **線種**: 実線 / 破線 / 点線 / 一点鎖線 / 中心線。**刻みは図面の寸法（mm）× 線種尺度**で決まる（AutoCAD と同じ）。線幅だけは画面固定
- **吸着**: 端点 / 中点 / 中心 / 点 / 交点、グリッド吸着
- **表示**: ホイールズーム（カーソル固定）・中／右ドラッグでパン・全体表示・等倍・背景色切替・グリッド
- **ファイル**: `.tc2w`（JSON）で保存・読込。**DXF の読込**（`LINE` / `CIRCLE` / `ARC` / `POINT` / `LWPOLYLINE` / `POLYLINE`+`VERTEX` / `TEXT` / `MTEXT`、色 `62`・`420` ／画層 `8` ／線種 `6` ／線幅 `370` ／`$LTSCALE`）。**文字コードは BOM → `$DWGCODEPAGE` → UTF-8 妥当性の順で自動判定**（Shift-JIS の日本語も化けない）
- **DXF の書出**（UTF-8 / R2007）: 図形・色（`420` で厳密＋`62` 併記）・画層・線種（`LTYPE` 定義つき）・線幅・`$LTSCALE` を出す。矩形は閉じた `LWPOLYLINE`、1行の文字は `TEXT`、複数行は `MTEXT`
- **デスクトップ版の `.tc2` と相互運用**: 読込・書出とも対応（下記の表のとおり一部の情報は落ちます）。ZIP の圧縮・伸長はブラウザ標準の `CompressionStream` / `DecompressionStream` を使うので**実行時依存は増えていません**
- **概要・注記文・境界コメント・メモ**: 現場名 / 概要コード / 作業者 / 備考、デスクトップ版と同じ**標準注記文 40 件**からの選択と本文の編集、境界番号と境界標の種類、メモ。**概要コード（無ければ現場名）が保存名の既定**になります。**手書きメモ（Windows Ink の ISF）は Web で描けないので、中身を解釈せずそのまま保って書き戻します**（Web で開いて保存しても消えません）
- **ドラッグ＆ドロップ**: 図面ファイルをキャンバスへ落として開く（**形式は拡張子ではなく中身で判定**します）
- **印刷 / PDF出力**: 用紙（A4〜A0 / B / Letter）・向き・カラー / モノクロ・尺度（ページに合わせる / 1:N）・余白・複数ページ分割・解像度を指定できるプレビュー付き。**1:1 なら図面 100mm が紙の上でも 100mm**。PDF は印刷ダイアログの「PDF に保存」で得る（実行時依存を増やさないため）
- **用紙空間（レイアウト / ビューポート）**: モデル空間を縮尺・位置・回転で紙に映すデータ構造。**線種尺度はモデル（500）と用紙（5）で別**に持つ（同じだと A4 より長い破線になり実線に見える）。※ UI は未実装

## デスクトップ版 `.tc2` との相互運用で落ちる情報

`.tc2` は JSON を ZIP 圧縮したもので、中身は `TrCad2D.json` 1 件です。図形・画層・色・線種・線幅・線種尺度は往復しますが、次は落ちます。

| 向き | 落ちるもの |
|---|---|
| **`.tc2` → Web** | ハッチ・ブロック（`Insert`）・画像・寸法（**開いたときに件数を表示**）、測量データ（観測 / 座標 / まわりけん / レベル / 座標変換）、用紙空間、グループ |
| **Web → `.tc2`** | 画層の**線種**（デスクトップ版の画層は色と表示だけ）、用紙空間 |

デスクトップ版の連続線に**閉合フラグが無い**ため、閉じた連続線は「最後に始点を足す」形で書き出し、読むときは「最初と最後が同じ点なら閉じている」とみなします（往復は一致します）。

## 操作

| キー / 操作 | 機能 |
|---|---|
| `S` `L` `R` `C` `A` `P` `D` `T` | 選択 / 線 / 矩形 / 円 / 円弧 / 連続線 / 点 / 文字 |
| ツールバーの **DXF書出** / **.tc2書出** | DXF（UTF-8 / R2007）/ デスクトップ版の .tc2 で書き出す |
| ツールバーの **概要** / **注記文** / **注記文の編集** / **境界コメント** / **メモ** | 図面に付ける文書情報を編集する |
| `M` | 移動（基点→先の2クリック） |
| ホイール | ズーム（カーソル位置固定） |
| 中 / 右ドラッグ | パン |
| 右クリック / `Enter` | 連続線の確定（作図中でなければ取消） |
| `Esc` | 取消 |
| `Del` | 選択図形を削除 |
| `Ctrl+Z` / `Ctrl+Shift+Z` | 元に戻す / やり直し |
| `Ctrl+A` | 全選択 |
| `Ctrl+S` / `Ctrl+O` | 保存 / 開く |
| `Ctrl+P` | 印刷プレビュー（←→ でページ送り・Esc で閉じる） |
| `Home` | 全体表示 |
| `F3` / `G` | オブジェクト吸着 / グリッド吸着の ON・OFF |
| `+` / `-` | ズームイン / アウト（中心固定） |

## 開発

```bash
npm install
npm run dev
```

```bash
npm test
```

```bash
npm run build
```

`npm run build` は型検査（`tsc --noEmit`）を通してから `dist/` へ静的ファイルを出します。`base` は相対パスなので、GitHub Pages などサブパス配信でもそのまま動きます。

## 構成

| ファイル | 役割 |
|---|---|
| `src/core/geometry.ts` | `Vec2`（Y 上向き）と AABB・線分距離などの基本幾何 |
| `src/core/view.ts` | ワールド⇔スクリーン変換、カーソル固定ズーム、全体表示 |
| `src/core/entity.ts` | 図形要素（判別可能ユニオン）と範囲・ヒットテスト・変形・スナップ点・折れ線展開 |
| `src/core/layer.ts` | **画層の色と線種の唯一の定義**。実効色（背景反転・暗背景の持ち上げ） |
| `src/core/document.ts` | 図面（図形集合・選択・Undo・保存 / 読込） |
| `src/core/project-info.ts` | 概要・注記文の選択・境界コメント・メモ（**手書きは素通しで保持**） |
| `src/core/comments.ts` | 標準注記文 40 件（デスクトップ版の `コメント一覧.csv` を写したもの） |
| `src/core/spatial-index.ts` | 均一グリッドの空間インデックス |
| `src/core/snap.ts` | オブジェクトスナップ・グリッド吸着・交点計算 |
| `src/core/file.ts` | `.tc2w` の入出力（保存ダイアログ・ファイル選択。**読込は必ずバイト列から入る**） |
| `src/io/dxf.ts` | DXF 読込（文字コード自動判定・グループコードの解釈・ACI 色・線種名の対応） |
| `src/io/dxf-write.ts` | DXF 書出（UTF-8 / R2007。**属性の対応は往復で一致するように決めてある**） |
| `src/io/zip.ts` | 最小限の ZIP 読み書き（CRC32・deflate はブラウザ標準の Stream API） |
| `src/io/tc2.ts` | デスクトップ版 `.tc2` との相互運用（DocDto ⇔ DocumentJson の対応） |
| `src/core/layout.ts` | 用紙空間（レイアウト・ビューポート）。モデル⇔紙の座標変換 |
| `src/print/paper.ts` | 用紙・尺度・ページ割付の純ロジック（**canvas とページ数の上限もここ**） |
| `src/print/print-job.ts` | 用紙解像度での描画と、ブラウザ印刷への受け渡し |
| `src/ui/print-dialog.ts` | 印刷プレビュー（設定・ページ送り・印刷） |
| `src/render/renderer.ts` | Canvas 2D 描画（グリッド・図形・選択・プレビュー・吸着マーカー） |
| `src/render/linetype.ts` | 線種の刻み（mm）と画面 px 換算、線幅換算 |
| `src/ui/tools.ts` | 作図ツールの状態機械（クリックを集めて図形を作る） |
| `src/ui/app.ts` | 入力の解釈・ツール駆動・描画ループ・UI の配線 |

## これから

デスクトップ版にあってまだ無いものを [issue](https://github.com/tr-hirama/Tr-CAD2w/issues) に起こしてあります。着手は **M1 → M4** の順（`M1 DXF入出力` から）。

| マイルストーン | issue |
|---|---|
| [M1 DXF入出力](https://github.com/tr-hirama/Tr-CAD2w/milestone/1) | ~~[#1 読込](https://github.com/tr-hirama/Tr-CAD2w/issues/1)~~ / ~~[#2 書出（UTF-8）](https://github.com/tr-hirama/Tr-CAD2w/issues/2)~~ / [#3 往復の検証](https://github.com/tr-hirama/Tr-CAD2w/issues/3) / [#4 Shift-JIS 出力の判断](https://github.com/tr-hirama/Tr-CAD2w/issues/4) |
| [M2 編集操作](https://github.com/tr-hirama/Tr-CAD2w/milestone/2) | [#5 トリム・延長・オフセット](https://github.com/tr-hirama/Tr-CAD2w/issues/5) / [#6 フィレット・面取り](https://github.com/tr-hirama/Tr-CAD2w/issues/6) / [#7 回転・拡縮・グループ・クリップボード](https://github.com/tr-hirama/Tr-CAD2w/issues/7) |
| [M3 測量](https://github.com/tr-hirama/Tr-CAD2w/milestone/3) | [#8 座標入力・CSV](https://github.com/tr-hirama/Tr-CAD2w/issues/8) / [#9 観測ファイル取込](https://github.com/tr-hirama/Tr-CAD2w/issues/9) / [#10 自動結線](https://github.com/tr-hirama/Tr-CAD2w/issues/10) / [#11 トラバース・三斜求積](https://github.com/tr-hirama/Tr-CAD2w/issues/11) |
| [M4 図面表現と出力](https://github.com/tr-hirama/Tr-CAD2w/milestone/4) | [#12 寸法線](https://github.com/tr-hirama/Tr-CAD2w/issues/12) / [#13 ハッチ・ブロック・画像](https://github.com/tr-hirama/Tr-CAD2w/issues/13) / ~~[#14 印刷・PDF・用紙空間](https://github.com/tr-hirama/Tr-CAD2w/issues/14)~~ / ~~[#15 `.tc2` 相互運用](https://github.com/tr-hirama/Tr-CAD2w/issues/15)~~ / [#16 WebGL 描画](https://github.com/tr-hirama/Tr-CAD2w/issues/16) |

改修は **issue1本＝ブランチ1本＝コミット1本＝PR1本**で進めます。手順は [.claude/skills/trcad2w-cycle/SKILL.md](.claude/skills/trcad2w-cycle/SKILL.md)。

## ライセンス

MIT
