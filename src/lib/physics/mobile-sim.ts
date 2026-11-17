// ステートメントの「言葉のモビール」を、本物のモビールとして planck.js で動かす。
// ・横棒（細い棒）と句の札は物体。糸はロープ関節
// ・最初の横棒はシートの上端から、次の横棒は前の棒の運び手（真ん中に近い札）の下端から、1 本の糸で吊る
// ・句の札は、それぞれ横棒から 1 本の糸で吊る
// ・横棒の吊り点は、その下にぶら下がっているもの全部（札と、その先の棒と札）の重さが釣り合う位置。
//   吊り点は棒より少し上にあるので、傾いても水平に戻る（本物のモビールの針金の輪と同じ）。
//   配置（StatementMobile の layoutMobile）は、吊り点が上の糸の真下に来るよう下の棒から組むので、糸は最初からまっすぐ垂れる
// ・シートの枠（左右と下端）に壁があり、札と横棒はぶつかって枠の中に収まる。札どうしは、同じ横棒に吊られた札だけがぶつかる
// ・シートが落ちて受け止められたり、つかんで振られたりすると、その加速度が慣性として伝わって揺れる。
//   シートが傾けば、重力の向きも傾く
// 座標はモビールの中身の左上を原点にした px。DOM には触らず、位置だけを返す
import { Box, Edge, RopeJoint, Vec2, World, type Body } from 'planck';
import { GRAVITY_PX, SCALE, m, toM, toPx, type Pt } from './board-world';

/** 句の札（左上と大きさ）。bar は吊っている横棒の番号 */
export interface MCard {
	id: number;
	x: number;
	y: number;
	w: number;
	h: number;
	bar: number;
}

/** 横棒。low は次の棒を吊る札（運び手）の番号（cards の添字）。hook は吊り点の x（ぶら下がるもの全部の重さが釣り合う点） */
export interface MBar {
	x1: number;
	x2: number;
	y: number;
	low: number;
	hook: number;
}

export interface MLayout {
	/** 最初の糸の上端（シートの上端） */
	anchor: Pt;
	cards: MCard[];
	bars: MBar[];
	/** シートの中身の幅と高さ。左右と下端に壁を置き、札と横棒はぶつかって枠の中に収まる */
	frame?: { width: number; height: number };
}

/** 吊り点を棒の線よりどれだけ上にするか（px）。上にあるほど水平に戻りやすい */
export const HOOK_UP = 9;
/** 横棒の密度と太さ（px）。配置で釣り合いを求めるときも同じ値を使う */
export const BAR_DENSITY = 0.4;
export const BAR_THICK = 3;
/** 1 刻み */
const STEP = 1 / 120;
/** シートの加速度がこれ（px/秒²）より小さければ 0 とみなす（止まりかけのシートの細かい揺れで、モビールを傾けない） */
const DEADBAND = 500;

/** 衝突の組（ビット）：札は札と枠に、横棒は枠にだけぶつかる */
const CAT_CARD = 1;
const CAT_BAR = 2;
const CAT_FRAME = 4;

export interface MobilePose {
	/** 札の中心と傾き */
	cards: { x: number; y: number; a: number }[];
	/** 横棒の両端 */
	bars: [Pt, Pt][];
	/** 横棒を吊る糸（上端、吊り点）と、吊り点から棒への短い線の下端 */
	threads: { top: Pt; hook: Pt; foot: Pt }[];
	/** 札を吊る糸（棒の上の点、札の上端） */
	strings: [Pt, Pt][];
}

export class MobileSim {
	private world = new World({ gravity: Vec2(0, GRAVITY_PX / SCALE) });
	private ground: Body;
	private barBodies: Body[] = [];
	private cardBodies: Body[] = [];
	/** 横棒と札のすべて（毎フレーム配列を作り直さない） */
	private all: Body[] = [];
	private frame = 0;
	private last = 0;
	private acc = 0;
	/** シートの動きから加速度を求めるための、前の位置と速さ */
	private prevPos: Pt | null = null;
	private prevVel: Pt = { x: 0, y: 0 };
	private prevT = 0;
	/** シートの加速度（px/秒²）：ならしただけの値と、小さい値を 0 にした値。シートの傾き */
	private raw: Pt = { x: 0, y: 0 };
	private acc2: Pt = { x: 0, y: 0 };
	private angle = 0;

