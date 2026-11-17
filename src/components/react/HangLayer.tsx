// data-hang の付いた要素（札・カード・ナビなど）を、板の孔のペグからワイヤーで吊る層。
// 要素そのものを、planck.js の世界（lib/physics/board-world.ts）の長方形の物体として動かす。
// タイトルの文字も同じ世界にいるので、札どうし・札と文字は重さ・回転・摩擦を持ったままぶつかる。
// ・ワイヤーはロープ関節。ペグの高さが違えば、札は自然に傾いて吊られる
// ・マウス・ペンでつかんで動かせる（マウス関節）。離すと揺れながら戻る
// ・6px 以上動かしたらドラッグとみなし、続く click（リンク・カードを開く）は起こさない
// ・ペグはつまんで別の孔へ挿し替えられる（ドラッグか、ペグを押してから行き先の孔を押す）
// ・ホバーすると、その札のペグ・ワイヤー・孔が少し目立つ（どこで吊られているかの手がかり）
// ・スクロールでは、ごくわずかに左右へ振れる（動きを減らす設定では揺らさない）
// ・タッチでは札をつかまない（ページのスクロールを妨げないため）。ペグの挿し替えはタッチでもできる
// ・端子や入力欄など、data-no-drag の中からはつかまない
// 見た目のワイヤーのうねりは lib/physics/cable.ts（描くためだけのロープ）
import { useEffect, useRef } from 'react';
import type { Body, RopeJoint } from 'planck';
import { GROMMET_OFFSET, MIN_DROP, gridFor, snapX, snapYAbove, type BoardGrid } from '../../lib/board';
import { EVENTS, on } from '../../lib/events';
import { Cable, stepWire, wireCable, type Pt } from '../../lib/physics/cable';
import { SCALE, boardWorld, toM, toPx } from '../../lib/physics/board-world';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** つかまない要素 */
const NO_DRAG = '[data-no-drag], [data-jack], input, textarea, select, [contenteditable]';
/** これより動いたら、クリックではなくドラッグとみなす */
const DRAG_THRESHOLD = 6;

interface Entry {
	el: HTMLElement;
	body: Body;
	/** レイアウト上の中心と大きさ（CSS の translate の基準） */
	home: { x: number; y: number; w: number; h: number };
	/** 吊られる側の孔（札の中心から見た px） */
	holes: Pt[];
	/** ペグ（ボードの px）。挿し替えると変わる */
	pegs: Pt[];
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
	kind: 'grommet' | 'ring';
	lit?: string;
	/** 吊りの位置を決めた値（同じなら、測り直しても揺れと挿し替えを引き継ぐ） */
	sig: string;
	/** スクロールで揺れる向き（札ごとに左右を変える） */
	dir: number;
	g: SVGGElement;
	wireEls: SVGPathElement[];
	endEls: SVGCircleElement[];
	pegEls: SVGCircleElement[];
	pegHits: SVGCircleElement[];
}

/** ペグをつまんでいる（挿し替え） */
interface PegDrag {
	entry: Entry;
	index: number;
	id: number;
	x: number;
	y: number;
	moved: boolean;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent: Element): SVGElementTagNameMap[K] {
	const el = document.createElementNS(SVG_NS, tag);
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
	parent.appendChild(el);
	return el;
}

