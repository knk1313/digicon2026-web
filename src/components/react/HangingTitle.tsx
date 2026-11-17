// 吊られたタイトル「つなぐ、／かわる、／うまれる」（docs/design/rules.md の ①〜③と「結び直す」）。
// 吊られている → statement-closed（first）で一斉に落ちる → 最初の画面の床で止まる →
// つまんで（ドラッグ）か、タップ→タップで板の孔や空のワイヤーへ吊り直す。
// 物理と描画は React の外で回す。React は SVG の器を置くだけで、中身は TitleScene が直接作って動かす
import { useEffect, useRef, useState } from 'react';
import { MOBILE_MAX, gridFor, snapX, snapYAbove, type BoardGrid } from '../../lib/board';
import { EVENTS, on, type StatementClosedDetail } from '../../lib/events';
import { measureSections } from '../../lib/sections';
import { glyphShape, type GlyphShape, type Vec } from '../../lib/physics/glyph';
import { Body, World, type Shape } from '../../lib/physics/body';
import { draggedLetters, lettersDragged, onPanelsMoved, panels } from '../../lib/physics/shared';
import { Rope } from '../../lib/physics/rope';
import { createPendulum, pendulumQuiet, stepPendulum, type Pendulum } from '../../lib/physics/pendulum';

const ROWS = ['つなぐ、', 'かわる、', 'うまれる'];
const LIT = ['var(--color-tsunagu)', 'var(--color-kawaru)', 'var(--color-umareru)'];
/** タイトルを吊るペグの段を探す y（TitleStatic と同じ。PC は 2 段目、スマホは 3 段目に吸着する） */
// ペグは段ごとに、その段の文字のすぐ上の孔の列に置く（段の間隔 dy は孔の格子の 4 つ分なので、どの段もワイヤーの長さがそろう）。
// 環からこれだけ（孔の間隔に対する割合）は離して、それより上でいちばん近い孔の列を選ぶ
const TITLE_PEG_GAP = 0.25;
/** 物理の 1 刻み（秒） */
const H = 1 / 240;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** タイトルの配置。値は docs/design/tokens.md の「タイトルの配置」（TitleStatic と同じ） */
interface TitleLayout {
	x0: number;
	y0: number;
	adv: number;
	roff: number;
	dy: number;
	size: number;
}
const DESKTOP: TitleLayout = { x0: 84, y0: 82, adv: 102, roff: 34, dy: 136, size: 96 };
const MOBILE: TitleLayout = { x0: 20, y0: 92, adv: 66, roff: 22, dy: 88, size: 60 };

/** タイトル用のペグ。文字が吊られていなければ、空のワイヤー（rope）が垂れる */
interface TitlePeg {
	x: number;
	y: number;
	/** 最初に吊っていたワイヤーの長さ */
	length: number;
	letter: Letter | null;
	rope: Rope | null;
	head: SVGCircleElement;
	ropeLine: SVGPathElement;
	ropeRing: SVGEllipseElement;
	/** 空のワイヤーの先をつまむための当たり */
	ropeHit: SVGCircleElement;
}

interface Hang {
	x: number;
	y: number;
	/** ワイヤーの長さ（ペグから吊られる側の環まで） */
	length: number;
	/** 巻き上げ中なら、落ち着く長さ。length をここまで縮める */
	rest?: number;
	pend: Pendulum;
	/** タイトル用のペグに吊っているとき */
	titlePeg: TitlePeg | null;
}

interface Letter {
	ch: string;
	row: number;
	color: string;
	shape: GlyphShape;
	body: Body;
	/** 吊られる側の環の位置（文字の局所座標） */
	ring: Vec;
	hang: Hang | null;
	g: SVGGElement;
	hit: SVGPolygonElement;
	outline: SVGPolygonElement;
	wire: SVGLineElement;
	ringEl: SVGCircleElement;
	/** タイトル以外の孔に吊ったときのペグ */
	peg: SVGCircleElement;
}

/** 吊り先の候補 */
interface Target {
	x: number;
	y: number;
	length: number;
	titlePeg: TitlePeg | null;
}

interface Drag {
	letter: Letter;
	pointerId: number;
	/** つかんだ点（文字の局所座標） */
	grab: Vec;
	/** 最後のポインタの位置（画面座標）。スクロールしても毎フレーム測り直す */
	clientX: number;
	clientY: number;
	/** 投げる速さを出すための履歴 */
	trail: { t: number; x: number; y: number }[];
	target: Target | null;
}

interface Pending {
	letter: Letter;
	pointerId: number;
	x: number;
	y: number;
}

/** 空のワイヤーの先をつまんでいる（ケーブルの側から文字へ伸ばす。引継ぎ資料の B3） */
interface RopeDrag {
	peg: TitlePeg;
	pointerId: number;
	x: number;
	y: number;
	moved: boolean;
}

/** ワイヤーの先を引いているとき、指からこの距離（px）以内の文字を相手にする（ib/tie.js と同じ） */
const NEAR_RADIUS = 46;

type Phase = 'hung' | 'landed';

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, parent?: Element): SVGElementTagNameMap[K] {
	const el = document.createElementNS(SVG_NS, tag);
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
	parent?.appendChild(el);
	return el;
}

/** 札の当たり（長方形）。重心を原点に、内側が辺の左になる向き（body.ts の Shape と同じ約束） */
function rectShape(w: number, h: number): Shape {
	return {
		hull: [
			{ x: -w / 2, y: -h / 2 },
			{ x: w / 2, y: -h / 2 },
			{ x: w / 2, y: h / 2 },
			{ x: -w / 2, y: h / 2 },
		],
		area: w * h,
		inertia: (w * h * (w * w + h * h)) / 12,
		radius: Math.hypot(w, h) / 2,
	};
}

function show(el: SVGElement, visible: boolean): void {
	el.style.display = visible ? '' : 'none';
}

