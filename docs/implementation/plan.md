# 実装計画（トップページ v5）

デザインの決まりごとは [../design/rules.md](../design/rules.md)、値は [../design/tokens.md](../design/tokens.md)、部品は [../design/components.md](../design/components.md)。この文書は、複数のエージェントが分担して実装するための地図である。

## 方針

- **Astro ＋ React の island。** 読める内容（展示名、会期、作品名など）は Astro で HTML に出す。吊る・落ちる・結ぶなど動きのある部分だけを React の island にする。
- **物理と描画は React の外で回す。** 毎フレームの更新は `requestAnimationFrame` と ref で行い、React の再レンダリングに乗せない。計算は `src/lib/` の素の TypeScript にまとめる。
- **ボードの上の物理は planck.js（Box2D の移植、`planck@1.5.1`）の世界 1 つで動かす。** 吊られた札（HangLayer）とタイトルの文字（HangingTitle）は別々の island だが、`src/lib/physics/board-world.ts` の同じ世界の物体になる。札どうし・札と文字の衝突、ワイヤー（ロープ関節）、つかむ（マウス関節）、ページの端の見えない壁は、すべてこの世界が受け持つ。落ちたものの床は、各節の下端に吊った棚（横長の札）。自前の当たり判定は書かない。
- **ワイヤーの見た目のうねり**（`cable.ts`、`rope.ts`）は描くためだけのもので、物理には加わらない。
- **ポップアップ（ステートメントのシート、作品概要のパネル）も planck.js で動かす**（`pinned.ts`）。画面に固定された重ね合わせで、ほかの物とはぶつからないので、ボードの世界には入れず、カードごとに小さな世界を持つ。ワイヤーはロープ関節、つかむのはマウス関節。読むためのカードなので回転は止め、平行に振れるだけにする。
- **Three.js（React Three Fiber）は使わない。** 3D は不要。依存パッケージに残っているが、消すかどうかは人間が決める。
- **スクロールは既存の Lenis のまま。**
- **データは `src/data/demo.json`。** 作品は `categories`（文字列の配列）を持つ。

## ディレクトリ構成

```
src/
  pages/index.astro            トップページ。節を並べ、island を置く
  layouts/BaseLayout.astro     フォントの読み込み、Lenis
  styles/global.css            @theme のトークン、有孔ボードの背景、共通の部品の CSS
  components/
    astro/                     動かない部品（HTML を出すだけ）
      Section.astro            節。data-section を付け、下端に棚（横長の札）を置く
      Plate.astro              札。data-hang（孔の位置）を付ける
      Tape.astro               ラベル
      NavPlate.astro           ナビの札
    react/                     island
      HangLayer.tsx            data-hang の付いた要素を測り、ペグ・ワイヤー・吊られる側の孔を描く
      HangingTitle.tsx         吊られたタイトル（吊る→落ちる→着地→吊り直す）
      StatementMobile.tsx      ステートメントのシート（言葉のモビール）
      StatementButton.tsx      右上の固定ボタン
      WorksBoard.tsx           カテゴリーの面と作品カード、絞り込み
      WorkDetail.tsx           作品概要のパネル
  lib/
    board.ts                   孔の格子（間隔・起点）、吸着（snap）、画面幅ごとの値
    events.ts                  island どうしで使うイベント名と型
    data.ts                    demo.json の型と読み込み
    physics/
      board-world.ts           planck.js の世界（ページに 1 つ）。札・文字・ページの端の壁・ロープ関節・つかむ
      glyph.ts                 字形の凸包（文字の当たりの形）
      cable.ts                 描くためのロープ（結ぶケーブル、札のワイヤーのうねり）
      rope.ts                  描くためのロープ（タイトルの空のワイヤー）
      pinned.ts                ポップアップを孔に留めたカードとして落とす（カードごとの小さな planck.js の世界）
```

## 共有する約束事

複数の作業で使うもの。変えるときは、この文書も直す。

### データの型（`src/lib/data.ts`）

```ts
export interface Work {
  id: string;            // "01" など
  title: string;
  authors: string[];
  summary: string;       // 短い説明
  description: string;   // 長い説明
  thumbnail: string;
  categories: string[];  // 1つ以上
}
export interface Site {
  title: string;
  period: { start: string; end: string };
  theme: { title: string; statement: string };
  venue: string;
  works: Work[];
}
```

### イベント（`src/lib/events.ts`）

island どうしは `window` の CustomEvent で連絡する。

