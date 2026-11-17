// 有孔ボードの格子。値は docs/design/tokens.md と src/styles/global.css の --board-* とそろえる

export interface BoardGrid {
	/** 孔の間隔 */
	step: number;
	/** 最初の孔の中心（ボードの左上から） */
	ox: number;
	oy: number;
	/** ペグの頭の直径 */
	peg: number;
	/** 吊られる側の孔の直径 */
	grommet: number;
	/** ワイヤーの太さ */
	wire: number;
}

/** この幅より狭いとスマホの格子にする（global.css の @media と同じ） */
export const MOBILE_MAX = 767;

const DESKTOP: BoardGrid = { step: 34, ox: 33, oy: 16, peg: 9, grommet: 9, wire: 1.5 };
const MOBILE: BoardGrid = { step: 22, ox: 9, oy: 16, peg: 7, grommet: 7, wire: 1.2 };

export function gridFor(width: number): BoardGrid {
	return width <= MOBILE_MAX ? MOBILE : DESKTOP;
}

/** x をいちばん近い孔の列に吸着させる */
export function snapX(g: BoardGrid, x: number): number {
	return Math.round((x - g.ox) / g.step) * g.step + g.ox;
}

/** y 以下でいちばん近い孔の段（上側）に吸着させる */
export function snapYAbove(g: BoardGrid, y: number): number {
	return Math.floor((y - g.oy) / g.step) * g.step + g.oy;
}

/** 吊られる側の孔は、要素の上端からこれだけ下にある */
export const GROMMET_OFFSET = 9;

/** ペグと吊られる要素の上端のあいだに、最低これだけ空ける */
export const MIN_DROP = 24;