	constructor(
		private layout: MLayout,
		private onFrame: (pose: MobilePose) => void,
	) {
		const w = this.world;
		this.ground = w.createBody();
		const { bars, cards } = layout;
		// 横棒：細い棒。ほかの物とはぶつからない
		this.barBodies = bars.map((b) => {
			// 減衰は、受け止められたときに大きく揺れて、4 秒ほどで読めるくらいに収まる強さ
			const body = w.createBody({ type: 'dynamic', position: toM({ x: (b.x1 + b.x2) / 2, y: b.y }), linearDamping: 0.9, angularDamping: 2.2 });
			body.createFixture(new Box(m(b.x2 - b.x1) / 2, m(BAR_THICK / 2)), { density: BAR_DENSITY, filterCategoryBits: CAT_BAR, filterMaskBits: CAT_FRAME });
			return body;
		});
		// 句の札：札どうしはぶつかる（揺れて触れ合う）
		this.cardBodies = cards.map((c) => {
			const body = w.createBody({
				type: 'dynamic',
				position: toM({ x: c.x + c.w / 2, y: c.y + c.h / 2 }),
				linearDamping: 0.9,
				angularDamping: 2.4,
				userData: { bar: c.bar },
			});
			body.createFixture(new Box(m(c.w) / 2, m(c.h) / 2), { density: 1, friction: 0.3, filterCategoryBits: CAT_CARD, filterMaskBits: CAT_CARD | CAT_FRAME });
			return body;
		});
		// 札どうしがぶつかるのは、同じ横棒に吊られた札だけ（段の違う札が寄りかかり合って、傾いたまま引っかからないように）
		w.on('pre-solve', (contact) => {
			const a = contact.getFixtureA().getBody().getUserData() as { bar?: number } | null;
			const b = contact.getFixtureB().getBody().getUserData() as { bar?: number } | null;
			if (a?.bar !== undefined && b?.bar !== undefined && a.bar !== b.bar) contact.setEnabled(false);
		});
		// シートの枠：左右と下端の壁。揺れても札と横棒は枠の中に収まる（上端は糸の吊り元なので置かない）
		if (layout.frame) {
			const { width, height } = layout.frame;
			const frame = w.createBody();
			const inset = 2;
			const edge = (a: Pt, b: Pt) =>
				frame.createFixture(new Edge(toM(a), toM(b)), { friction: 0.3, filterCategoryBits: CAT_FRAME, filterMaskBits: CAT_CARD | CAT_BAR });
			edge({ x: inset, y: -200 }, { x: inset, y: height - inset });
			edge({ x: width - inset, y: -200 }, { x: width - inset, y: height - inset });
			edge({ x: inset, y: height - inset }, { x: width - inset, y: height - inset });
		}
		const rope = (a: Body, la: Pt, b: Body, lb: Pt, len: number) =>
			w.createJoint(new RopeJoint({ bodyA: a, bodyB: b, localAnchorA: toM(la), localAnchorB: toM(lb), maxLength: m(Math.max(len, 1)), collideConnected: false }));
		// 横棒を吊る糸：最初はシートの上端から、次からは前の棒でいちばん長く垂れた札の下端から。吊り点は棒より少し上
		bars.forEach((b, k) => {
			const cx = (b.x1 + b.x2) / 2;
			const hookLocal = { x: b.hook - cx, y: -HOOK_UP };
			if (k === 0) {
				rope(this.ground, layout.anchor, this.barBodies[0], hookLocal, b.y - HOOK_UP - layout.anchor.y);
			} else {
				const low = cards[bars[k - 1].low];
				rope(this.cardBodies[bars[k - 1].low], { x: 0, y: low.h / 2 }, this.barBodies[k], hookLocal, b.y - HOOK_UP - (low.y + low.h));
			}
		});
		// 句の札を吊る糸：棒の上の点から、札の上端の真ん中へ
		cards.forEach((c, i) => {
			const b = bars[c.bar];
			const cx = (b.x1 + b.x2) / 2;
			rope(this.barBodies[c.bar], { x: c.x + c.w / 2 - cx, y: 0 }, this.cardBodies[i], { x: 0, y: -c.h / 2 }, c.y - b.y);
		});
		// 吊り点の真下に重さが来るまで、先に落ち着かせておく（開いた瞬間にがくっと動かないように）
		this.all = [...this.barBodies, ...this.cardBodies];
		for (let i = 0; i < 360; i++) w.step(STEP, 8, 4);
		for (const body of this.all) {
			body.setLinearVelocity(Vec2(0, 0));
			body.setAngularVelocity(0);
		}
		this.emit();
	}

	destroy(): void {
		cancelAnimationFrame(this.frame);
		this.frame = 0;
	}