| 名前 | 送る側 | 受ける側 | 意味 |
| --- | --- | --- | --- |
| `digicon:statement-open` | StatementButton | StatementMobile | シートを開く |
| `digicon:statement-closed` | StatementMobile | HangingTitle、StatementButton | シートが閉じた（`detail.first` が true なら最初の1回） |
| `digicon:work-open` | WorksBoard | WorkDetail | 作品概要を開く（`detail.id`） |
| `digicon:layout` | HangLayer | だれでも | レイアウトが変わり、孔や床の位置を測り直した |

### DOM の目印

| 属性 | 付ける場所 | 意味 |
| --- | --- | --- |
| `data-section="hero"` など | 節の外側 | 節。下端に棚（`data-shelf` の付いた横長の札）を置く |
| `data-hang="0.18,0.82"` | 吊る要素 | 吊られる側の孔の位置（幅に対する割合） |
| `data-board` | ページの外側 | 有孔ボード。座標の基準 |

### CSS 変数

[tokens.md](../design/tokens.md) の名前をそのまま `@theme` に入れる。Tailwind のクラスでも `bg-panel` のように使える。

## 作業パッケージ

上から順に依存している。**WP0 が終わると、WP1〜WP4 は並行して進められる。** 各 WP は「担当ファイル」以外を原則として触らない。共有のファイル（`index.astro`、`global.css`、`lib/board.ts`、`lib/events.ts`）は、足すだけにとどめ、ほかの WP の部分を書き換えない。

| WP | 中身 | 担当ファイル | 状態 |
| --- | --- | --- | --- |
| WP0 | 土台：トークン、フォント、有孔ボード、節、札、ラベル、静的な吊り（HangLayer）、データの型、全節の静的な中身、ナビの札、ステートメントボタンの見た目 | `styles/global.css`、`layouts/BaseLayout.astro`、`pages/index.astro`、`components/astro/*`、`components/react/HangLayer.tsx`、`lib/board.ts`、`lib/sections.ts`、`lib/data.ts`、`lib/events.ts`、`data/demo.json` | 完了（タイトルは仮の `components/astro/TitleStatic.astro`。WP1 で置き換える） |
| WP1 | タイトル：吊られた状態、`statement-closed`（first）で一斉に落ちる、最初の画面の床で止まる、ドラッグとタップ→タップで吊り直す | `components/react/HangingTitle.tsx`、`lib/physics/*` | 完了（`TitleStatic.astro` は使われなくなった。消すかどうかは人間が決める） |
| WP2 | ステートメント：言葉のモビールの組み立て、開いた状態で始まる、外を押す・閉じる・Esc で閉じて上へ巻き上げ、フォーカス管理、右上ボタンとの連携 | `components/react/StatementMobile.tsx`、`components/react/StatementButton.tsx` | 完了 |
| WP3 | 作品：カテゴリーの端子をケーブルでつなぐ、AND の絞り込み、件数のラベル、0件の表示、カードの吊り | `components/react/WorksBoard.tsx` | 完了 |
| WP4 | 作品概要：パネルを吊って下ろす、閉じて巻き上げ、フォーカスを戻す、前後の作品、クレジット | `components/react/WorkDetail.tsx` | 完了 |
| WP5 | 仕上げ：スマホの調整、`prefers-reduced-motion`、キーボード操作 | 各ファイル（担当者と調整） | 未着手 |
| WP6 | ダーク版 | `styles/global.css` | 配色が未定 |

### 受け入れ条件

- **共通**：`npm run build` が通る。PC（1440×900）とスマホ（390×844）で崩れない。何も触らなくても、会期・会場・作品一覧・リンクが読める
- **WP0**：全節が有孔ボードの上に並び、札とカードがペグ→ワイヤー→吊られる側の孔で吊られて見える。節の範囲と床の線が見える。ワイヤーの上端が孔の中心に合っている（画面幅を変えても）
- **WP1**：着地した文字の字形の下端が、最初の画面の床の線に触れる（突き抜けない、浮かない）。ドラッグ中、つかんだ点がカーソルの真下にある
- **WP2**：初回に閉じたときだけタイトルが落ちる。シートを閉じたら、開く前にフォーカスがあった要素に戻る
- **WP3**：01×05 をつなぐと作品07と10だけが残る（`demo.json` のデモデータの場合）。ケーブルを押すと抜けて全件に戻る
- **WP4**：Esc で閉じられ、閉じたら押したカードにフォーカスが戻る

## 作業の進め方

- git は人間が操作する（AGENTS.md）。エージェントは作業ツリーに変更を残すところまで。
- 作業を始めるときは、この文書の表の「状態」を「進行中（担当：〇〇）」にし、終わったら「完了」にする。
- 見た目の判断に迷ったら、Figma の正の画面（[../design/README.md](../design/README.md) の表）を見る。決まりごとと画面が食い違ったら、決まりごとを優先し、食い違いを最後に報告する。
- コードのコメントは日本語で書く。
