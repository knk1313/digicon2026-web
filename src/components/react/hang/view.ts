// 吊った札の見た目（SVG のペグ・ワイヤー・吊られる側の孔と、札の要素の transform）。
// 物理と操作は HangScene.ts が受け持ち、ここは何を描くかを受け取って描くだけ
import type { BoardGrid } from '../../../lib/board';
import type { Pt } from '../../../lib/physics/cable';
import { svg } from '../../../lib/svg';
import type { HangKind } from './measure';

/** 札1枚ぶんの SVG の要素（ワイヤーの本数だけ並ぶ） */
export interface EntryEls {
	wireEls: SVGPathElement[];
	endEls: SVGCircleElement[];
	pegEls: SVGCircleElement[];
	/** ペグの当たり（押すとペグを挿し替えられる） */
	pegHits: SVGCircleElement[];
}

/** ペグの当たりで起きたこと */
export interface PegHandlers {
	down: (index: number, ev: PointerEvent) => void;
	enter: () => void;
	leave: () => void;
}

/** 札のペグ・ワイヤー・孔の SVG を parent の中に作り直す（形は drawWire で毎フレーム書き換える） */
export function buildEntryEls(parent: SVGGElement, grid: BoardGrid, pegs: Pt[], kind: HangKind, lit: string | undefined, on: PegHandlers): EntryEls {
	const g = grid;
	parent.replaceChildren();
	const els: EntryEls = { wireEls: [], endEls: [], pegEls: [], pegHits: [] };
	pegs.forEach((p, i) => {
		els.wireEls.push(svg('path', { fill: 'none', stroke: 'var(--color-wire)', 'stroke-width': g.wire, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'data-hook': 'wire' }, parent));
		els.pegEls.push(svg('circle', { cx: p.x, cy: p.y, r: g.peg / 2, fill: lit ?? 'var(--color-peg)', stroke: 'var(--color-peg)', 'stroke-width': 1.5, 'data-hook': 'peg' }, parent));
		els.endEls.push(
			kind === 'grommet'
				? svg('circle', { r: g.grommet / 2, fill: 'var(--color-board)', stroke: 'var(--color-ink)', 'stroke-width': 1.5, 'data-hook': 'end' }, parent)
				: svg('circle', { r: 3, fill: 'none', stroke: 'var(--color-wire)', 'stroke-width': 1.4, 'data-hook': 'end' }, parent),
		);
		// ペグの当たり：指でも押しやすいよう大きめ。押すとペグを挿し替えられる
		const hit = svg('circle', { cx: p.x, cy: p.y, r: Math.max(12, g.step * 0.4), fill: 'transparent' }, parent);
		hit.style.pointerEvents = 'all';
		hit.style.cursor = 'grab';
		hit.style.touchAction = 'none';
		hit.addEventListener('pointerdown', (ev) => on.down(i, ev));
		hit.addEventListener('pointerenter', on.enter);
		hit.addEventListener('pointerleave', on.leave);
		els.pegHits.push(hit);
	});
	return els;
}

/**
 * 札の要素を、レイアウト上の位置 home から物理の位置 pos・傾き angle へずらす。
 * レイアウト上の位置のまま傾いてもいなければ、何も書かない
 * （先に書くと、あとから hydrate する island（WorksBoard）と HTML が食い違う）
 */
export function placePanel(el: HTMLElement, home: { x: number; y: number }, pos: Pt, angle: number): void {
	const dx = pos.x - home.x;
	const dy = pos.y - home.y;
	// ロープ関節には 0.25px ほどの許し（linearSlop）があるので、それより少し大きいずれまでは「動いていない」とみなす
	const still = Math.abs(dx) < 0.6 && Math.abs(dy) < 0.6 && Math.abs(angle) < 0.002;
	const t = still ? '' : `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px) rotate(${angle.toFixed(4)}rad)`;
	if (el.style.transform !== t) el.style.transform = t;
}

/** i 本目のワイヤーの形と、吊られる側の孔の位置を書く */
export function drawWire(els: EntryEls, kind: HangKind, i: number, path: string, end: Pt): void {
	els.wireEls[i]?.setAttribute('d', path);
	const endEl = els.endEls[i];
	if (endEl) {
		endEl.setAttribute('cx', end.x.toFixed(2));
		endEl.setAttribute('cy', (kind === 'ring' ? end.y - 3 : end.y).toFixed(2));
	}
}

/** i 本目のペグを p へ動かす */
export function movePegEls(els: EntryEls, i: number, p: Pt): void {
	els.pegEls[i]?.setAttribute('cx', String(p.x));
	els.pegEls[i]?.setAttribute('cy', String(p.y));
	els.pegHits[i]?.setAttribute('cx', String(p.x));
	els.pegHits[i]?.setAttribute('cy', String(p.y));
}

/** 挿し替え先の下見（孔の輪）を作る。最初は隠しておく */
export function createHolePreview(root: SVGSVGElement, grid: BoardGrid): SVGCircleElement {
	const c = svg('circle', { r: grid.peg, fill: 'none', stroke: 'var(--color-ink)', 'stroke-width': 1.5, 'stroke-dasharray': '2 2' }, root);
	c.style.display = 'none';
	return c;
}

/** 挿し替え先の下見を p に出す。p が null なら隠す */
export function showHolePreview(c: SVGCircleElement | null, p: Pt | null): void {
	if (!c) return;
	if (!p) {
		c.style.display = 'none';
		return;
	}
	c.setAttribute('cx', String(p.x));
	c.setAttribute('cy', String(p.y));
	c.style.display = '';
}

/** なでるとワイヤーが揺れる距離（ワイヤーのたるみと、押しのける半径の分の余裕） */
const NEAR_WIRE = 40;

/** 点 p が、ワイヤー（ペグ pegs[i] と孔 ends[i] を囲む範囲）の近くにあるか */
export function nearWires(pegs: Pt[], ends: Pt[], p: Pt): boolean {
	for (let i = 0; i < pegs.length; i++) {
		const a = pegs[i];
		const b = ends[i];
		if (
			p.x > Math.min(a.x, b.x) - NEAR_WIRE &&
			p.x < Math.max(a.x, b.x) + NEAR_WIRE &&
			p.y > Math.min(a.y, b.y) - NEAR_WIRE &&
			p.y < Math.max(a.y, b.y) + NEAR_WIRE
		)
			return true;
	}
	return false;
}
