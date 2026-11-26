// data-hang の付いた要素を測って、どこに吊るか（ペグ・孔・静止した位置）を決める。DOM を読むだけで、何も書き換えない。
// 要素に付ける属性：
//   data-hang="0.18,0.82"  吊る位置（幅に対する割合。数だけワイヤーを張る。既定は 0.5）
//   data-hang-kind="ring"  吊られる側が環（文字など）。既定は孔（grommet）
//   data-hang-peg="62"     ペグの高さ（ボードの y）。既定は要素の上端から MIN_DROP 以上うえの孔の段
//   data-hang-lit="..."    ペグの頭の色
import { GROMMET_OFFSET, MIN_DROP, snapX, snapYAbove, type BoardGrid } from '../../../lib/board';
import type { Pt } from '../../../lib/physics/cable';

export type HangKind = 'grommet' | 'ring';

/** 1つの要素の吊り方。座標はボードの左上から（px） */
export interface HangSpec {
	/** レイアウト上の中心と大きさ（CSS の translate の基準） */
	home: { x: number; y: number; w: number; h: number };
	/** 吊られる側の孔（要素の中心から見た px） */
	holes: Pt[];
	/** ペグ */
	pegs: Pt[];
	/** 吊られる側の孔の高さ */
	holeY: number;
	kind: HangKind;
	lit?: string;
	/** 吊りの位置を決めた値（同じなら、測り直しても揺れと挿し替えを引き継ぐ） */
	sig: string;
}

/** 要素の吊り方を測る。表示されていない・大きさのない要素は null */
export function readHangSpec(el: HTMLElement, board: DOMRect, g: BoardGrid): HangSpec | null {
	// 表示されていない要素（スマホで隠したナビなど）は吊らない
	if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return null;
	const r = el.getBoundingClientRect();
	if (r.width === 0 || r.height === 0) return null;
	const top = r.top - board.top;
	const left = r.left - board.left;
	const kind: HangKind = el.dataset.hangKind === 'ring' ? 'ring' : 'grommet';
	const holeY = kind === 'ring' ? top + 2 : top + GROMMET_OFFSET;
	const pegY = el.dataset.hangPeg ? snapYAbove(g, Number(el.dataset.hangPeg)) : snapYAbove(g, top - MIN_DROP);
	const fr = (el.dataset.hang ?? '0.5').split(',').map(Number);
	const pegs = fr.map((f) => ({ x: snapX(g, left + r.width * f), y: pegY }));
	const home = { x: left + r.width / 2, y: top + r.height / 2, w: r.width, h: r.height };
	const holes = pegs.map((p) => ({ x: p.x - home.x, y: holeY - home.y }));
	const sig = `${pegs.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')} ${home.x.toFixed(1)},${home.y.toFixed(1)} ${home.w.toFixed(0)}x${home.h.toFixed(0)}`;
	return { home, holes, pegs, holeY, kind, lit: el.dataset.hangLit, sig };
}

/** いちばん近い板の孔 */
export function nearestHole(g: BoardGrid, p: Pt): Pt {
	return {
		x: Math.round((p.x - g.ox) / g.step) * g.step + g.ox,
		y: Math.round((p.y - g.oy) / g.step) * g.step + g.oy,
	};
}
