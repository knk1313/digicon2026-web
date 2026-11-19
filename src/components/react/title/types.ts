// 吊られたタイトルの中で使う型
import type { Body, RopeJoint } from 'planck';
import type { Cable } from '../../../lib/physics/cable';
import type { GlyphShape, Vec } from '../../../lib/physics/glyph';
import type { Rope } from '../../../lib/physics/rope';
import type { LetterEls, PegEls } from './view';

/** タイトル用のペグ。文字が吊られていなければ、空のワイヤー（rope。見た目だけ）が垂れる */
export interface TitlePeg extends PegEls {
	x: number;
	y: number;
	/** 最初に吊っていたワイヤーの長さ */
	length: number;
	letter: Letter | null;
	rope: Rope | null;
}

export interface Hang {
	/** ペグ（最初の画面の座標） */
	x: number;
	y: number;
	/** 落ち着く長さ（px） */
	length: number;
	/** いまのロープの長さ。巻き上げ中は length へ縮めていく */
	cur: number;
	joint: RopeJoint;
	/** 吊っているタイトル用のペグ（文字はタイトル用のペグにしか吊らない） */
	titlePeg: TitlePeg;
}

export interface Letter extends LetterEls {
	ch: string;
	row: number;
	color: string;
	shape: GlyphShape;
	body: Body;
	/** 吊られる側の環の位置（文字の局所座標の px。原点は重心） */
	ring: Vec;
	hang: Hang | null;
	/** 吊っているワイヤーの見た目（うねるロープ）。吊られていなければ null */
	cable: Cable | null;
	/** ワイヤーの見た目の先（環の位置。毎フレーム書き換える） */
	cableEnd: Vec;
}

/** 吊り先の候補 */
export interface Target {
	x: number;
	y: number;
	length: number;
	titlePeg: TitlePeg;
}

/** 文字をつまんでいる */
export interface Drag {
	letter: Letter;
	pointerId: number;
	/** 最後のポインタの位置（画面座標）。つまんだままスクロールしたら、ここから引く先を測り直す */
	clientX: number;
	clientY: number;
}

/** 文字を押した（まだつまんでいない。動かせばつまむ、動かさなければ押しただけ） */
export interface Pending {
	letter: Letter;
	pointerId: number;
	x: number;
	y: number;
}

/** 空のワイヤーの先をつまんでいる（ケーブルの側から文字へ伸ばす。引継ぎ資料の B3） */
export interface RopeDrag {
	peg: TitlePeg;
	pointerId: number;
	x: number;
	y: number;
	moved: boolean;
}

/** 吊られている（最初） → 落ちて着地した */
export type Phase = 'hung' | 'landed';
