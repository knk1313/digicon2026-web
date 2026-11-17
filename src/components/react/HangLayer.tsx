// data-hang の付いた要素（札・カード・ナビなど）を、板の孔のペグからワイヤーで吊る層。
// 見た目だけでなく、要素そのものを物理で動かす（引継ぎ資料のデモ集の ib/mobile.js と A4「降りてくる部品」）。
// ・マウス・ペンでつかんで動かせる。つかんだ点は指の真下。離すと揺れながら戻る
// ・6px 以上動かしたらドラッグとみなし、続く click（リンク・カードを開く）は起こさない
// ・札どうし、つままれたタイトルの文字とはぶつかる（押された札はワイヤーが伸びて押しのけられる）
// ・ペグはつまんで別の孔へ挿し替えられる（ドラッグか、ペグを押してから行き先の孔を押す）。札はワイヤーの長さのまま新しいペグの下へ揺れて移る
// ・ホバーすると、その札のペグ・ワイヤー・孔が少し目立つ（どこで吊られているかの手がかり）
// ・スクロールでは、ごくわずかに左右へ振れる（動きを減らす設定では揺らさない）
// ・タッチでは札をつかまない（ページのスクロールを妨げないため）。ペグの挿し替えはタッチでもできる
// ・端子や入力欄など、data-no-drag の中からはつかまない
// 物理と描画は React の外で回す。React は SVG の器を置くだけ
import { useEffect, useRef } from 'react';
import { GROMMET_OFFSET, MIN_DROP, gridFor, snapX, snapYAbove, type BoardGrid } from '../../lib/board';
import { EVENTS, on } from '../../lib/events';
import type { Pt } from '../../lib/physics/cable';
import { collide, constrain, createBody, nudge, rectNow, restBody, restingOverlaps, stepBody, syncEnds, type HungBody } from '../../lib/physics/hung';
import { draggedLetters, onLettersDragged, panels, panelsMoved } from '../../lib/physics/shared';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** つかまない要素 */
const NO_DRAG = '[data-no-drag], [data-jack], input, textarea, select, [contenteditable]';
/** これより動いたら、クリックではなくドラッグとみなす */
const DRAG_THRESHOLD = 6;
/** これだけ静かなフレームが続いたら止める */
const SLEEP_FRAMES = 40;

