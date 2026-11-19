// 吊られたタイトルの物理と操作。React には乗せず、器の SVG の中身を直接作って動かす。
// 文字は planck.js の世界（lib/physics/board-world.ts）の凸多角形の物体。ワイヤーはロープ関節、巻き上げはロープを少しずつ縮める。
// 見た目の要素を作る・書き込むのは view.ts
import { MOBILE_MAX, gridFor, snapX, snapYAbove, type BoardGrid } from '../../../lib/board';
import { EVENTS, on, type StatementClosedDetail } from '../../../lib/events';
import { clamp } from '../../../lib/math';
import { reducedMotion } from '../../../lib/motion';
import { GRAVITY_PX, boardWorld, m, tagOf, toM, toPx, touchingSolid } from '../../../lib/physics/board-world';
import { stepWire, wireCable } from '../../../lib/physics/cable';
import { glyphShape, type GlyphShape, type Vec } from '../../../lib/physics/glyph';
import { Rope } from '../../../lib/physics/rope';
import { show } from '../../../lib/svg';
import { STAGE_COLORS } from '../../../lib/colors';
import {
	DRAG_ANGULAR_DAMPING,
	DRAG_MAX_SPIN,
	LETTER_ANGULAR_DAMPING,
	MAX_VERTS,
	NEAR_RADIUS,
	REEL_RATE,
	ROWS,
	TITLE_LAYOUT,
	TITLE_PEG_GAP,
	type TitleLayout,
} from './config';
import { hullDistance, reduceHull } from './hull';
import type { Drag, Letter, Pending, Phase, RopeDrag, Target, TitlePeg } from './types';
import {
	createLayers,
	createLetterEls,
	createPegEls,
	drawComma,
	drawLetter,
	drawPreview,
	drawTitlePeg,
	setLetterInteractive,
	type Preview,
	type TitleLayers,
} from './view';

export class TitleScene {
	private phase: Phase = 'hung';
	private letters: Letter[] = [];
	private titlePegs: TitlePeg[] = [];
	private grid: BoardGrid = gridFor(1440);
	private layout: TitleLayout = TITLE_LAYOUT.desktop;
	/** 最初の画面の左上の、ボードの中での位置（最初の画面の座標 + off = ボードの座標） */
	private off: Vec = { x: 0, y: 0 };
	/** ページ全体の範囲（最初の画面の座標）。文字をつまんで動かせる範囲 */
	private bounds = { top: 0, floor: 0, left: 0, right: 0 };
	private drag: Drag | null = null;
	private pending: Pending | null = null;
	private ropeDrag: RopeDrag | null = null;
	/** タップで選んだ空のワイヤー（次に押した文字を吊る） */
	private selectedRope: TitlePeg | null = null;
	/** ワイヤーの先を引いているとき、離せば吊られる文字 */
	private ropeNear: Letter | null = null;
	/** ホバーで目立たせている吊り具 */
	private hoverEls: Element[] = [];
	/** マウスの位置（最初の画面の座標）。ワイヤーをなでると揺れる */
	private ptr: Vec | null = null;
	private layers!: TitleLayers;
	private preview!: Preview;
	private family = '';
	private destroyed = false;
	private landedNotified = false;
	private offs: (() => void)[] = [];
	private world = boardWorld();

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
		const offLayout = on(EVENTS.layout, () => this.measureBounds());
		const offFrame = this.world.addListener({ before: (dt) => this.beforeStep(dt), after: () => this.render() });
		const move = (e: PointerEvent) => this.onWindowMove(e);
		const up = (e: PointerEvent) => this.onWindowUp(e);
		const key = (e: KeyboardEvent) => {
			if (e.key === 'Escape' && this.selectedRope) this.selectRope(null);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('pointercancel', up);
		window.addEventListener('keydown', key);
		// つまんだままホイールでスクロールしても、文字が指の下に付いてくるように
		const scroll = () => this.dragToPointer();
		window.addEventListener('scroll', scroll, { passive: true });
		this.offs.push(offEvent, offLayout, offFrame, () => {
			ro.disconnect();
			cancelAnimationFrame(raf);
			window.removeEventListener('scroll', scroll);
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('pointercancel', up);
			window.removeEventListener('keydown', key);
		});
	}