	/**
	 * シートのいまの位置（ずれ）と傾きを知らせる。前との差から加速度を求め、慣性としてモビールに伝える。
	 * シートの中から見ると、重力は「下向きの重力 − シートの加速度」で、シートの傾きぶん回って見える
	 */
	setFrame(offset: Pt, angle: number): void {
		const now = performance.now() / 1000;
		// しばらく知らせがなかった（シートが止まっていた）なら、前の位置は使わない（間が空いた分で加速度が跳ねないように）
		if (now - this.prevT > 0.1) {
			this.prevPos = null;
			this.prevVel = { x: 0, y: 0 };
			this.raw = { x: 0, y: 0 };
		}
		let ax = 0;
		let ay = 0;
		if (this.prevPos && now > this.prevT) {
			const dt = now - this.prevT;
			const vel = { x: (offset.x - this.prevPos.x) / dt, y: (offset.y - this.prevPos.y) / dt };
			ax = (vel.x - this.prevVel.x) / dt;
			ay = (vel.y - this.prevVel.y) / dt;
			this.prevVel = vel;
		}
		this.prevPos = { ...offset };
		this.prevT = now;
		// 大きすぎる値（フレームの抜けなど）は抑え、1 フレームだけの飛び出しはならす
		const lim = GRAVITY_PX * 4;
		ax = Math.max(-lim, Math.min(lim, ax));
		ay = Math.max(-lim, Math.min(lim, ay));
		// 位置の差を 2 回とると、0.1px のずれでも数百 px/秒² のノイズになる。強めにならし、小さい値は 0 とみなす
		this.raw = { x: this.raw.x * 0.75 + ax * 0.25, y: this.raw.y * 0.75 + ay * 0.25 };
		const mag = Math.hypot(this.raw.x, this.raw.y);
		this.acc2 = mag < DEADBAND ? { x: 0, y: 0 } : { x: this.raw.x * (1 - DEADBAND / mag), y: this.raw.y * (1 - DEADBAND / mag) };
		this.angle = angle;
		this.applyGravity();
		// 揺さぶられたら起こして回す
		if (Math.abs(ax) + Math.abs(ay) > 200 || Math.abs(angle) > 0.002) this.kick();
	}

	/** シートの中から見た重力（下向きの重力 − シートの加速度。シートの傾きぶん回す） */
	private applyGravity(): void {
		const gx = -this.acc2.x;
		const gy = GRAVITY_PX - this.acc2.y;
		const c = Math.cos(-this.angle);
		const s = Math.sin(-this.angle);
		this.world.setGravity(Vec2((gx * c - gy * s) / SCALE, (gx * s + gy * c) / SCALE));
	}

	/** 揺らす（止まっていれば動かし始める） */
	kick(): void {
		for (const b of this.all) b.setAwake(true);
		if (this.frame) return;
		this.last = performance.now();
		this.frame = requestAnimationFrame(this.tick);
	}

	private tick = (now: number): void => {
		this.frame = 0;
		// シートから知らせが来なくなった（シートが止まった）ら、加速度は 0 に戻して、重力をまっすぐ下へ
		if (performance.now() / 1000 - this.prevT > 0.05 && (this.acc2.x || this.acc2.y || this.angle)) {
			this.acc2 = { x: this.acc2.x * 0.8, y: this.acc2.y * 0.8 };
			this.raw = { x: this.raw.x * 0.8, y: this.raw.y * 0.8 };
			this.angle *= 0.8;
			if (Math.abs(this.acc2.x) + Math.abs(this.acc2.y) < 1) this.acc2 = { x: 0, y: 0 };
			if (Math.abs(this.angle) < 0.0005) this.angle = 0;
			this.applyGravity();
		}
		this.acc += Math.min((now - this.last) / 1000, STEP * 6);
		this.last = now;
		while (this.acc >= STEP) {
			this.world.step(STEP, 8, 4);
			this.acc -= STEP;
		}
		this.emit();
		const awake = this.all.some((b) => b.isAwake());
		if (awake) this.frame = requestAnimationFrame(this.tick);
		else this.acc = 0;
	};

	/** いまの姿を返す（描き直してもらう） */
	private emit(): void {
		const { bars, cards } = this.layout;
		const pt = (b: Body, l: Pt) => toPx(b.getWorldPoint(toM(l)));
		const pose: MobilePose = {
			cards: this.cardBodies.map((b) => {
				const p = toPx(b.getPosition());
				return { x: p.x, y: p.y, a: b.getAngle() };
			}),
			bars: bars.map((b, k) => {
				const half = (b.x2 - b.x1) / 2;
				return [pt(this.barBodies[k], { x: -half, y: 0 }), pt(this.barBodies[k], { x: half, y: 0 })];
			}),
			threads: bars.map((b, k) => {
				const cx = (b.x1 + b.x2) / 2;
				const hook = pt(this.barBodies[k], { x: b.hook - cx, y: -HOOK_UP });
				const foot = pt(this.barBodies[k], { x: b.hook - cx, y: 0 });
				const top = k === 0 ? { ...this.layout.anchor } : pt(this.cardBodies[bars[k - 1].low], { x: 0, y: cards[bars[k - 1].low].h / 2 });
				return { top, hook, foot };
			}),
			strings: cards.map((c, i) => {
				const b = bars[c.bar];
				const cx = (b.x1 + b.x2) / 2;
				return [pt(this.barBodies[c.bar], { x: c.x + c.w / 2 - cx, y: 0 }), pt(this.cardBodies[i], { x: 0, y: -c.h / 2 })];
			}),
		};
		this.onFrame(pose);
	}
}