function reducedMotion(): boolean {
	return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

class TitleScene {
	private phase: Phase = 'hung';
	private world: World = new World({ floor: 0, left: 0, right: 0 });
	private letters: Letter[] = [];
	private titlePegs: TitlePeg[] = [];
	private grid: BoardGrid = gridFor(1440);
	private layout: TitleLayout = DESKTOP;
	/** 節の上端と床（SVG の座標） */
	private top = 0;
	private floor = 0;
	private width = 0;
	private frame = 0;
	private last = 0;
	private drag: Drag | null = null;
	private pending: Pending | null = null;
	private selected: Letter | null = null;
	private hover: Target | null = null;
	private ropeDrag: RopeDrag | null = null;
	/** タップで選んだ空のワイヤー（次に押した文字を吊る） */
	private selectedRope: TitlePeg | null = null;
	/** ワイヤーの先を引いているとき、離せば吊られる文字 */
	private ropeNear: Letter | null = null;
	/** 最初の画面にある札（HangLayer が動かす）の当たり。文字からは動かない壁に見える */
	private panelBodies = new Map<HTMLElement, { body: Body; w: number; h: number }>();
	/** ホバーで目立たせている吊り具 */
	private hoverEls: Element[] = [];
	private layers!: { wires: SVGGElement; pegs: SVGGElement; letters: SVGGElement; over: SVGGElement };
	private preview!: { line: SVGLineElement; head: SVGCircleElement };
	private family = '';
	private destroyed = false;
	private offs: (() => void)[] = [];

	constructor(
		private svgEl: SVGSVGElement,
		private board: HTMLElement,
		private hero: HTMLElement,
		/** 着地したとき。案内を出す位置（上端の y）を渡す */
		private onLanded: (hintTop: number) => void,
	) {}

	async init(): Promise<void> {
		this.family = getComputedStyle(document.documentElement).getPropertyValue('--font-display').trim() || 'Murecho, sans-serif';
		// 字の形を測る前に、タイトルの字の書体を読み込んでおく
		try {
			await document.fonts.load(`900 96px ${this.family}`, ROWS.join(''));
			await document.fonts.ready;
		} catch {
			// 読み込めなくても代わりの書体で測って描けばずれない
		}
		if (this.destroyed) return;
		this.build();

		const offEvent = on<StatementClosedDetail>(EVENTS.statementClosed, (d) => {
			if (d?.first) this.dropAll();
		});
		let lastW = this.hero.clientWidth;
		let lastH = this.hero.clientHeight;
		let raf = 0;
		const ro = new ResizeObserver(() => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(() => {
				const w = this.hero.clientWidth;
				const h = this.hero.clientHeight;
				if (w === lastW && Math.abs(h - lastH) < 1) return;
				lastW = w;
				lastH = h;
				this.build();
			});
		});
		ro.observe(this.hero);
		const offLayout = on(EVENTS.layout, () => this.refloor());
		// 札が動いたら当たりを動かし、上に載っていた文字を起こす
		const offPanels = onPanelsMoved(() => {
			if (this.syncPanels()) this.start();
		});
		this.offs.push(offPanels);
		const click = (e: MouseEvent) => this.onBoardClick(e);
		const move = (e: PointerEvent) => this.onWindowMove(e);
		const up = (e: PointerEvent) => this.onWindowUp(e);
		const key = (e: KeyboardEvent) => {
			if (e.key === 'Escape' && this.selected) this.select(null);
			if (e.key === 'Escape' && this.selectedRope) this.selectRope(null);
		};
		window.addEventListener('click', click);
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('pointercancel', up);
		window.addEventListener('keydown', key);
		this.offs.push(offEvent, offLayout, () => {
			ro.disconnect();
			cancelAnimationFrame(raf);
			window.removeEventListener('click', click);
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('pointercancel', up);
			window.removeEventListener('keydown', key);
		});
	}

	destroy(): void {
		this.destroyed = true;
		cancelAnimationFrame(this.frame);
		for (const off of this.offs) off();
	}

	// ---- 組み立て ----

	/** いまの画面幅で作り直す。落ちたあとなら、着地した状態で作る */
	private build(): void {
		cancelAnimationFrame(this.frame);
		this.frame = 0;
		this.drag = null;
		this.pending = null;
		this.selected = null;
		this.hover = null;
		this.ropeDrag = null;
		this.selectedRope = null;
		this.ropeNear = null;

		const heroRect = this.hero.getBoundingClientRect();
		const boardRect = this.board.getBoundingClientRect();
		const offX = heroRect.left - boardRect.left;
		const offY = heroRect.top - boardRect.top;
		this.width = heroRect.width;
		this.grid = gridFor(boardRect.width);
		this.layout = boardRect.width <= MOBILE_MAX ? MOBILE : DESKTOP;
		this.world = new World(this.world.bounds);
		this.measureBounds();
		// 字の大きさに合わせて重力をそろえる（スマホでも同じ速さに見える）
		this.world.gravity = 2600 * (this.layout.size / 96);

		const s = this.svgEl;
		s.replaceChildren();
		s.setAttribute('width', String(heroRect.width));
		s.setAttribute('height', String(heroRect.height));
		this.layers = {
			wires: svg('g', {}, s),
			pegs: svg('g', {}, s),
			letters: svg('g', {}, s),
			over: svg('g', {}, s),
		};
		this.preview = {
			line: svg('line', { stroke: 'var(--color-wire)', 'stroke-width': this.grid.wire, 'stroke-dasharray': '3 3' }, this.layers.over),
			head: svg('circle', { r: this.grid.peg / 2, stroke: 'var(--color-peg)', 'stroke-width': 1.5 }, this.layers.over),
		};
		show(this.preview.line, false);
		show(this.preview.head, false);

		const L = this.layout;
		const g = this.grid;
		const font = `900 ${L.size}px ${this.family}`;
		// ボードの座標で格子に吸着させてから、この SVG（最初の画面）の座標に直す
		// CSS の line-height: 1 で並べたときのベースライン（TitleStatic と同じ位置に字が来る）
		const metrics = this.measureFont(font);
		const baseOffset = (L.size - (metrics.ascent + metrics.descent)) / 2 + metrics.ascent;

		this.letters = [];
		this.titlePegs = [];
		ROWS.forEach((row, r) => {
			[...row].forEach((ch, k) => {
				const cx = L.x0 + r * L.roff + k * L.adv + L.adv / 2;
				const baseline = L.y0 + r * L.dy + baseOffset;
				if (ch === '、') {
					// 読点はワイヤーなしで、その位置に固定（落ちない）
					const t = svg('text', { x: cx, y: baseline, 'text-anchor': 'middle', fill: 'var(--color-ink)' }, this.layers.letters);
					t.style.font = `900 ${L.size}px var(--font-display)`;
					t.textContent = ch;
					return;
				}
				const shape = glyphShape(ch, font, L.size);
				const letter = this.createLetter(ch, r, shape, font);
				const pegX = snapX(g, cx + offX) - offX;
				// その段の文字の箱の上端から、少し上の孔の列（段のなかでペグの高さをそろえる）
				const rowTop = L.y0 + r * L.dy;
				const pegY = snapYAbove(g, rowTop + offY - g.step * TITLE_PEG_GAP) - offY;
				const ringY = baseline + shape.inkTop + 1;
				const tp = this.createTitlePeg(pegX, pegY, ringY - pegY);
				this.titlePegs.push(tp);
				this.hangOn(letter, { x: pegX, y: pegY, length: tp.length, titlePeg: tp }, 0);
				this.letters.push(letter);
				this.world.bodies.push(letter.body);
			});
		});

		this.panelBodies.clear();
		this.syncPanels();
		if (this.phase === 'landed') {
			this.dropAll(true);
		}
		this.render();
	}

	/**
	 * 札の当たりを、札のいまの位置に合わせる（shared.ts の panels を読む）。
	 * 最初の画面の中にある札だけ。どれかが動いたら true（そのときは文字を起こす）
	 */
	private syncPanels(): boolean {
		const heroRect = this.hero.getBoundingClientRect();
		const boardRect = this.board.getBoundingClientRect();
		const offX = heroRect.left - boardRect.left;
		const offY = heroRect.top - boardRect.top;
		let moved = false;
		const seen = new Set<HTMLElement>();
		for (const [el, r] of panels) {
			if (!this.hero.contains(el)) continue;
			seen.add(el);
			let pb = this.panelBodies.get(el);
			if (!pb || Math.abs(pb.w - r.w) > 0.5 || Math.abs(pb.h - r.h) > 0.5) {
				if (pb) this.world.bodies.splice(this.world.bodies.indexOf(pb.body), 1);
				const body = new Body(rectShape(r.w, r.h));
				body.kinematic = true;
				pb = { body, w: r.w, h: r.h };
				this.panelBodies.set(el, pb);
				this.world.bodies.push(body);
				moved = true;
			}
			const x = r.x - offX + r.w / 2;
			const y = r.y - offY + r.h / 2;
			if (Math.abs(pb.body.x - x) > 0.3 || Math.abs(pb.body.y - y) > 0.3) moved = true;
			pb.body.x = x;
			pb.body.y = y;
			pb.body.updateWorld();
		}
		for (const [el, pb] of this.panelBodies) {
			if (seen.has(el)) continue;
			this.world.bodies.splice(this.world.bodies.indexOf(pb.body), 1);
			this.panelBodies.delete(el);
			moved = true;
		}
		if (moved && this.phase === 'landed') {
			for (const l of this.letters) if (!l.hang && !l.body.kinematic) l.body.wake();
		}
		return moved;
	}

	/** つままれている文字の外形を、ボードの座標で札の側へ知らせる（札を押しのけるため） */
	private publishDragged(): void {
		draggedLetters.length = 0;
		const d = this.drag;
		if (!d) return;
		const heroRect = this.hero.getBoundingClientRect();
		const boardRect = this.board.getBoundingClientRect();
		const offX = heroRect.left - boardRect.left;
		const offY = heroRect.top - boardRect.top;
		const b = d.letter.body;
		b.updateWorld();
		let x0 = Infinity;
		let y0 = Infinity;
		let x1 = -Infinity;
		let y1 = -Infinity;
		for (const p of b.world) {
			x0 = Math.min(x0, p.x);
			y0 = Math.min(y0, p.y);
			x1 = Math.max(x1, p.x);
			y1 = Math.max(y1, p.y);
		}
		draggedLetters.push({ x: x0 + offX, y: y0 + offY, w: x1 - x0, h: y1 - y0 });
		lettersDragged();
	}

	// ---- ホバーで吊り具を目立たせる ----

	private setHover(els: (Element | null | undefined)[]): void {
		for (const el of this.hoverEls) el.classList.remove('hook-hover');
		this.hoverEls = els.filter((e): e is Element => !!e);
		for (const el of this.hoverEls) el.classList.add('hook-hover');
	}

	/** 文字にホバー：吊られていればそのペグと環、床にあれば押したときに吊られる先（次の空きのペグ） */
	private hoverLetter(l: Letter | null): void {
		if (!l || this.drag) return this.setHover([]);
		const h = l.hang;
		if (h) return this.setHover(h.titlePeg ? [h.titlePeg.head, l.ringEl, l.wire] : [l.peg, l.ringEl, l.wire]);
		const tp = this.nextFreePeg();
		// 先の環（ellipse）は transform 属性で置いているので、CSS の拡大は当てない
		this.setHover(tp ? [tp.head, tp.ropeLine] : []);
	}

	/** まだ文字がつながっていないタイトル用のペグのうち、読む順でいちばん先のもの */
	private nextFreePeg(): TitlePeg | null {
		return this.titlePegs.find((tp) => !tp.letter) ?? null;
	}

	private measureFont(font: string): { ascent: number; descent: number } {
		const ctx = document.createElement('canvas').getContext('2d');
		if (!ctx) return { ascent: this.layout.size * 0.88, descent: this.layout.size * 0.12 };
		ctx.font = font;
		const m = ctx.measureText('あ');
		return { ascent: m.fontBoundingBoxAscent, descent: m.fontBoundingBoxDescent };
	}

	/** 最初の画面の範囲と床を測る（sections.ts） */
	private measureBounds(): void {
		const heroRect = this.hero.getBoundingClientRect();
		const boardRect = this.board.getBoundingClientRect();
		const offX = heroRect.left - boardRect.left;
		const offY = heroRect.top - boardRect.top;
		const sec = measureSections(this.board).find((x) => x.name === (this.hero.dataset.section ?? 'hero'));
		const mobile = boardRect.width <= MOBILE_MAX;
		// 床の線の左右の端（global.css の [data-section]::after）の内側で止める
		const inset = mobile ? 18 : 36;
		this.top = (sec?.top ?? offY) - offY;
		this.floor = (sec?.floor ?? heroRect.height - 15) - offY;
		this.world.bounds = {
			floor: this.floor,
			left: (sec?.left ?? offX) - offX + inset,
			right: (sec?.right ?? offX + heroRect.width) - offX - inset,
		};
	}

	/** レイアウトが変わったら床だけ測り直す。着地した文字は新しい床まで動かす */
	private refloor(): void {
		const before = this.floor;
		this.measureBounds();
		if (Math.abs(before - this.floor) > 0.5) {
			this.world.wakeAll();
			this.start();
		}
	}

	private createLetter(ch: string, row: number, shape: GlyphShape, font: string): Letter {
		const color = LIT[row];
		const body = new Body(shape);
		const wire = svg('line', { stroke: 'var(--color-wire)', 'stroke-width': this.grid.wire }, this.layers.wires);
		const ringEl = svg('circle', { r: 3, fill: 'none', stroke: 'var(--color-wire)', 'stroke-width': 1.4 }, this.layers.wires);
		const peg = svg('circle', { r: this.grid.peg / 2, fill: color, stroke: 'var(--color-peg)', 'stroke-width': 1.5 }, this.layers.pegs);
		const g = svg('g', { 'data-title-letter': ch }, this.layers.letters);
		const text = svg('text', { x: -shape.centroid.x, y: -shape.centroid.y, 'text-anchor': 'middle', fill: 'var(--color-ink)' }, g);
		// 形を測ったのと同じ font で描く（字形の下端と当たり判定をそろえる）
		text.style.font = font;
		text.textContent = ch;
		const pts = shape.hull.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
		const outline = svg('polygon', { points: pts, fill: 'none', stroke: 'var(--color-ink)', 'stroke-width': 1.2, 'stroke-dasharray': '4 3' }, g);
		const hit = svg('polygon', { points: pts, fill: 'transparent' }, g);
		show(outline, false);
		const letter: Letter = {
			ch,
			row,
			color,
			shape,
			body,
			// 環は字形の上端の中央。文字の真ん中の線の上に来る
			ring: { x: -shape.centroid.x, y: shape.inkTop + 1 - shape.centroid.y },
			hang: null,
			g,
			hit,
			outline,
			wire,
			ringEl,
			peg,
		};
		hit.style.touchAction = 'none';
		hit.addEventListener('pointerdown', (e) => this.onLetterDown(letter, e));
		hit.addEventListener('pointerenter', (e) => {
			if (e.pointerType !== 'touch') this.hoverLetter(letter);
		});
		hit.addEventListener('pointerleave', () => this.hoverLetter(null));
		this.setInteractive(letter, false);
		return letter;
	}

	private createTitlePeg(x: number, y: number, length: number): TitlePeg {
		const ropeLine = svg('path', { fill: 'none', stroke: 'var(--color-wire-loose)', 'stroke-width': this.grid.wire, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, this.layers.wires);
		const ropeRing = svg('ellipse', { rx: 3, ry: 2.2, fill: 'none', stroke: 'var(--color-wire-loose)', 'stroke-width': 1.4 }, this.layers.wires);
		const head = svg('circle', { cx: x, cy: y, r: this.grid.peg / 2, stroke: 'var(--color-peg)', 'stroke-width': 1.5 }, this.layers.pegs);
		// 先の当たりは文字より前（over）に置く。指で押しやすいよう大きめ
		const ropeHit = svg('circle', { r: 16, fill: 'transparent' }, this.layers.over);
		ropeHit.style.pointerEvents = 'all';
		ropeHit.style.cursor = 'grab';
		ropeHit.style.touchAction = 'none';
		show(ropeHit, false);
		const tp: TitlePeg = { x, y, length, letter: null, rope: null, head, ropeLine, ropeRing, ropeHit };
		ropeHit.addEventListener('pointerdown', (e) => this.onRopeDown(tp, e));
		ropeHit.addEventListener('pointerenter', (e) => {
			if (e.pointerType !== 'touch' && !this.drag) this.setHover([tp.head, tp.ropeLine]);
		});
		ropeHit.addEventListener('pointerleave', () => this.setHover([]));
		return tp;
	}

	private setInteractive(letter: Letter, enabled: boolean): void {
		letter.hit.style.pointerEvents = enabled ? 'all' : 'none';
		letter.hit.style.cursor = enabled ? 'grab' : '';
	}

	// ---- 吊る・外す ----

	/** 文字の環の世界座標 */
	private ringWorld(letter: Letter): Vec {
		return letter.body.toWorld(letter.ring);
	}

	/** 吊った振り子の角度から、文字の位置と向きを決める */
	private poseHung(letter: Letter): void {
		const h = letter.hang;
		if (!h) return;
		const t = h.pend.theta;
		const rx = h.x - h.length * Math.sin(t);
		const ry = h.y + h.length * Math.cos(t);
		const b = letter.body;
		b.a = t;
		const c = Math.cos(t);
		const s = Math.sin(t);
		b.x = rx - (letter.ring.x * c - letter.ring.y * s);
		b.y = ry - (letter.ring.x * s + letter.ring.y * c);
		b.vx = b.vy = b.w = 0;
	}

	private hangOn(letter: Letter, t: Target, theta: number): void {
		const pivotToCom = t.length + Math.hypot(letter.ring.x, letter.ring.y);
		letter.hang = { x: t.x, y: t.y, length: t.length, pend: createPendulum(pivotToCom, theta), titlePeg: t.titlePeg };
		letter.body.kinematic = true;
		letter.body.sleeping = false;
		if (t.titlePeg) {
			t.titlePeg.letter = letter;
			t.titlePeg.rope = null;
		}
		this.poseHung(letter);
		// 下にあった文字が抜けたかもしれないので、眠っている文字を起こす
		this.world.wakeAll();
	}

	/**
	 * 空のワイヤーの先を、いまある場所の文字に結んで巻き上げる（B3 の吊り上げ）。
	 * 文字を飛ばさず、いまの環の位置を長さ・角度にして吊り、長さを縮めて引き上げる
	 */
	private reelHang(letter: Letter, tp: TitlePeg): void {
		if (tp.letter) return;
		if (letter.hang) this.unhang(letter, 0);
		tp.rope?.release();
		const r = this.ringWorld(letter);
		const dist = Math.max(Math.hypot(r.x - tp.x, r.y - tp.y), tp.length);
		const theta = clamp(Math.atan2(-(r.x - tp.x), r.y - tp.y), -1.2, 1.2);
		if (reducedMotion()) {
			this.hangOn(letter, { x: tp.x, y: tp.y, length: tp.length, titlePeg: tp }, 0);
		} else {
			this.hangOn(letter, { x: tp.x, y: tp.y, length: dist, titlePeg: tp }, theta);
			letter.hang!.rest = tp.length;
		}
		this.start();
	}

	/** 文字をワイヤーから外す。タイトル用のペグなら、空のワイヤーが縮みながら跳ねる */
	private unhang(letter: Letter, kick: number): void {
		const h = letter.hang;
		if (!h) return;
		const ring = this.ringWorld(letter);
		letter.hang = null;
		letter.body.kinematic = false;
		letter.body.wake();
		if (h.titlePeg) {
			const tp = h.titlePeg;
			tp.letter = null;
			const rope = new Rope(tp.x, tp.y, ring.x, ring.y, this.looseLength());
			if (kick > 0) rope.kick(kick, H);
			tp.rope = rope;
		}
	}

	/** 空のワイヤーが垂れる長さ */
	private looseLength(): number {
		return Math.round(this.layout.size * 0.3);
	}

	/** タイトル以外の孔に吊るときのワイヤーの長さ */
	private holeLength(): number {
		return Math.round(this.grid.step * 0.7);
	}

	/** 一斉に落とす。instant なら動きを見せずに着地した状態を作る */
	private dropAll(instant = reducedMotion()): void {
		if (this.phase === 'landed' && !instant) return;
		this.phase = 'landed';
		// 床の上に散らばるよう、読む順に床の左から並ぶ位置をめがけて横に飛ばす。
		// 3 段が同じ所に落ちると高い山になり、ほかの札に重なるため
		const { left, right } = this.world.bounds;
		// PC は右下の開催情報の札の下を避けて左半分に、スマホは床の幅いっぱいに
		const mobile = this.layout === MOBILE;
		const span = mobile ? right - left : Math.min(right - left, Math.max(this.width * 0.47, this.layout.size * 4.5));
		const n = this.letters.length;
		this.letters.forEach((l, i) => {
			if (!l.hang) return;
			this.unhang(l, instant ? 0 : 520 * (this.layout.size / 96));
			const b = l.body;
			const goal = left + this.layout.size * 0.5 + (span - this.layout.size) * (i / Math.max(n - 1, 1));
			const fall = Math.sqrt((2 * Math.max(this.floor - b.y, 1)) / this.world.gravity);
			// ばらばらに回りながら落ちる
			b.vx = (goal - b.x) / fall + (Math.random() - 0.5) * 60;
			b.vy = -Math.random() * 120;
			b.w = (Math.random() - 0.5) * 5;
			this.setInteractive(l, true);
		});
		if (instant) {
			this.world.settle();
			for (const tp of this.titlePegs) tp.rope?.settle();
			this.render();
			this.notifyLanded();
		} else {
			this.start();
		}
	}

	private landedNotified = false;
	private notifyLanded(): void {
		if (this.landedNotified) return;
		this.landedNotified = true;
		// 案内は、挿し先の空のワイヤーのすぐ下に出す（床の文字や札に重ねない）
		const pegY = this.titlePegs[0]?.y ?? 0;
		this.onLanded(pegY + this.looseLength() + 18);
	}

	// ---- 吊り先 ----

	/** 点に近い空のタイトル用ワイヤーの先 */
	private ropeTarget(q: Vec): Target | null {
		const r = this.layout.size * 0.4;
		let best: Target | null = null;
		let bestD = r;
		for (const tp of this.titlePegs) {
			if (tp.letter || !tp.rope) continue;
			const e = tp.rope.end;
			const d = Math.hypot(e.x - q.x, e.y - q.y);
			if (d < bestD) {
				bestD = d;
				best = { x: tp.x, y: tp.y, length: tp.length, titlePeg: tp };
			}
		}
		return best;
	}

	/** 点にいちばん近い板の孔。maxDist より遠ければなし。吊る余地がない孔もなし */
	private holeTarget(q: Vec, maxDist: number, except: Letter | null): Target | null {
		const g = this.grid;
		const heroRect = this.hero.getBoundingClientRect();
		const boardRect = this.board.getBoundingClientRect();
		const offX = heroRect.left - boardRect.left;
		const offY = heroRect.top - boardRect.top;
		const bx = q.x + offX;
		const by = q.y + offY;
		const x = Math.round((bx - g.ox) / g.step) * g.step + g.ox - offX;
		const y = Math.round((by - g.oy) / g.step) * g.step + g.oy - offY;
		if (Math.hypot(x - q.x, y - q.y) > maxDist) return null;
		const length = this.holeLength();
		const { left, right } = this.world.bounds;
		if (y < this.top || y + length + this.layout.size * 1.05 > this.floor || x < left || x > right) return null;
		// タイトル用のペグの孔なら、そのペグに吊る
		const tp = this.titlePegs.find((p) => Math.abs(p.x - x) < 1 && Math.abs(p.y - y) < 1);
		if (tp) return tp.letter && tp.letter !== except ? null : { x, y, length: tp.length, titlePeg: tp };
		// ほかの文字が吊られている孔には吊らない
		if (this.letters.some((l) => l !== except && l.hang && Math.abs(l.hang.x - x) < 1 && Math.abs(l.hang.y - y) < 1)) return null;
		return { x, y, length, titlePeg: null };
	}

	/** つまんでいる文字の吊り先：環が空のワイヤーの先に近いか、環の少し上がちょうど孔 */
	private dragTarget(letter: Letter): Target | null {
		const ring = this.ringWorld(letter);
		return this.ropeTarget(ring) ?? this.holeTarget({ x: ring.x, y: ring.y - this.holeLength() }, this.grid.step * 0.24, letter);
	}

	/** タップした点の吊り先：空のワイヤーの先か、いちばん近い孔 */
	private tapTarget(q: Vec): Target | null {
		return this.ropeTarget(q) ?? this.holeTarget(q, this.grid.step, this.selected);
	}

	// ---- 操作 ----

	private localPoint(clientX: number, clientY: number): Vec {
		const r = this.svgEl.getBoundingClientRect();
		return { x: clientX - r.left, y: clientY - r.top };
	}

	/** 空のワイヤーの先を押した。文字を選んでいればそこへ吊り、そうでなければつまむ */
	private onRopeDown(tp: TitlePeg, e: PointerEvent): void {
		if (this.phase !== 'landed' || this.drag || this.ropeDrag || tp.letter || !tp.rope) return;
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		if (this.selected) {
			const l = this.selected;
			this.select(null);
			this.reelHang(l, tp);
			return;
		}
		this.ropeDrag = { peg: tp, pointerId: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
	}

	/** ワイヤーの先を引いている指に近い、まだ吊られていない文字 */
	private letterNear(q: Vec): Letter | null {
		let best: Letter | null = null;
		let bestD = NEAR_RADIUS;
		for (const l of this.letters) {
			if (l.hang) continue;
			// 字形の外形（凸包）の点までの距離のうち、いちばん近いもの。中に入っていれば 0
			const local = l.body.toLocal(q);
			const r = l.shape.hull;
			// 凸包の向き（時計回りか）に関わらず、すべての辺の同じ側にあれば中
			let pos = 0;
			let neg = 0;
			let d = Infinity;
			for (let i = 0; i < r.length; i++) {
				const a = r[i];
				const b = r[(i + 1) % r.length];
				if ((b.x - a.x) * (local.y - a.y) - (b.y - a.y) * (local.x - a.x) < 0) neg++;
				else pos++;
				d = Math.min(d, segDist(local, a, b));
			}
			const dist = pos === 0 || neg === 0 ? 0 : d;
			if (dist < bestD) {
				bestD = dist;
				best = l;
			}
		}
		return best;
	}

	private setRopeNear(l: Letter | null): void {
		if (this.ropeNear === l) return;
		if (this.ropeNear && this.ropeNear !== this.selected) show(this.ropeNear.outline, false);
		this.ropeNear = l;
		if (l) show(l.outline, true);
	}

	private onLetterDown(letter: Letter, e: PointerEvent): void {
		if (this.phase !== 'landed' || this.drag) return;
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		this.pending = { letter, pointerId: e.pointerId, x: e.clientX, y: e.clientY };
	}

	private onWindowMove(e: PointerEvent): void {
		const rd = this.ropeDrag;
		if (rd && rd.pointerId === e.pointerId) {
			if (!rd.moved && Math.hypot(e.clientX - rd.x, e.clientY - rd.y) > 5) {
				rd.moved = true;
				this.selectRope(null);
			}
			if (rd.moved && rd.peg.rope) {
				const q = this.clampPivot(this.localPoint(e.clientX, e.clientY));
				rd.peg.rope.pull(q.x, q.y);
				this.setRopeNear(this.letterNear(q));
				this.start();
			}
			return;
		}
		// マウスでなでると、空のワイヤーが揺れる
		if (e.pointerType === 'mouse' && this.phase === 'landed' && !this.drag) {
			const q = this.localPoint(e.clientX, e.clientY);
			let pushed = false;
			for (const tp of this.titlePegs) if (tp.rope && !tp.letter && tp.rope.push(q.x, q.y, 14)) pushed = true;
			if (pushed) this.start();
		}
		const p = this.pending;
		if (p && p.pointerId === e.pointerId && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 5) {
			this.pending = null;
			this.beginDrag(p.letter, e, { x: p.x, y: p.y });
		}
		const d = this.drag;
		if (d && d.pointerId === e.pointerId) {
			d.clientX = e.clientX;
			d.clientY = e.clientY;
			d.trail.push({ t: performance.now(), x: e.clientX, y: e.clientY });
			if (d.trail.length > 12) d.trail.shift();
			this.start();
			return;
		}
		// 文字を選んでいるあいだ、マウスの下の吊り先を見せる
		if (this.selected && e.pointerType === 'mouse' && !this.drag) {
			const t = this.tapTarget(this.localPoint(e.clientX, e.clientY));
			if (t?.x !== this.hover?.x || t?.y !== this.hover?.y) {
				this.hover = t;
				this.render();
			}
		}
	}

	private beginDrag(letter: Letter, e: PointerEvent, down: { x: number; y: number }): void {
		this.select(null);
		if (letter.hang) this.unhang(letter, 0);
		// つかんだ点（押した瞬間に指の下にあった点）を、以後ずっとポインタの真下に置く
		const grab = letter.body.toLocal(this.localPoint(down.x, down.y));
		letter.body.kinematic = true;
		letter.body.wake();
		this.world.wakeAll();
		this.drag = { letter, pointerId: e.pointerId, grab, clientX: e.clientX, clientY: e.clientY, trail: [{ t: performance.now(), x: e.clientX, y: e.clientY }], target: null };
		letter.hit.style.cursor = 'grabbing';
		// 前に描く
		this.layers.letters.appendChild(letter.g);
		this.start();
	}

	private onWindowUp(e: PointerEvent): void {
		const rd = this.ropeDrag;
		if (rd && rd.pointerId === e.pointerId) {
			this.ropeDrag = null;
			const target = e.type === 'pointercancel' ? null : this.ropeNear;
			this.setRopeNear(null);
			if (!rd.moved) {
				// 動かさずに離した＝タップ。ワイヤーを選ぶ／やめる（次に押した文字を吊る）
				this.selectRope(this.selectedRope === rd.peg ? null : rd.peg);
				return;
			}
			if (target) this.reelHang(target, rd.peg);
			else rd.peg.rope?.release();
			this.start();
			return;
		}
		const p = this.pending;
		if (p && p.pointerId === e.pointerId) {
			this.pending = null;
			// ワイヤーを選んでいれば、その文字を吊る
			if (this.selectedRope) {
				const tp = this.selectedRope;
				this.selectRope(null);
				this.reelHang(p.letter, tp);
				return;
			}
			// 動かさずに離した＝クリック（単押し）。床の文字は、まだ文字がつながっていないタイトル用のペグへ、読む順に吊られる
			if (!p.letter.hang) {
				const tp = this.nextFreePeg();
				if (tp) {
					this.reelHang(p.letter, tp);
					this.setHover([]);
				}
			}
			return;
		}
		const d = this.drag;
		if (!d || d.pointerId !== e.pointerId) return;
		this.drag = null;
		// 札の側へ、もう押していないことを知らせる
		draggedLetters.length = 0;
		lettersDragged();
		const l = d.letter;
		l.hit.style.cursor = 'grab';
		const target = e.type === 'pointercancel' ? null : this.dragTarget(l);
		if (target) {
			const ring = this.ringWorld(l);
			const theta = reducedMotion() ? 0 : clamp(Math.atan2(-(ring.x - target.x), ring.y - target.y), -1, 1);
			this.hangOn(l, target, theta);
		} else {
			// 離した勢いで投げる
			const v = this.throwVelocity(d);
			const b = l.body;
			const c = b.toWorld(d.grab);
			const rx = b.x - c.x;
			const ry = b.y - c.y;
			b.kinematic = false;
			b.wake();
			b.vx = clamp(v.x - b.w * ry, -2200, 2200);
			b.vy = clamp(v.y + b.w * rx, -2200, 2200);
		}
		this.start();
	}

	private throwVelocity(d: Drag): Vec {
		const now = performance.now();
		const recent = d.trail.filter((p) => now - p.t < 90);
		if (recent.length < 2) return { x: 0, y: 0 };
		const a = recent[0];
		const b = recent[recent.length - 1];
		const dt = Math.max((b.t - a.t) / 1000, 1 / 120);
		return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt };
	}

	/** 空のワイヤーを選ぶ。選んでいるあいだは先の環を濃く太くする */
	private selectRope(tp: TitlePeg | null): void {
		this.selectedRope = tp;
		if (tp) this.select(null);
		this.render();
	}

	private select(letter: Letter | null): void {
		if (this.selected) show(this.selected.outline, false);
		this.selected = letter;
		this.hover = null;
		if (letter) show(letter.outline, true);
		this.render();
	}

	/** 文字を選んでいるときに板を押したら、そこに吊る（タップ→タップ） */
	private onBoardClick(e: MouseEvent): void {
		const l = this.selected;
		if (!l) return;
		const t = e.target as Element | null;
		if (t?.closest('[data-title-letter]')) return;
		// リンクやボタンはそのまま働かせる
		if (t?.closest('a, button, input, select, textarea, label')) return;
		const q = this.localPoint(e.clientX, e.clientY);
		const target = this.tapTarget(q);
		this.select(null);
		if (!target) return;
		if (l.hang) this.unhang(l, 0);
		this.hangOn(l, target, reducedMotion() ? 0 : 0.35 * (Math.random() < 0.5 ? -1 : 1));
		this.start();
	}

	// ---- 時間を進める ----

	private start(): void {
		if (this.frame) return;
		this.last = performance.now();
		this.frame = requestAnimationFrame(this.tick);
	}

	private tick = (now: number): void => {
		this.frame = 0;
		const dt = Math.min((now - this.last) / 1000, 1 / 20);
		this.last = now;
		const steps = Math.max(1, Math.round(dt / H));
		this.syncPanels();
		for (let i = 0; i < steps; i++) this.step(H);
		this.publishDragged();
		this.render();
		if (!this.isQuiet()) this.frame = requestAnimationFrame(this.tick);
		else if (this.phase === 'landed') this.notifyLanded();
	};

	private step(h: number): void {
		const g = this.world.gravity;
		const d = this.drag;
		if (d) {
			// つかんだ点を支点にした振り子として向きを変え、位置はつかんだ点がポインタの真下に来るように決める
			const b = d.letter.body;
			const p = this.clampPivot(this.localPoint(d.clientX, d.clientY));
			const c = Math.cos(b.a);
			const s = Math.sin(b.a);
			const dx = -(d.grab.x * c - d.grab.y * s);
			const dy = -(d.grab.x * s + d.grab.y * c);
			const k2 = b.inertia / b.mass;
			b.w += ((g * dx) / (k2 + dx * dx + dy * dy)) * h;
			b.w *= Math.exp(-5 * h);
			b.a += b.w * h;
			const c2 = Math.cos(b.a);
			const s2 = Math.sin(b.a);
			const nx = p.x - (d.grab.x * c2 - d.grab.y * s2);
			const ny = p.y - (d.grab.x * s2 + d.grab.y * c2);
			b.vx = (nx - b.x) / h;
			b.vy = (ny - b.y) / h;
			b.x = nx;
			b.y = ny;
		}
		this.world.step(h);
		if (d) {
			// 速さは押しのける計算にだけ使う
			d.letter.body.vx = d.letter.body.vy = 0;
		}
		for (const l of this.letters) {
			const hg = l.hang;
			if (!hg) continue;
			// 巻き上げ中：ワイヤーを縮め、振り子の長さもそれに合わせる
			let reeling = false;
			if (hg.rest !== undefined) {
				hg.length += (hg.rest - hg.length) * (1 - Math.exp(-4 * h));
				if (Math.abs(hg.length - hg.rest) < 0.3) {
					hg.length = hg.rest;
					hg.rest = undefined;
				}
				hg.pend.length = hg.length + Math.hypot(l.ring.x, l.ring.y);
				reeling = true;
			}
			if (reeling || !pendulumQuiet(hg.pend)) {
				stepPendulum(hg.pend, h, g);
				this.poseHung(l);
			}
		}
		for (const tp of this.titlePegs) tp.rope?.step(h, g * 0.6);
	}

	/** ポインタは最初の画面の中に限る（外へ持ち出すと、属する床がなくなるため） */
	private clampPivot(p: Vec): Vec {
		const { left, right } = this.world.bounds;
		return { x: clamp(p.x, left, right), y: clamp(p.y, this.top, this.floor) };
	}

	private isQuiet(): boolean {
		if (this.drag || this.ropeDrag) return false;
		if (!this.world.quiet) return false;
		if (this.letters.some((l) => l.hang && (l.hang.rest !== undefined || !pendulumQuiet(l.hang.pend)))) return false;
		return this.titlePegs.every((tp) => !tp.rope || tp.rope.sleeping);
	}

	// ---- 描く ----

	private render(): void {
		const d = this.drag;
		for (const l of this.letters) {
			const b = l.body;
			l.g.setAttribute('transform', `translate(${b.x.toFixed(2)} ${b.y.toFixed(2)}) rotate(${((b.a * 180) / Math.PI).toFixed(3)})`);
			const h = l.hang;
			show(l.wire, !!h);
			show(l.ringEl, !!h);
			show(l.peg, !!h && !h.titlePeg);
			if (h) {
				const r = this.ringWorld(l);
				setAttrs(l.wire, { x1: h.x, y1: h.y, x2: r.x, y2: r.y });
				// 環の描き方は HangLayer の ring とそろえる
				setAttrs(l.ringEl, { cx: r.x, cy: r.y - 3 });
				setAttrs(l.peg, { cx: h.x, cy: h.y });
			}
		}
		for (const tp of this.titlePegs) {
			tp.head.setAttribute('fill', tp.letter ? tp.letter.color : 'var(--color-peg)');
			const rope = tp.letter ? null : tp.rope;
			show(tp.ropeLine, !!rope);
			show(tp.ropeRing, !!rope);
			show(tp.ropeHit, !!rope && this.phase === 'landed');
			if (rope) {
				tp.ropeLine.setAttribute('d', rope.toPath());
				const e = rope.end;
				const deg = (rope.endAngle * 180) / Math.PI;
				// 環は少し傾けて垂らす
				setAttrs(tp.ropeRing, { transform: `translate(${e.x.toFixed(2)} ${(e.y + 2).toFixed(2)}) rotate(${(deg + 12).toFixed(2)})` });
				setAttrs(tp.ropeHit, { cx: e.x, cy: e.y });
				// つまんでいる・選んでいるワイヤーは濃く太く
				const active = this.selectedRope === tp || this.ropeDrag?.peg === tp;
				const stroke = active ? 'var(--color-wire)' : 'var(--color-wire-loose)';
				tp.ropeLine.setAttribute('stroke', stroke);
				tp.ropeLine.setAttribute('stroke-width', String(active ? this.grid.wire * 1.6 : this.grid.wire));
				tp.ropeRing.setAttribute('stroke', stroke);
				tp.ropeRing.setAttribute('stroke-width', active ? '2.2' : '1.4');
			}
		}
		// 吊り先の下見：つまんでいる文字の行き先か、選んだ文字のタップ先
		const t = d ? (d.target = this.dragTarget(d.letter)) : this.selected ? this.hover : null;
		show(this.preview.line, !!t);
		show(this.preview.head, !!t);
		if (t) {
			const color = (d?.letter ?? this.selected)?.color ?? 'var(--color-peg)';
			const end = d ? this.ringWorld(d.letter) : { x: t.x, y: t.y + t.length };
			setAttrs(this.preview.head, { cx: t.x, cy: t.y, fill: color });
			setAttrs(this.preview.line, { x1: t.x, y1: t.y, x2: end.x, y2: end.y });
		}
	}
}

function setAttrs(el: Element, attrs: Record<string, string | number>): void {
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, typeof v === 'number' ? v.toFixed(2) : v);
}