	destroy(): void {
		this.destroyed = true;
		for (const off of this.offs) off();
		this.clearBodies();
	}

	private clearBodies(): void {
		for (const l of this.letters) {
			this.world.destroyJoint(l.hang?.joint);
			this.world.destroyBody(l.body);
		}
		this.letters = [];
	}

	// ---- 座標 ----

	/** 最初の画面の座標 → ボードの座標 */
	private toBoard(p: Vec): Vec {
		return { x: p.x + this.off.x, y: p.y + this.off.y };
	}
	/** 文字の重心（最初の画面の座標） */
	private pos(l: Letter): Vec {
		const p = toPx(l.body.getPosition());
		return { x: p.x - this.off.x, y: p.y - this.off.y };
	}
	/** 文字の環（最初の画面の座標） */
	private ringWorld(l: Letter): Vec {
		return this.letterPoint(l, l.ring);
	}
	/** 文字の局所座標（px）→ 最初の画面の座標 */
	private letterPoint(l: Letter, local: Vec): Vec {
		const p = toPx(l.body.getWorldPoint(toM(local)));
		return { x: p.x - this.off.x, y: p.y - this.off.y };
	}
	/** 最初の画面の座標 → 文字の局所座標（px） */
	private letterLocal(l: Letter, q: Vec): Vec {
		return toPx(l.body.getLocalPoint(toM(this.toBoard(q))));
	}

	// ---- 組み立て ----

	/** いまの画面幅で作り直す。落ちたあとなら、着地した状態で作る */
	private build(): void {
		this.drag = null;
		this.pending = null;
		this.ropeDrag = null;
		this.selectedRope = null;
		this.ropeNear = null;
		this.world.release();
		this.clearBodies();

		const boardRect = this.board.getBoundingClientRect();
		this.grid = gridFor(boardRect.width);
		this.layout = boardRect.width <= MOBILE_MAX ? TITLE_LAYOUT.phone : TITLE_LAYOUT.desktop;
		this.measureBounds();
		// ページの端の見えない壁（HangLayer も置くが、こちらが先に組み立つこともあるので置いておく）
		this.world.setBounds(boardRect.width, this.board.scrollHeight);
		const heroRect = this.hero.getBoundingClientRect();
		({ layers: this.layers, preview: this.preview } = createLayers(this.svgEl, this.grid, heroRect.width, heroRect.height));

		const L = this.layout;
		const g = this.grid;
		const { x: offX, y: offY } = this.off;
		const font = `900 ${L.size}px ${this.family}`;
		// CSS の line-height: 1 で並べたときのベースライン
		const metrics = this.measureFont(font);
		const baseOffset = (L.size - (metrics.ascent + metrics.descent)) / 2 + metrics.ascent;

		this.titlePegs = [];
		ROWS.forEach((row, r) => {
			[...row].forEach((ch, k) => {
				const cx = L.x0 + r * L.roff + k * L.adv + L.adv / 2;
				const baseline = L.y0 + r * L.dy + baseOffset;
				if (ch === '、') {
					drawComma(this.layers, ch, cx, baseline, L.size);
					return;
				}
				const shape = glyphShape(ch, font, L.size);
				const pegX = snapX(g, cx + offX) - offX;
				// その段の文字の箱の上端から、少し上の孔の列（段のなかでペグの高さをそろえる）
				const rowTop = L.y0 + r * L.dy;
				const pegY = snapYAbove(g, rowTop + offY - g.step * TITLE_PEG_GAP) - offY;
				const ringY = baseline + shape.inkTop + 1;
				const tp = this.createTitlePeg(pegX, pegY, ringY - pegY);
				this.titlePegs.push(tp);
				// 重心の位置：文字の基準点（cx, baseline）から重心へ
				const letter = this.createLetter(ch, r, shape, font, { x: cx + shape.centroid.x, y: baseline + shape.centroid.y });
				this.hangOn(letter, { x: pegX, y: pegY, length: tp.length, titlePeg: tp }, false);
				this.letters.push(letter);
			});
		});

		if (this.phase === 'landed') this.dropAll(true);
		this.render();
		this.world.kick();
	}