function reducedMotion(): boolean {
	return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

class HangScene {
	private entries: Entry[] = [];
	private grid: BoardGrid = gridFor(1440);
	private lastScroll = window.scrollY;
	private pending: { entry: Entry; id: number; x: number; y: number } | null = null;
	/** つかんでいる札 */
	private held: { entry: Entry; id: number } | null = null;
	private pegDrag: PegDrag | null = null;
	/** タップで選んだペグ（次に押した孔へ挿し替える） */
	private pegSelected: { entry: Entry; index: number } | null = null;
	/** 挿し替え先の下見（孔の輪） */
	private preview: SVGCircleElement | null = null;
	private suppressClick = false;
	/** マウスの位置（ボードの座標）。ワイヤーをなでると揺れる */
	private ptr: Pt | null = null;
	/** 最初の測定が済んだ。以後に初めて出てくる札は、勢いよく落ちてくる（ページを開いたときの札は落とさない） */
	private ready = false;
	private offs: (() => void)[] = [];
	private world = boardWorld();

	constructor(
		private svgEl: SVGSVGElement,
		private board: HTMLElement,
	) {}

	init(): void {
		let raf = 0;
		const remeasure = () => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(() => this.measure());
		};
		document.fonts?.ready.then(remeasure);
		const ro = new ResizeObserver(remeasure);
		ro.observe(this.board);
		const offLayout = on(EVENTS.layout, remeasure);
		const offFrame = this.world.addListener({ before: (dt) => this.beforeStep(dt), after: () => this.render() });
		const down = (e: PointerEvent) => this.onDown(e);
		const move = (e: PointerEvent) => this.onMove(e);
		const up = (e: PointerEvent) => this.onUp(e);
		const click = (e: MouseEvent) => {
			if (!this.suppressClick) return;
			this.suppressClick = false;
			e.preventDefault();
			e.stopPropagation();
		};
		const dragstart = (e: DragEvent) => {
			// リンクや画像のネイティブのドラッグで、つかむのが切れないようにする
			if (this.pending || this.held) e.preventDefault();
		};
		const key = (e: KeyboardEvent) => {
			if (e.key === 'Escape' && this.pegSelected) this.selectPeg(null);
		};
		// ウィンドウから離れたら、つかんだままの状態を解く
		const blur = () => this.releaseAll();
		const scroll = () => this.onScroll();
		this.board.addEventListener('pointerdown', down);
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('pointercancel', up);
		window.addEventListener('click', click, true);
		window.addEventListener('keydown', key);
		window.addEventListener('blur', blur);
		this.board.addEventListener('dragstart', dragstart);
		window.addEventListener('scroll', scroll, { passive: true });
		this.offs.push(offLayout, offFrame, () => {
			ro.disconnect();
			cancelAnimationFrame(raf);
			this.board.removeEventListener('pointerdown', down);
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('pointercancel', up);
			window.removeEventListener('click', click, true);
			window.removeEventListener('keydown', key);
			window.removeEventListener('blur', blur);
			this.board.removeEventListener('dragstart', dragstart);
			window.removeEventListener('scroll', scroll);
		});
		this.measure();
	}

	destroy(): void {
		for (const off of this.offs) off();
		for (const e of this.entries) {
			e.el.style.transform = '';
			this.world.destroyBody(e.body);
		}
		// 描いた線・ペグを残さない（island が作り直されたときに増殖させない）
		this.svgEl.replaceChildren();
		this.entries = [];
		this.preview = null;
	}

	// ---- 測る ----

	private boardRect(): DOMRect {
		return this.board.getBoundingClientRect();
	}

	/** 吊るものを測り直す。吊り方が変わらない札は、揺れと挿し替えたペグを引き継ぐ */
	private measure(): void {
		const old = new Map(this.entries.map((e) => [e.el, e]));
		// 動かしたままでは静止位置を測れないので、いったん外す
		for (const e of this.entries) e.el.style.transform = '';
		const b = this.boardRect();
		this.grid = gridFor(b.width);
		const g = this.grid;
		const s = this.svgEl;
		s.setAttribute('width', String(b.width));
		s.setAttribute('height', String(this.board.scrollHeight));
		if (!this.preview) {
			this.preview = svg('circle', { r: g.peg, fill: 'none', stroke: 'var(--color-ink)', 'stroke-width': 1.5, 'stroke-dasharray': '2 2' }, s);
			this.preview.style.display = 'none';
		}
		// ページの下端と左右の端（棚からこぼれたものの最後の受け止め）
		this.world.setBounds(b.width, this.board.scrollHeight);

		const next: Entry[] = [];
		for (const el of this.board.querySelectorAll<HTMLElement>('[data-hang]')) {
			// 表示されていない要素（スマホで隠したナビなど）は吊らない
			if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') continue;
			const r = el.getBoundingClientRect();
			if (r.width === 0 || r.height === 0) continue;
			const top = r.top - b.top;
			const left = r.left - b.left;
			const kind: Entry['kind'] = el.dataset.hangKind === 'ring' ? 'ring' : 'grommet';
			const holeY = kind === 'ring' ? top + 2 : top + GROMMET_OFFSET;
			const pegY = el.dataset.hangPeg ? snapYAbove(g, Number(el.dataset.hangPeg)) : snapYAbove(g, top - MIN_DROP);
			const fr = (el.dataset.hang ?? '0.5').split(',').map(Number);
			const pegs = fr.map((f) => ({ x: snapX(g, left + r.width * f), y: pegY }));
			const home = { x: left + r.width / 2, y: top + r.height / 2, w: r.width, h: r.height };
			const holes = pegs.map((p) => ({ x: p.x - home.x, y: holeY - home.y }));
			const sig = `${pegs.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')} ${home.x.toFixed(1)},${home.y.toFixed(1)} ${home.w.toFixed(0)}x${home.h.toFixed(0)}`;
			const prev = old.get(el);
			old.delete(el);
			let entry: Entry;
			if (prev && prev.sig === sig) {
				// 同じ吊り方：物体もペグもそのまま使う（色だけ測り直す。線は作り直すこともあるので一度描く）
				entry = { ...prev, lit: el.dataset.hangLit, kind, rest: false };
			} else {
				// 前からあった札が動いた（絞り込みで並びが変わったなど）なら、いまの姿勢と速さを引き継ぐ
				const carry = prev
					? { pos: toPx(prev.body.getPosition()), angle: prev.body.getAngle(), v: prev.body.getLinearVelocity(), w: prev.body.getAngularVelocity() }
					: null;
				if (prev) this.dispose(prev);
				const body = this.world.createPanel(home, r.width, r.height, { kind: 'panel', el });
				const lengths = pegs.map((p) => holeY - p.y);
				let start = lengths;
				if (carry) {
					// 前の場所から、新しいペグに引かれて揺れながら移る
					body.setTransform(toM(carry.pos), carry.angle);
					body.setLinearVelocity(carry.v);
					body.setAngularVelocity(carry.w);
				} else if (this.ready && !el.hasAttribute('data-shelf') && !reducedMotion()) {
					// 初めて出てくる札は、上から斜めに傾いて勢いよく落ちてきて、ワイヤーに受け止められる
					const side = (Math.random() - 0.5) * 120;
					const lift = 180 + Math.random() * 120;
					const tilt = (Math.random() < 0.5 ? -1 : 1) * (0.22 + Math.random() * 0.25);
					body.setTransform(toM({ x: home.x + side, y: home.y - lift }), tilt);
					body.setLinearVelocity({ x: -side * 2.2 / SCALE, y: 260 / SCALE });
					body.setAngularVelocity(-tilt * 4);
				}
				if (carry || (this.ready && !el.hasAttribute('data-shelf'))) {
					// ワイヤーはいまの距離より少し長くしておき（たるんで受け止める）、beforeStep で元の長さへ巻き戻す
					start = holes.map((h, i) => {
						const w = toPx(body.getWorldPoint(toM(h)));
						return Math.max(lengths[i], Math.hypot(w.x - pegs[i].x, w.y - pegs[i].y) + 30);
					});
				}
				const ropes = pegs.map((p, i) => this.world.createRope(body, p, holes[i], start[i]));
				const ends = pegs.map((p) => ({ x: p.x, y: holeY }));
				const cables = pegs.map((p, i) => {
					const end = ends[i];
					return wireCable(() => p, () => end, lengths[i]);
				});
				entry = {
					el,
					body,
					home,
					holes,
					pegs,
					lengths,
					cur: [...start],
					free: false,
					ropes,
					cables,
					ends,
					rest: false,
					kind,
					lit: el.dataset.hangLit,
					sig,
					dir: next.length % 2 === 0 ? 1 : -1,
					g: svg('g', { 'data-hang-g': '' }, s),
					wireEls: [],
					endEls: [],
					pegEls: [],
					pegHits: [],
				};
				// ホバーの仕掛けは要素に 1 度だけ付ける（作り直すたびに増やさない）
				if (!prev) this.bindHover(entry);
			}
			this.draw(entry, prev && prev.sig === sig ? prev : undefined);
			next.push(entry);
		}
		// 消えた要素の物体と線を片づける
		for (const e of old.values()) this.dispose(e);
		this.entries = next;
		// 静止した位置で最初から重なっている札どうしは押し合わせない
		for (let i = 0; i < next.length; i++) {
			for (let j = i + 1; j < next.length; j++) {
				const a = next[i].home;
				const c = next[j].home;
				if (Math.abs(a.x - c.x) < (a.w + c.w) / 2 && Math.abs(a.y - c.y) < (a.h + c.h) / 2) this.world.ignorePair(next[i].body, next[j].body);
			}
		}
		// つかんでいる札・ペグは、作り直した項目に付け替える（測り直しでつかみが切れないように）
		const remap = (e: Entry) => next.find((x) => x.el === e.el) ?? null;
		if (this.held) {
			const e = remap(this.held.entry);
			this.held = e ? { ...this.held, entry: e } : null;
			if (!e) this.world.release();
		}
		if (this.pending) {
			const e = remap(this.pending.entry);
			this.pending = e ? { ...this.pending, entry: e } : null;
		}
		if (this.pegDrag) {
			const e = remap(this.pegDrag.entry);
			this.pegDrag = e ? { ...this.pegDrag, entry: e } : null;
		}
		if (this.pegSelected) {
			const e = remap(this.pegSelected.entry);
			this.pegSelected = e ? { ...this.pegSelected, entry: e } : null;
		}
		this.ready = true;
		this.render();
		this.world.kick();
	}

	private dispose(e: Entry): void {
		for (const r of e.ropes) this.world.destroyJoint(r);
		this.world.destroyBody(e.body);
		e.g.remove();
		e.el.style.transform = '';
	}

	/** 線・ペグ・孔の SVG を作る（形は render で毎フレーム書き換える）。色が変わったときも作り直す */
	private draw(e: Entry, prev: Entry | undefined): void {
		const g = this.grid;
		if (prev && prev.lit === e.lit && prev.wireEls.length) return;
		const parent = e.g;
		parent.replaceChildren();
		e.wireEls = [];
		e.endEls = [];
		e.pegEls = [];
		e.pegHits = [];
		e.pegs.forEach((p, i) => {
			e.wireEls.push(svg('path', { fill: 'none', stroke: 'var(--color-wire)', 'stroke-width': g.wire, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'data-hook': 'wire' }, parent));
			e.pegEls.push(svg('circle', { cx: p.x, cy: p.y, r: g.peg / 2, fill: e.lit ?? 'var(--color-peg)', stroke: 'var(--color-peg)', 'stroke-width': 1.5, 'data-hook': 'peg' }, parent));
			e.endEls.push(
				e.kind === 'grommet'
					? svg('circle', { r: g.grommet / 2, fill: 'var(--color-board)', stroke: 'var(--color-ink)', 'stroke-width': 1.5, 'data-hook': 'end' }, parent)
					: svg('circle', { r: 3, fill: 'none', stroke: 'var(--color-wire)', 'stroke-width': 1.4, 'data-hook': 'end' }, parent),
			);
			// ペグの当たり：指でも押しやすいよう大きめ。押すとペグを挿し替えられる
			const hit = svg('circle', { cx: p.x, cy: p.y, r: Math.max(12, g.step * 0.4), fill: 'transparent' }, parent);
			hit.style.pointerEvents = 'all';
			hit.style.cursor = 'grab';
			hit.style.touchAction = 'none';
			hit.addEventListener('pointerdown', (ev) => this.onPegDown(e.el, i, ev));
			hit.addEventListener('pointerenter', () => this.hover(e.el, true));
			hit.addEventListener('pointerleave', () => this.hover(e.el, false));
			e.pegHits.push(hit);
		});
	}

	/** ホバーで、その札のペグ・ワイヤー・孔を目立たせる */
	private bindHover(e: Entry): void {
		e.el.addEventListener('pointerenter', (ev) => {
			if (ev.pointerType !== 'touch') this.hover(e.el, true);
		});
		e.el.addEventListener('pointerleave', () => this.hover(e.el, false));
	}

	private hover(el: HTMLElement, on: boolean): void {
		this.entries.find((x) => x.el === el)?.g.classList.toggle('hook-hover', on);
	}

	// ---- 操作 ----

	private toBoard(e: { clientX: number; clientY: number }): Pt {
		const b = this.boardRect();
		return { x: e.clientX - b.left, y: e.clientY - b.top };
	}

	/** いちばん近い板の孔 */
	private nearestHole(p: Pt): Pt {
		const g = this.grid;
		return {
			x: Math.round((p.x - g.ox) / g.step) * g.step + g.ox,
			y: Math.round((p.y - g.oy) / g.step) * g.step + g.oy,
		};
	}

	private onPegDown(el: HTMLElement, index: number, ev: PointerEvent): void {
		if (ev.button !== 0) return;
		const entry = this.entries.find((x) => x.el === el);
		if (!entry) return;
		ev.preventDefault();
		ev.stopPropagation();
		this.pegDrag = { entry, index, id: ev.pointerId, x: ev.clientX, y: ev.clientY, moved: false };
	}

	/** ペグを p へ挿し替える。ワイヤーの長さはそのまま。高さが違えば札は傾いて吊られる */
	private movePeg(e: Entry, index: number, p: Pt): void {
		const old = e.ropes[index];
		if (!old) return;
		this.world.destroyJoint(old);
		e.ropes[index] = this.world.createRope(e.body, p, e.holes[index], e.free ? 100000 : e.cur[index]);
		// 描くためのワイヤーはこの点を参照しているので、同じ点を書き換える
		e.pegs[index].x = p.x;
		e.pegs[index].y = p.y;
		e.body.setAwake(true);
		e.pegEls[index]?.setAttribute('cx', String(p.x));
		e.pegEls[index]?.setAttribute('cy', String(p.y));
		e.pegHits[index]?.setAttribute('cx', String(p.x));
		e.pegHits[index]?.setAttribute('cy', String(p.y));
		this.world.kick();
	}

	private selectPeg(sel: { entry: Entry; index: number } | null): void {
		this.pegSelected = sel;
		for (const e of this.entries) e.g.classList.toggle('hook-selected', !!sel && sel.entry.el === e.el);
		if (this.preview) this.preview.style.display = 'none';
	}

	private onDown(e: PointerEvent): void {
		if (e.button !== 0) return;
		// pointerup を取りこぼして掴んだままになっていたら、ここで解く
		if (this.held) this.releaseAll();
		// ペグを選んでいるときは、押した所にいちばん近い孔へ挿し替える（タップ→タップ）
		if (this.pegSelected) {
			const t = e.target as Element | null;
			if (t?.closest('a, button, input, select, textarea')) return;
			// 札の上を押したときは、選ぶのをやめて、その札をつかみ直す
			if (!t?.closest('[data-hang]')) {
				const { entry, index } = this.pegSelected;
				this.movePeg(entry, index, this.nearestHole(this.toBoard(e)));
				this.selectPeg(null);
				this.suppressClick = true;
				setTimeout(() => (this.suppressClick = false), 0);
				e.preventDefault();
				return;
			}
			this.selectPeg(null);
		}
		if (e.pointerType === 'touch') return;
		const t = e.target as Element | null;
		if (!t || t.closest(NO_DRAG)) return;
		const el = t.closest<HTMLElement>('[data-hang]');
		const entry = el && this.entries.find((x) => x.el === el);
		if (!entry) return;
		this.pending = { entry, id: e.pointerId, x: e.clientX, y: e.clientY };
	}

	/** ドラッグ・ペグ選びの状態をすべて解く（取りこぼしの後始末） */
	private releaseAll(): void {
		this.ptr = null;
		if (this.held) this.world.release();
		this.held = null;
		this.pending = null;
		this.pegDrag = null;
		this.selectPeg(null);
		document.documentElement.style.userSelect = '';
		document.documentElement.style.cursor = '';
	}

	private onMove(e: PointerEvent): void {
		// マウスでなでたワイヤーを揺らす
		if (e.pointerType !== 'touch') {
			this.ptr = this.toBoard(e);
			this.world.kick();
		}
		const pd = this.pegDrag;
		if (pd && pd.id === e.pointerId) {
			if (!pd.moved && Math.hypot(e.clientX - pd.x, e.clientY - pd.y) > DRAG_THRESHOLD) {
				pd.moved = true;
				this.selectPeg(null);
				document.documentElement.style.cursor = 'grabbing';
			}
			if (pd.moved) {
				// ペグは指についてくる（札も引っぱられる）。挿さる先の孔を輪で見せる
				const p = this.toBoard(e);
				this.movePeg(pd.entry, pd.index, p);
				const h = this.nearestHole(p);
				if (this.preview) {
					this.preview.setAttribute('cx', String(h.x));
					this.preview.setAttribute('cy', String(h.y));
					this.preview.style.display = '';
				}
			}
			return;
		}
		const p = this.pending;
		if (p && p.id === e.pointerId && Math.hypot(e.clientX - p.x, e.clientY - p.y) > DRAG_THRESHOLD) {
			this.pending = null;
			// 押した瞬間に指の下にあった点をつかむ
			this.world.grab(p.entry.body, this.toBoard({ clientX: p.x, clientY: p.y }));
			this.held = { entry: p.entry, id: p.id };
			document.documentElement.style.userSelect = 'none';
			document.documentElement.style.cursor = 'grabbing';
			window.getSelection()?.removeAllRanges();
		}
		if (this.held && this.held.id === e.pointerId) this.world.drag(this.toBoard(e));
	}

	private onUp(e: PointerEvent): void {
		const pd = this.pegDrag;
		if (pd && pd.id === e.pointerId) {
			this.pegDrag = null;
			document.documentElement.style.cursor = '';
			if (pd.moved) {
				// 離した所にいちばん近い孔へ挿す
				this.movePeg(pd.entry, pd.index, this.nearestHole(this.toBoard(e)));
				if (this.preview) this.preview.style.display = 'none';
			} else {
				// 動かさずに離した＝タップ。ペグを選ぶ／やめる
				const same = this.pegSelected?.entry.el === pd.entry.el && this.pegSelected.index === pd.index;
				this.selectPeg(same ? null : { entry: pd.entry, index: pd.index });
			}
			return;
		}
		if (this.pending?.id === e.pointerId) this.pending = null;
		const h = this.held;
		if (!h || h.id !== e.pointerId) return;
		this.held = null;
		this.world.release();
		document.documentElement.style.userSelect = '';
		document.documentElement.style.cursor = '';
		// ドラッグのあとの click は、リンクやカードを開かない
		this.suppressClick = true;
		setTimeout(() => (this.suppressClick = false), 0);
	}

	/** スクロールの量に応じて、ごくわずかに左右へ振る（気づくか気づかないか程度） */
	private onScroll(): void {
		const y = window.scrollY;
		const dy = y - this.lastScroll;
		this.lastScroll = y;
		if (!dy || reducedMotion()) return;
		const vh = window.innerHeight;
		const b = this.boardRect();
		const v = Math.min(Math.abs(dy) * 0.3, 18) / SCALE;
		for (const e of this.entries) {
			const top = e.home.y + b.top;
			if (top < -vh || top > vh * 2) continue;
			const cur = e.body.getLinearVelocity();
			e.body.setLinearVelocity({ x: cur.x + e.dir * v, y: cur.y });
			e.body.setAwake(true);
		}
		this.world.kick();
	}

	// ---- 時間を進める ----

	/**
	 * 物理の刻みの前：つかんでいる札のワイヤーは引っぱり合わないよう伸ばす（ib/mobile.js と同じ手触り）。
	 * 離したら、元の長さへ少しずつ巻き戻す（戻りながら揺れる）
	 */
	private beforeStep(dt: number): void {
		const held = this.held?.entry.el;
		for (const e of this.entries) {
			const holding = e.el === held;
			// 吊られたまま元の長さに戻っている札は、何もしない（毎刻み、全部の札の孔を測らない）
			if (!holding && !e.free && e.cur.every((c, i) => c <= e.lengths[i])) continue;
			e.ropes.forEach((rope, i) => {
				const L = e.lengths[i];
				const w = toPx(e.body.getWorldPoint(toM(e.holes[i])));
				const d = Math.hypot(w.x - e.pegs[i].x, w.y - e.pegs[i].y);
				if (holding) {
					// つかんでいるあいだはロープで引かない（どれだけ速く引いても、ぐいっと伸びる）。長さは見た目と巻き戻しのために覚えておく
					if (!e.free) rope.setMaxLength(100000 / SCALE);
					e.cur[i] = Math.max(L, d);
				} else if (e.free || e.cur[i] > L) {
					// 離したら、いまの長さから元の長さへ巻き戻す（戻りながら揺れる）
					const base = Math.min(e.cur[i], d + 1);
					e.cur[i] = Math.max(L, base + (L - base) * (1 - Math.exp(-5 * dt)) - 40 * dt);
					rope.setMaxLength(e.cur[i] / SCALE);
					e.body.setAwake(true);
				}
			});
			e.free = holding;
		}
	}

	/** 物理の刻みのあと：札を動かし、ワイヤーを描く。ワイヤーの見た目が揺れているあいだは true */
	private render(): boolean {
		let busy = this.pegDrag !== null;
		const ptr = this.ptr;
		for (const e of this.entries) {
			const reeling = e.cur.some((c, i) => c > e.lengths[i]);
			if (reeling) busy = true;
			// 止まっている札（物体が眠り、前のフレームでワイヤーの見た目も止まっていた）は、
			// 指が近くになければ描き直さない。札の数が多くても、1 フレームの仕事が増えないように
			if (e.rest && !reeling && !e.body.isAwake() && !(ptr && nearWires(e, ptr))) continue;
			let moving = e.body.isAwake() || reeling;
			const pos = toPx(e.body.getPosition());
			const a = e.body.getAngle();
			const dx = pos.x - e.home.x;
			const dy = pos.y - e.home.y;
			// レイアウト上の位置のまま傾いてもいなければ、何も書かない
			// （先に書くと、あとから hydrate する island（WorksBoard）と HTML が食い違う）
			// ロープ関節には 0.25px ほどの許し（linearSlop）があるので、それより少し大きいずれまでは「動いていない」とみなす
			const still = Math.abs(dx) < 0.6 && Math.abs(dy) < 0.6 && Math.abs(a) < 0.002;
			const t = still ? '' : `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px) rotate(${a.toFixed(4)}rad)`;
			if (e.el.style.transform !== t) e.el.style.transform = t;
			e.holes.forEach((h, i) => {
				const w = toPx(e.body.getWorldPoint(toM(h)));
				const end = e.ends[i];
				end.x = w.x;
				end.y = w.y;
				const c = e.cables[i];
				// 描くためのワイヤー：少したるませ、揺れが波になって走る。マウスでなでると揺れる
				if (stepWire(c, e.cur[i], ptr)) {
					busy = true;
					moving = true;
				}
				e.wireEls[i]?.setAttribute('d', c.path());
				const endEl = e.endEls[i];
				if (endEl) {
					endEl.setAttribute('cx', w.x.toFixed(2));
					endEl.setAttribute('cy', (e.kind === 'ring' ? w.y - 3 : w.y).toFixed(2));
				}
			});
			e.rest = !moving;
		}
		return busy;
	}
}

/** なでるとワイヤーが揺れる距離（ワイヤーのたるみと、押しのける半径の分の余裕） */
const NEAR_WIRE = 40;

/** 点 p が、札のワイヤー（ペグと孔を囲む範囲）の近くにあるか */
function nearWires(e: Entry, p: Pt): boolean {
	for (let i = 0; i < e.pegs.length; i++) {
		const a = e.pegs[i];
		const b = e.ends[i];
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

export default function HangLayer() {
	const svgRef = useRef<SVGSVGElement>(null);

	useEffect(() => {
		const el = svgRef.current;
		const board = el?.closest<HTMLElement>('[data-board]');
		if (!el || !board) return;
		const scene = new HangScene(el, board);
		scene.init();
		return () => scene.destroy();
	}, []);

	return <svg ref={svgRef} aria-hidden="true" className="pointer-events-none absolute top-0 left-0 z-10" width={0} height={0} />;
}
