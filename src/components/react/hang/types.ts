// 吊った札の層の中で使う型
import type { Body, RopeJoint } from 'planck';
import type { Cable, Pt } from '../../../lib/physics/cable';
import type { HangSpec } from './measure';
import type { EntryEls } from './view';

/** 吊っている札1枚 */
export interface Entry extends HangSpec, EntryEls {
	el: HTMLElement;
	body: Body;
	/** ワイヤーの長さ（px） */
	lengths: number[];
	/** いまのロープの長さ（px）。つかんでいるあいだは伸び、離すと lengths へ巻き戻る */
	cur: number[];
	/** つかんでいるあいだ、ロープで引いていない（どこまでも伸びる） */
	free: boolean;
	ropes: RopeJoint[];
	/** 描くためのワイヤーと、その両端 */
	cables: Cable[];
	ends: Pt[];
	/** 前のフレームで、物体もワイヤーの見た目も止まっていた（止まっている札は描き直さない） */
	rest: boolean;
	/** スクロールで揺れる向き（札ごとに左右を変える） */
	dir: number;
	/** ペグ・ワイヤー・孔を入れる SVG のグループ */
	g: SVGGElement;
}

/** ペグをつまんでいる（挿し替え） */
export interface PegDrag {
	entry: Entry;
	index: number;
	id: number;
	x: number;
	y: number;
	moved: boolean;
}