/** 点 p から線分 ab までの距離 */
function segDist(p: Vec, a: Vec, b: Vec): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
	return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

function clamp(v: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, v));
}

export default function HangingTitle() {
	const svgRef = useRef<SVGSVGElement>(null);
	const [hint, setHint] = useState<number | null>(null);

	useEffect(() => {
		const el = svgRef.current;
		const board = el?.closest<HTMLElement>('[data-board]');
		const hero = el?.closest<HTMLElement>('[data-section]');
		if (!el || !board || !hero) return;
		const scene = new TitleScene(el, board, hero, (top) => {
			// スマホでは、落ちた直後に一度だけ案内を出す
			if (window.innerWidth <= MOBILE_MAX) setHint(top);
		});
		void scene.init();
		return () => scene.destroy();
	}, []);

	useEffect(() => {
		if (hint === null) return;
		const id = window.setTimeout(() => setHint(null), 6000);
		return () => window.clearTimeout(id);
	}, [hint]);

	return (
		<>
			{/* 下の段へのワイヤーが上の段の文字の後ろを通るよう、HangLayer（z-10）より前に出す */}
			<svg ref={svgRef} aria-hidden="true" className="pointer-events-none absolute top-0 left-0 z-20 overflow-visible" width={0} height={0} />
			{hint !== null && (
				<p role="status" className="tape absolute left-[26px] z-20" style={{ top: hint }}>
					文字を押すと、上のフックに順に吊られる
				</p>
			)}
		</>
	);
}
