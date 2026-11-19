// 吊られたタイトルの決まった値（配置・手触り）

export const ROWS = ['つなぐ、', 'かわる、', 'うまれる'];

// ペグは段ごとに、その段の文字のすぐ上の孔の列に置く（段の間隔 dy は孔の格子の 4 つ分なので、どの段もワイヤーの長さがそろう）。
// 環からこれだけ（孔の間隔に対する割合）は離して、それより上でいちばん近い孔の列を選ぶ
export const TITLE_PEG_GAP = 0.25;
/** 文字の当たりの多角形の頂点の上限（planck は 12 まで） */
export const MAX_VERTS = 10;
/** 巻き上げの速さ（1/秒。大きいほど速く縮む） */
export const REEL_RATE = 3.5;
/** ワイヤーの先を引いているとき、指からこの距離（px）以内の文字を相手にする（ib/tie.js と同じ） */
export const NEAR_RADIUS = 46;
/** つまんでいる文字の回転の減り方と、回る速さの上限（ラジアン/秒）。重心から外れた点をつまんでも、ぐるぐる回り続けない */
export const DRAG_ANGULAR_DAMPING = 9;
export const DRAG_MAX_SPIN = 6;
/** つまんでいた文字を離したときの速さの上限（px/秒）。投げても画面の外まで吹っ飛ばないように */
export const THROW_MAX_SPEED = 700;
/** 一斉に落ちるとき、切れたワイヤーの先が跳ねる強さ（文字の大きさ 96px のとき） */
export const SNAP_KICK = 300;
/** ふだんの回転の減り方（board-world.ts の createPolygon と同じ） */
export const LETTER_ANGULAR_DAMPING = 0.6;

/** タイトルの配置。値は docs/design/tokens.md の「タイトルの配置」 */
export interface TitleLayout {
	x0: number;
	y0: number;
	adv: number;
	roff: number;
	dy: number;
	size: number;
}

export const TITLE_LAYOUT: { desktop: TitleLayout; phone: TitleLayout } = {
	desktop: { x0: 84, y0: 82, adv: 102, roff: 34, dy: 136, size: 96 },
	phone: { x0: 20, y0: 92, adv: 66, roff: 22, dy: 88, size: 60 },
};