interface Entry {
	el: HTMLElement;
	/** 回す中心（transform-origin） */
	origin: string;
	body: HungBody;
	kind: 'grommet' | 'ring';
	lit?: string;
	/** 吊りの位置を決めた値（同じなら、測り直しても揺れを引き継ぐ） */
	sig: string;
	/** スクロールで揺れる向き（札ごとに左右を変える） */
	dir: number;
	g: SVGGElement;
	wires: SVGPathElement[];
	ends: SVGCircleElement[];
	pegs: SVGCircleElement[];
	/** ペグをつまむための当たり */
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
	/** 静止した位置で最初から重なっている組（押し合わせない） */
	private ignore = new Set<string>();
	private grid: BoardGrid = gridFor(1440);
	private frame = 0;
	private lastScroll = window.scrollY;
	private pending: { entry: Entry; id: number; x: number; y: number } | null = null;
	private held: { entry: Entry; id: number; g: Pt; ptr: Pt } | null = null;
	private pegDrag: PegDrag | null = null;
	/** タップで選んだペグ（次に押した孔へ挿し替える） */
	private pegSelected: { entry: Entry; index: number } | null = null;
	/** 挿し替え先の下見（孔の輪） */
	private preview!: SVGCircleElement;
	private suppressClick = false;
	private offs: (() => void)[] = [];

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
		// つままれた文字が札に当たったら、札を動かす
		const offLetters = onLettersDragged(() => this.start());
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
		const scroll = () => this.start();
		this.board.addEventListener('pointerdown', down);
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('pointercancel', up);
		window.addEventListener('click', click, true);
		window.addEventListener('keydown', key);
		this.board.addEventListener('dragstart', dragstart);
		window.addEventListener('scroll', scroll, { passive: true });
		this.offs.push(offLayout, offLetters, () => {
			ro.disconnect();
			cancelAnimationFrame(raf);
			this.board.removeEventListener('pointerdown', down);
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('pointercancel', up);
			window.removeEventListener('click', click, true);
			window.removeEventListener('keydown', key);
			this.board.removeEventListener('dragstart', dragstart);
			window.removeEventListener('scroll', scroll);
		});
		this.measure();
	}

	destroy(): void {
		cancelAnimationFrame(this.frame);
		for (const off of this.offs) off();
		for (const e of this.entries) {
			e.el.style.transform = '';
			panels.delete(e.el);
		}
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
			const holes = pegs.map((p) => ({ x: p.x, y: holeY }));
			const sig = [...pegs, ...holes].map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
			const prev = old.get(el);
			old.delete(el);
			const rect = { x: left, y: top, w: r.width, h: r.height };
			const body = prev && prev.sig === sig ? prev.body : createBody(holes, pegs, rect);
			// 高さだけ変わった（カードの中身が変わったなど）ときも、外形は測り直す
			body.rect = rect;
			const entry: Entry = {
				el,
				// 回す中心は最初の吊られる側の孔（糸と札がずれない）。当てるのは動かすときだけ
				// （先に書くと、あとから hydrate する island（WorksBoard）と HTML が食い違う）
				origin: `${(holes[0].x - left).toFixed(1)}px ${(holes[0].y - top).toFixed(1)}px`,
				body,
				kind,
				lit: el.dataset.hangLit,
				sig,
				dir: prev?.dir ?? (next.length % 2 === 0 ? 1 : -1),
				g: prev?.g ?? svg('g', { 'data-hang-g': '' }, s),
				wires: [],
				ends: [],
				pegs: [],
				pegHits: [],
			};
			this.draw(entry, prev);
			this.bindHover(entry, prev);
			next.push(entry);
		}
		// 消えた要素の線を片づける
		for (const e of old.values()) {
			e.g.remove();
			e.el.style.transform = '';
			panels.delete(e.el);
		}
		this.entries = next;
		this.ignore = restingOverlaps(next.map((e) => e.body));
		// つかんでいる札・ペグは、作り直した項目に付け替える（測り直しでつかみが切れないように）
		const remap = (e: Entry) => next.find((x) => x.el === e.el) ?? null;
		if (this.held) {
			const e = remap(this.held.entry);
			this.held = e ? { ...this.held, entry: e } : null;
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
		this.render();
		this.start();
	}

	/** 線・ペグ・孔の SVG を作り直す（形は render で毎フレーム書き換える） */
	private draw(e: Entry, prev: Entry | undefined): void {
		const g = this.grid;
		const parent = e.g;
		if (prev && prev.sig === e.sig && prev.lit === e.lit && prev.kind === e.kind) {
			e.wires = prev.wires;
			e.ends = prev.ends;
			e.pegs = prev.pegs;
			e.pegHits = prev.pegHits;
			return;
		}
		parent.replaceChildren();
		e.body.strings.forEach((s, i) => {
			e.wires.push(svg('path', { fill: 'none', stroke: 'var(--color-wire)', 'stroke-width': g.wire, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'data-hook': 'wire' }, parent));
			e.pegs.push(svg('circle', { cx: s.a.x, cy: s.a.y, r: g.peg / 2, fill: e.lit ?? 'var(--color-peg)', stroke: 'var(--color-peg)', 'stroke-width': 1.5, 'data-hook': 'peg' }, parent));
			e.ends.push(
				e.kind === 'grommet'
					? svg('circle', { r: g.grommet / 2, fill: 'var(--color-board)', stroke: 'var(--color-ink)', 'stroke-width': 1.5, 'data-hook': 'end' }, parent)
					: svg('circle', { r: 3, fill: 'none', stroke: 'var(--color-wire)', 'stroke-width': 1.4, 'data-hook': 'end' }, parent),
			);
			// ペグの当たり：指でも押しやすいよう大きめ。押すとペグを挿し替えられる
			const hit = svg('circle', { cx: s.a.x, cy: s.a.y, r: Math.max(12, g.step * 0.4), fill: 'transparent' }, parent);
			hit.style.pointerEvents = 'all';
			hit.style.cursor = 'grab';
			hit.style.touchAction = 'none';
			hit.setAttribute('aria-hidden', 'true');
			hit.addEventListener('pointerdown', (ev) => this.onPegDown(e, i, ev));
			hit.addEventListener('pointerenter', () => this.hover(e, true));
			hit.addEventListener('pointerleave', () => this.hover(e, false));
			e.pegHits.push(hit);
		});
	}

	/** ホバーで、その札のペグ・ワイヤー・孔を目立たせる */
	private bindHover(e: Entry, prev: Entry | undefined): void {
		if (prev && prev.el === e.el) return;
		e.el.addEventListener('pointerenter', (ev) => {
			if (ev.pointerType !== 'touch') this.hover(e, true);
		});
		e.el.addEventListener('pointerleave', () => this.hover(e, false));
	}

	private hover(e: Entry, on: boolean): void {
		// 測り直しで項目が作り直されていても、同じ要素の今の項目に付ける
		const cur = this.entries.find((x) => x.el === e.el) ?? e;
		cur.g.classList.toggle('hook-hover', on);
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

	private onPegDown(e: Entry, index: number, ev: PointerEvent): void {
		if (ev.button !== 0) return;
		ev.preventDefault();
		ev.stopPropagation();
		// 選んだペグがあれば、その札のペグを押したことになっても、選び直しとして扱う
		this.pegDrag = { entry: e, index, id: ev.pointerId, x: ev.clientX, y: ev.clientY, moved: false };
	}

	/** ペグを孔 p へ挿し替える。札はワイヤーの長さのまま、新しいペグの下へ揺れて移る */
	private movePeg(e: Entry, index: number, p: Pt): void {
		const s = e.body.strings[index];
		if (!s) return;
		s.a.x = p.x;
		s.a.y = p.y;
		e.body.quiet = 0;
		e.pegs[index]?.setAttribute('cx', String(p.x));
		e.pegs[index]?.setAttribute('cy', String(p.y));
		e.pegHits[index]?.setAttribute('cx', String(p.x));
		e.pegHits[index]?.setAttribute('cy', String(p.y));
		this.start();
	}

	private selectPeg(sel: { entry: Entry; index: number } | null): void {
		this.pegSelected = sel;
		for (const e of this.entries) e.g.classList.toggle('hook-selected', !!sel && sel.entry.el === e.el);
		this.preview.style.display = 'none';
	}

	private onDown(e: PointerEvent): void {
		if (e.button !== 0 || this.held) return;
		// ペグを選んでいるときは、押した所にいちばん近い孔へ挿し替える（タップ→タップ）
		if (this.pegSelected) {
			const t = e.target as Element | null;
			if (t?.closest('a, button, input, select, textarea')) return;
			const { entry, index } = this.pegSelected;
			this.movePeg(entry, index, this.nearestHole(this.toBoard(e)));
			this.selectPeg(null);
			this.suppressClick = true;
			setTimeout(() => (this.suppressClick = false), 0);
			e.preventDefault();
			return;
		}
		if (e.pointerType === 'touch') return;
		const t = e.target as Element | null;
		if (!t || t.closest(NO_DRAG)) return;
		const el = t.closest<HTMLElement>('[data-hang]');
		const entry = el && this.entries.find((x) => x.el === el);
		if (!entry) return;
		this.pending = { entry, id: e.pointerId, x: e.clientX, y: e.clientY };
	}

	private onMove(e: PointerEvent): void {
		const pd = this.pegDrag;
		if (pd && pd.id === e.pointerId) {
			if (!pd.moved && Math.hypot(e.clientX - pd.x, e.clientY - pd.y) > DRAG_THRESHOLD) {
				pd.moved = true;
				this.selectPeg(null);
				document.documentElement.style.cursor = 'grabbing';
			}
			if (pd.moved) {
				// ペグは指についてくる。挿さる先の孔を輪で見せる
				const p = this.toBoard(e);
				this.movePeg(pd.entry, pd.index, p);
				const h = this.nearestHole(p);
				this.preview.setAttribute('cx', String(h.x));
				this.preview.setAttribute('cy', String(h.y));
				this.preview.style.display = '';
			}
			return;
		}
		const p = this.pending;
		if (p && p.id === e.pointerId && Math.hypot(e.clientX - p.x, e.clientY - p.y) > DRAG_THRESHOLD) {
			this.pending = null;
			// つかんだ点（押した瞬間の点）と札の原点のずれを覚え、以後その点を指の真下に置く
			const down = this.toBoard({ clientX: p.x, clientY: p.y });
			const body = p.entry.body;
			this.held = { entry: p.entry, id: p.id, g: { x: down.x - body.pos.x, y: down.y - body.pos.y }, ptr: this.toBoard(e) };
			document.documentElement.style.userSelect = 'none';
			document.documentElement.style.cursor = 'grabbing';
			window.getSelection()?.removeAllRanges();
		}
		const h = this.held;
		if (h && h.id === e.pointerId) {
			h.ptr = this.toBoard(e);
			this.start();
		}
	}

	private onUp(e: PointerEvent): void {
		const pd = this.pegDrag;
		if (pd && pd.id === e.pointerId) {
			this.pegDrag = null;
			document.documentElement.style.cursor = '';
			if (pd.moved) {
				// 離した所にいちばん近い孔へ挿す
				this.movePeg(pd.entry, pd.index, this.nearestHole(this.toBoard(e)));
				this.preview.style.display = 'none';
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
		document.documentElement.style.userSelect = '';
		document.documentElement.style.cursor = '';
		// ドラッグのあとの click は、リンクやカードを開かない
		this.suppressClick = true;
		setTimeout(() => (this.suppressClick = false), 0);
		this.start();
	}

	// ---- 時間を進める ----

	private start(): void {
		if (this.frame) return;
		this.frame = requestAnimationFrame(this.tick);
	}

	/** つままれた文字に重なっている札を、文字の外へ押し出す */
	private pushByLetters(): void {
		if (draggedLetters.length === 0) return;
		for (const e of this.entries) {
			const r = rectNow(e.body);
			if (!r) continue;
			for (const l of draggedLetters) {
				const ox = Math.min(r.x + r.w, l.x + l.w) - Math.max(r.x, l.x);
				const oy = Math.min(r.y + r.h, l.y + l.h) - Math.max(r.y, l.y);
				if (ox <= 0 || oy <= 0) continue;
				const b = e.body;
				if (ox < oy) {
					const d = (r.x + r.w / 2 < l.x + l.w / 2 ? -1 : 1) * ox;
					b.pos.x += d;
					b.prev.x += d * 0.5;
				} else {
					const d = (r.y + r.h / 2 < l.y + l.h / 2 ? -1 : 1) * oy;
					b.pos.y += d;
					b.prev.y += d * 0.5;
				}
				b.pushed = 12;
				b.quiet = 0;
			}
		}
	}

	private tick = (): void => {
		this.frame = 0;
		// スクロールの量に応じて、ごくわずかに左右へ振れる（気づくか気づかないか程度）
		const y = window.scrollY;
		const dy = y - this.lastScroll;
		this.lastScroll = y;
		if (dy !== 0 && !reducedMotion()) {
			const vh = window.innerHeight;
			const b = this.boardRect();
			for (const e of this.entries) {
				const top = e.body.home.y + b.top;
				if (top < -vh || top > vh * 2) continue;
				nudge(e.body, e.dir * Math.min(Math.abs(dy) * 0.006, 0.35), 0);
			}
		}
		const heldBody = this.held?.entry.body ?? null;
		const isAwake = (b: HungBody) => b === heldBody || b.quiet <= SLEEP_FRAMES;
		for (const e of this.entries) {
			const held = this.held?.entry === e ? { x: this.held.ptr.x - this.held.g.x, y: this.held.ptr.y - this.held.g.y } : null;
			if (!held && e.body.quiet > SLEEP_FRAMES) continue;
			stepBody(e.body, held);
		}
		// 札どうし・つままれた文字との重なりを押し出す。押された札は糸がやわらかく伸びるので、重なりの解消を最後にして見た目では重ねない
		const bodies = this.entries.map((e) => e.body);
		let awake = draggedLetters.length > 0 || this.pegDrag !== null;
		for (const b of bodies) if (b !== heldBody && b.quiet <= SLEEP_FRAMES && b.pushed === 0) constrain(b);
		this.pushByLetters();
		collide(bodies, heldBody, isAwake, this.ignore);
		let moved = false;
		for (const b of bodies) {
			syncEnds(b);
			if (b === heldBody) {
				awake = true;
				moved = true;
				continue;
			}
			if (b.quiet > SLEEP_FRAMES) {
				if (b.pos.x !== b.prev.x || b.pos.y !== b.prev.y) restBody(b);
			} else {
				awake = true;
				moved = true;
			}
		}
		this.render();
		// タイトルの文字に、札が動いたことを知らせる（札の上に載った文字が落ち直す）
		if (moved) panelsMoved();
		if (awake || this.held) this.start();
	};

	private render(): void {
		for (const e of this.entries) {
			const b = e.body;
			const dx = b.pos.x - b.home.x;
			const dy = b.pos.y - b.home.y;
			const still = Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01 && Math.abs(b.rot) < 0.0001;
			if (still) {
				if (e.el.style.transform) e.el.style.transform = '';
			} else {
				if (e.el.style.transformOrigin !== e.origin) e.el.style.transformOrigin = e.origin;
				e.el.style.transform = `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px) rotate(${b.rot.toFixed(4)}rad)`;
			}
			const r = rectNow(b);
			if (r) panels.set(e.el, r);
			b.strings.forEach((s, i) => {
				e.wires[i]?.setAttribute('d', s.cable.path());
				const end = e.ends[i];
				if (end) {
					end.setAttribute('cx', s.end.x.toFixed(2));
					end.setAttribute('cy', (e.kind === 'ring' ? s.end.y - 3 : s.end.y).toFixed(2));
				}
			});
		}
	}
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