	private measureFont(font: string): { ascent: number; descent: number } {
		const ctx = document.createElement('canvas').getContext('2d');
		if (!ctx) return { ascent: this.layout.size * 0.88, descent: this.layout.size * 0.12 };
		ctx.font = font;
		const mt = ctx.measureText('あ');
		return { ascent: mt.fontBoundingBoxAscent, descent: mt.fontBoundingBoxDescent };
	}

	/** 最初の画面の位置と、文字を動かせる範囲（ページ全体。最初の画面の座標）を測る */
	private measureBounds(): void {
		const heroRect = this.hero.getBoundingClientRect();
		const boardRect = this.board.getBoundingClientRect();
		this.off = { x: heroRect.left - boardRect.left, y: heroRect.top - boardRect.top };
		const edge = 8;
		this.bounds = {
			top: -this.off.y + edge,
			floor: this.board.scrollHeight - this.off.y - edge,
			left: -this.off.x + edge,
			right: boardRect.width - this.off.x - edge,
		};
	}

	private createLetter(ch: string, row: number, shape: GlyphShape, font: string, center: Vec): Letter {
		const body = this.world.createPolygon(this.toBoard(center), reduceHull(shape.hull, MAX_VERTS), { kind: 'letter' });
		const letter: Letter = {
			...createLetterEls(this.layers, this.grid, ch, shape, font),
			ch,
			row,
			color: STAGE_COLORS[row],
			shape,
			body,
			// 環は字形の上端の中央。文字の真ん中の線の上に来る
			ring: { x: -shape.centroid.x, y: shape.inkTop + 1 - shape.centroid.y },
			hang: null,
			cable: null,
			cableEnd: { x: 0, y: 0 },
		};
		letter.hit.addEventListener('pointerdown', (e) => this.onLetterDown(letter, e));
		letter.hit.addEventListener('pointerenter', (e) => {
			if (e.pointerType !== 'touch') this.hoverLetter(letter);
		});
		letter.hit.addEventListener('pointerleave', () => this.hoverLetter(null));
		setLetterInteractive(letter, this.phase === 'landed');
		return letter;
	}

	private createTitlePeg(x: number, y: number, length: number): TitlePeg {
		const tp: TitlePeg = { ...createPegEls(this.layers, this.grid, x, y), x, y, length, letter: null, rope: null };
		tp.ropeHit.addEventListener('pointerdown', (e) => this.onRopeDown(tp, e));
		tp.ropeHit.addEventListener('pointerenter', (e) => {
			if (e.pointerType !== 'touch' && !this.drag) this.setHover([tp.head, tp.ropeLine]);
		});
		tp.ropeHit.addEventListener('pointerleave', () => this.setHover([]));
		return tp;
	}

	// ---- 吊る・外す ----

	/**
	 * 文字を t に吊る。ロープはいまの環までの長さで結び、t.length まで少しずつ縮めて引き上げる（瞬間移動させない）。
	 * reel が false なら、いまの位置のまま t.length で吊る（組み立てたとき）
	 */
	private hangOn(letter: Letter, t: Target, reel = true): void {
		if (letter.hang) this.unhang(letter, 0);
		const ring = this.ringWorld(letter);
		const dist = Math.hypot(ring.x - t.x, ring.y - t.y);
		const instant = !reel || reducedMotion();
		const cur = instant ? t.length : Math.max(dist, t.length);
		const joint = this.world.createRope(letter.body, this.toBoard({ x: t.x, y: t.y }), letter.ring, cur);
		letter.hang = { x: t.x, y: t.y, length: t.length, cur, joint, titlePeg: t.titlePeg };
		// 巻き上げているあいだは、札やほかの文字をすり抜ける（引っかかって吸着しないままにならないように）
		const tag = tagOf(letter.body);
		if (tag && cur > t.length) tag.ghost = true;
		// ワイヤーの見た目：ペグから環へのうねるロープ
		const peg = { x: t.x, y: t.y };
		letter.cableEnd = { ...ring };
		letter.cable = wireCable(() => peg, () => letter.cableEnd, cur);
		t.titlePeg.letter = letter;
		t.titlePeg.rope = null;
		letter.body.setAwake(true);
		this.world.kick();
	}

	/** 文字をワイヤーから外す。空になったワイヤーが縮みながら跳ねる */
	private unhang(letter: Letter, kick: number): void {
		const h = letter.hang;
		if (!h) return;
		const ring = this.ringWorld(letter);
		this.world.destroyJoint(h.joint);
		letter.hang = null;
		letter.cable = null;
		letter.body.setAwake(true);
		const tp = h.titlePeg;
		tp.letter = null;
		const rope = new Rope(tp.x, tp.y, ring.x, ring.y, this.looseLength());
		if (kick > 0) rope.kick(kick, 1 / 240);
		tp.rope = rope;
	}

	/** 空のワイヤーの先を、いまある場所の文字に結んで巻き上げる（B3 の吊り上げ） */
	private reelHang(letter: Letter, tp: TitlePeg): void {
		if (tp.letter) return;
		tp.rope?.release();
		this.hangOn(letter, { x: tp.x, y: tp.y, length: tp.length, titlePeg: tp });
	}

	/** 空のワイヤーが垂れる長さ */
	private looseLength(): number {
		return Math.round(this.layout.size * 0.3);
	}

	/** 一斉に落とす。instant なら動きを見せずに着地した状態を作る */
	private dropAll(instant = reducedMotion()): void {
		if (this.phase === 'landed' && !instant) return;
		this.phase = 'landed';
		// ワイヤーが切れて、その場から素直に落ちる（投げたり回したりはしない）。どこに積もるかは物理まかせ。
		// 切れたワイヤーの先だけが、縮みながら上へ跳ねる
		const scale = this.layout.size / 96;
		for (const l of this.letters) {
			if (l.hang) this.unhang(l, instant ? 0 : 520 * scale);
			l.body.setAwake(true);
			setLetterInteractive(l, true);
		}
		if (instant) {
			this.world.settle(1500);
			for (const tp of this.titlePegs) tp.rope?.settle();
			this.render();
			this.notifyLanded();
		} else {
			this.world.kick();
		}
	}

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

	/** 点に近い、空いているタイトル用のペグ（そのペグに吊られたときの環の位置で比べる） */
	private titlePegNear(q: Vec): Target | null {
		const r = this.layout.size * 0.5;
		let best: Target | null = null;
		let bestD = r;
		for (const tp of this.titlePegs) {
			if (tp.letter) continue;
			const d = Math.hypot(tp.x - q.x, tp.y + tp.length - q.y);
			if (d < bestD) {
				bestD = d;
				best = { x: tp.x, y: tp.y, length: tp.length, titlePeg: tp };
			}
		}
		return best;
	}

	/**
	 * つまんでいる文字の吊り先：環が空のワイヤーの先か、空いているタイトル用のペグの吊り位置に近いとき。
	 * 文字を吊れるのはタイトル用のペグ（フック）だけ（板のほかの孔には吊らない）
	 */
	private dragTarget(letter: Letter): Target | null {
		const ring = this.ringWorld(letter);
		return this.ropeTarget(ring) ?? this.titlePegNear(ring);
	}

	/** まだ文字がつながっていないタイトル用のペグのうち、読む順でいちばん先のもの */
	private nextFreePeg(): TitlePeg | null {
		return this.titlePegs.find((tp) => !tp.letter) ?? null;
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
		if (h) return this.setHover([h.titlePeg.head, l.ringEl, l.wire]);
		// 先の環（ellipse）は transform 属性で置いているので、CSS の拡大は当てない
		const tp = this.nextFreePeg();
		this.setHover(tp ? [tp.head, tp.ropeLine] : []);
	}

	// ---- 操作 ----

	private localPoint(clientX: number, clientY: number): Vec {
		const r = this.svgEl.getBoundingClientRect();
		return { x: clientX - r.left, y: clientY - r.top };
	}

	/** ポインタはページ（ボード）の中に限る（見えない壁の外へ持ち出さない） */
	private clampPivot(p: Vec): Vec {
		const { left, right, top, floor } = this.bounds;
		return { x: clamp(p.x, left, right), y: clamp(p.y, top, floor) };
	}

	/** 空のワイヤーの先を押した。つかむ（動かせばドラッグ、動かさなければ選ぶ） */
	private onRopeDown(tp: TitlePeg, e: PointerEvent): void {
		if (this.phase !== 'landed' || this.drag || this.ropeDrag || tp.letter || !tp.rope) return;
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		this.ropeDrag = { peg: tp, pointerId: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
	}

	/** ワイヤーの先を引いている指に近い、まだ吊られていない文字 */
	private letterNear(q: Vec): Letter | null {
		let best: Letter | null = null;
		let bestD = NEAR_RADIUS;
		for (const l of this.letters) {
			if (l.hang) continue;
			// 字形の外形（凸包）の点までの距離のうち、いちばん近いもの。中に入っていれば 0
			const dist = hullDistance(this.letterLocal(l, q), l.shape.hull);
			if (dist < bestD) {
				bestD = dist;
				best = l;
			}
		}
		return best;
	}

	private setRopeNear(l: Letter | null): void {
		if (this.ropeNear === l) return;
		if (this.ropeNear) show(this.ropeNear.outline, false);
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
				this.world.kick();
			}
			return;
		}
		// マウスでなでると、吊っているワイヤーも空のワイヤーも揺れる
		if (e.pointerType === 'mouse') {
			this.ptr = this.localPoint(e.clientX, e.clientY);
			this.world.kick();
		}
		if (e.pointerType === 'mouse' && this.phase === 'landed' && !this.drag) {
			const q = this.localPoint(e.clientX, e.clientY);
			let pushed = false;
			for (const tp of this.titlePegs) if (tp.rope && !tp.letter && tp.rope.push(q.x, q.y, 14)) pushed = true;
			if (pushed) this.world.kick();
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
			this.dragToPointer();
		}
	}

	/** つまんでいる点を、最後のポインタの位置（いまのスクロールで測り直す）へ引く */
	private dragToPointer(): void {
		const d = this.drag;
		if (d) this.world.drag(this.toBoard(this.clampPivot(this.localPoint(d.clientX, d.clientY))));
	}

	private beginDrag(letter: Letter, e: PointerEvent, down: { x: number; y: number }): void {
		this.selectRope(null);
		this.setHover([]);
		if (letter.hang) this.unhang(letter, 0);
		// 押した瞬間に指の下にあった点をつかむ。つまんでいるあいだは回転を強く減らす
		letter.body.setAngularDamping(DRAG_ANGULAR_DAMPING);
		this.world.grab(letter.body, this.toBoard(this.localPoint(down.x, down.y)), 1.2);
		this.world.drag(this.toBoard(this.clampPivot(this.localPoint(e.clientX, e.clientY))));
		this.drag = { letter, pointerId: e.pointerId, clientX: e.clientX, clientY: e.clientY };
		letter.hit.style.cursor = 'grabbing';
		// 前に描く
		this.layers.letters.appendChild(letter.g);
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
			this.world.kick();
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
		const l = d.letter;
		l.hit.style.cursor = 'pointer';
		const target = e.type === 'pointercancel' ? null : this.dragTarget(l);
		// 離すと、つかんでいた速さのまま投げられる（物理のまま）。回転の減り方は元に戻す
		this.world.release();
		l.body.setAngularDamping(LETTER_ANGULAR_DAMPING);
		if (target) this.hangOn(l, target);
		drawPreview(this.preview, null, { x: 0, y: 0 }, '');
	}

	/** 空のワイヤーを選ぶ。選んでいるあいだは先の環を濃く太くする */
	private selectRope(tp: TitlePeg | null): void {
		this.selectedRope = tp;
		this.render();
	}

	// ---- 時間を進める ----

	/** 物理の刻みの前：巻き上げ中のロープを縮める。空のワイヤー（見た目）を進める */
	private beforeStep(dt: number): void {
		// つまんでいる文字は、回る速さに上限を付ける
		const d = this.drag;
		if (d) {
			const w = d.letter.body.getAngularVelocity();
			if (Math.abs(w) > DRAG_MAX_SPIN) d.letter.body.setAngularVelocity(Math.sign(w) * DRAG_MAX_SPIN);
		}
		for (const l of this.letters) {
			// すり抜けは、巻き上げが終わって、何にも重なっていなくなったら解く
			const tag = tagOf(l.body);
			if (tag?.ghost && !(l.hang && l.hang.cur > l.hang.length) && !touchingSolid(l.body)) tag.ghost = false;
			const h = l.hang;
			if (!h || h.cur <= h.length) continue;
			h.cur = Math.max(h.length, h.cur + (h.length - h.cur) * (1 - Math.exp(-REEL_RATE * dt)) - 20 * dt);
			h.joint.setMaxLength(m(h.cur));
			l.body.setAwake(true);
		}
		for (const tp of this.titlePegs) tp.rope?.step(dt, GRAVITY_PX * 0.6);
	}

	// ---- 描く ----

	/** 物理の刻みのあと：文字・ワイヤー・吊り先の下見を描く。まだ動いているものがあれば true */
	private render(): boolean {
		const d = this.drag;
		let busy = !!(d || this.ropeDrag);
		for (const l of this.letters) {
			const h = l.hang;
			let wire: { path: string | null; ring: Vec } | null = null;
			if (h) {
				if (h.cur > h.length) busy = true;
				const r = this.ringWorld(l);
				let path: string | null = null;
				// ワイヤーの見た目：少したるませ、揺れが波になって走る。マウスでなでると揺れる
				if (l.cable) {
					l.cableEnd.x = r.x;
					l.cableEnd.y = r.y;
					if (stepWire(l.cable, h.cur, this.ptr)) busy = true;
					path = l.cable.path();
				}
				wire = { path, ring: r };
			}
			drawLetter(l, this.pos(l), l.body.getAngle(), wire);
		}
		for (const tp of this.titlePegs) {
			const rope = tp.letter ? null : tp.rope;
			if (rope && !rope.sleeping) busy = true;
			drawTitlePeg(tp, {
				fill: tp.letter ? tp.letter.color : 'var(--color-peg)',
				rope,
				grabbable: this.phase === 'landed',
				active: this.selectedRope === tp || this.ropeDrag?.peg === tp,
				wire: this.grid.wire,
			});
		}
		// 吊り先の下見：つまんでいる文字の行き先
		const t = d ? this.dragTarget(d.letter) : null;
		drawPreview(this.preview, t, t && d ? this.ringWorld(d.letter) : { x: 0, y: 0 }, d?.letter.color ?? '');
		// 落ちた文字がすべて止まったら、一度だけ案内を出す
		if (this.phase === 'landed' && !this.landedNotified && this.letters.every((l) => l.hang || !l.body.isAwake())) this.notifyLanded();
		return busy;
	}
}
