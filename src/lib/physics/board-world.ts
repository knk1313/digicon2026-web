// 有孔ボードの上の物理を、1 つの planck.js（Box2D の移植）の世界でまとめて動かす。
// 吊られた札（HangLayer）とタイトルの文字（HangingTitle）は、別々の island だが同じこの世界の物体になる。
// だから、札どうし・文字どうし・札と文字は、重さ・速さ・摩擦・回転を持ったまま正しくぶつかる。
// ・座標：外からはボード（[data-board]）の左上を原点にした px で受け渡す。中では SCALE で割ったメートル
// ・ワイヤー：ロープ関節（最大の長さだけを決める。ゆるむことはできる）。ペグは動かない点
// ・床：落ちたものは各節の棚（横長の札。HangLayer が吊る）に載る。ページの下端と左右の端には、こぼれたもの用の見えない壁を置く
// ・つかむ：マウス関節。つかんだ点が指を追う
// ・時間：決まった刻み（1/120 秒）で進める。止まった物体は眠り、すべて眠ったらループも止まる
import { Body, Box, Edge, MouseJoint, Polygon, RopeJoint, Settings, Vec2, World, type Joint } from 'planck';

/** 1 メートルを何 px にするか。札（数百 px）も文字（数十 px）も Box2D の得意な大きさに入るように */
export const SCALE = 50;
/** 重力（px / 秒²） */
export const GRAVITY_PX = 2400;
/** 1 刻みの時間 */
const STEP = 1 / 120;
/** 1 フレームで進める刻みの上限（タブが裏に回って戻ったときに一気に進めない） */
const MAX_STEPS = 6;

export interface Pt {
	x: number;
	y: number;
}

/** 物体に付ける目印 */
export interface BodyTag {
	kind: 'panel' | 'letter' | 'section';
	/** 札なら要素 */
	el?: HTMLElement;
	/**
	 * すり抜け中。フックに巻き上げられている文字は、札やほかの文字に引っかからずに通り抜ける（節の床と壁にはぶつかる）。
	 * 巻き上げが終わっても何かに重なっているあいだは続ける（急に弾かれないように）
	 */
	ghost?: boolean;
}

/** 物体の目印 */
export function tagOf(b: Body): BodyTag | null {
	return (b.getUserData() as BodyTag | null) ?? null;
}

/** 節の床と壁以外のもの（札・文字）に、いま触れているか */
export function touchingSolid(b: Body): boolean {
	for (let ce = b.getContactList(); ce; ce = ce.next) {
		if (!ce.other || !ce.contact.isTouching()) continue;
		if (tagOf(ce.other)?.kind !== 'section') return true;
	}
	return false;
}

/** 毎フレームの前後に呼ばれるもの。after が true を返すあいだはループを止めない（ロープの見た目が揺れているなど） */
export interface FrameListener {
	before?(dt: number): void;
	after(): boolean;
}

export const m = (px: number) => px / SCALE;
export const px = (meters: number) => meters * SCALE;
export const toM = (p: Pt) => Vec2(p.x / SCALE, p.y / SCALE);
export const toPx = (v: { x: number; y: number }): Pt => ({ x: v.x * SCALE, y: v.y * SCALE });

// 眠る判定：画面で 2px/秒・1.5°/秒より遅い揺れが 0.4 秒続いたら眠らせる。
// 既定（0.5px/秒）のままだと、短いワイヤーの札が目に見えない小さな揺れを続けて、いつまでも計算が止まらない
Settings.linearSleepTolerance = 2 / SCALE;
Settings.angularSleepTolerance = (1.5 * Math.PI) / 180;
Settings.timeToSleep = 0.4;

class BoardWorld {
	readonly world = new World({ gravity: Vec2(0, GRAVITY_PX / SCALE) });
	/** ペグやつかむ点の相手になる、動かない物体（形はない） */
	readonly ground: Body = this.world.createBody();
	private listeners = new Set<FrameListener>();
	private sectionBodies: Body[] = [];
	private ignore = new Set<string>();
	private ids = new WeakMap<Body, number>();
	private nextId = 1;
	private mouse: MouseJoint | null = null;
	private frame = 0;
	private last = 0;
	private acc = 0;

	constructor() {
		// 静止した位置で最初から重なっている札どうしは押し合わない。
		// すり抜け中の文字は、節の床と壁のほかには押し合わない
		this.world.on('pre-solve', (contact) => {
			const a = contact.getFixtureA().getBody();
			const b = contact.getFixtureB().getBody();
			if (this.ignore.has(this.key(a, b))) {
				contact.setEnabled(false);
				return;
			}
			const ta = tagOf(a);
			const tb = tagOf(b);
			if ((ta?.ghost && tb?.kind !== 'section') || (tb?.ghost && ta?.kind !== 'section')) contact.setEnabled(false);
		});
	}

	private id(b: Body): number {
		let i = this.ids.get(b);
		if (!i) {
			i = this.nextId++;
			this.ids.set(b, i);
		}
		return i;
	}
	private key(a: Body, b: Body): string {
		const i = this.id(a);
		const j = this.id(b);
		return i < j ? `${i}:${j}` : `${j}:${i}`;
	}

	/** この 2 つは押し合わない */
	ignorePair(a: Body, b: Body): void {
		this.ignore.add(this.key(a, b));
	}

	// ---- ページの端 ----

	/**
	 * ページ（ボード）の下端と左右の端に、見えない壁を置き直す。落ちたものを受け止めるのは各節の棚（横長の札）で、
	 * これは棚からこぼれたものがどこまでも落ちていかないための最後の受け止め
	 */
	setBounds(width: number, height: number): void {
		for (const b of this.sectionBodies) this.world.destroyBody(b);
		this.sectionBodies = [];
		const body = this.world.createBody({ userData: { kind: 'section' } satisfies BodyTag });
		body.createFixture(new Edge(toM({ x: 0, y: height }), toM({ x: width, y: height })), { friction: 0.6 });
		body.createFixture(new Edge(toM({ x: 0, y: -2000 }), toM({ x: 0, y: height })), { friction: 0.2 });
		body.createFixture(new Edge(toM({ x: width, y: -2000 }), toM({ x: width, y: height })), { friction: 0.2 });
		this.sectionBodies.push(body);
		this.wakeAll();
	}

	// ---- 物体 ----

	/** 長方形の札。c は中心、w・h は大きさ（px） */
	createPanel(c: Pt, w: number, h: number, tag: BodyTag): Body {
		const body = this.world.createBody({
			type: 'dynamic',
			position: toM(c),
			// 大きく引いて離しても、数秒で揺れが収まるくらい
			linearDamping: 1.1,
			angularDamping: 2.4,
			userData: tag,
		});
		body.createFixture(new Box(m(w) / 2, m(h) / 2), { density: 1, friction: 0.45, restitution: 0.05 });
		return body;
	}

	/** 凸多角形の物体（文字）。points は重心を原点にした px */
	createPolygon(c: Pt, points: Pt[], tag: BodyTag, angle = 0): Body {
		const body = this.world.createBody({
			type: 'dynamic',
			position: toM(c),
			angle,
			linearDamping: 0.08,
			angularDamping: 0.6,
			bullet: true,
			userData: tag,
		});
		// 文字は軽め（札の 1/3 ほどの密度）。札の上に落ちても札をあまり沈めず、軽く跳ねて転がる
		body.createFixture(new Polygon(points.map(toM)), { density: 0.35, friction: 0.55, restitution: 0.12 });
		return body;
	}

	/** ペグ（ボードの点 peg）から、物体の上の点 local（物体の局所座標の px）へのロープ。length は最大の長さ（px） */
	createRope(body: Body, peg: Pt, local: Pt, length: number): RopeJoint {
		// ground は原点にあるので、ペグの位置がそのまま ground の局所座標
		const j = new RopeJoint({
			bodyA: this.ground,
			bodyB: body,
			localAnchorA: toM(peg),
			localAnchorB: toM(local),
			maxLength: m(Math.max(length, 1)),
			collideConnected: true,
		});
		return this.world.createJoint(j) as RopeJoint;
	}

	destroyJoint(j: Joint | null | undefined): void {
		if (j) this.world.destroyJoint(j);
	}

	destroyBody(b: Body | null | undefined): void {
		if (!b) return;
		if (this.mouse && this.mouse.getBodyB() === b) this.release();
		// 押し合わない組から、この物体を含むものを除く（測り直すたびに組が増え続けないように）
		const i = this.ids.get(b);
		if (i) {
			for (const k of this.ignore) {
				const [x, y] = k.split(':');
				if (Number(x) === i || Number(y) === i) this.ignore.delete(k);
			}
		}
		this.world.destroyBody(b);
	}

	wakeAll(): void {
		for (let b = this.world.getBodyList(); b; b = b.getNext()) if (b.isDynamic()) b.setAwake(true);
		this.kick();
	}

	// ---- つかむ ----

	/** 物体の点 at（ボードの px）をつかむ。指にぐいっとついてくるよう、固めのばねにする */
	grab(body: Body, at: Pt, stiff = 1): void {
		this.release();
		body.setAwake(true);
		const mass = body.getMass();
		this.mouse = this.world.createJoint(
			new MouseJoint({ maxForce: 6000 * mass * (GRAVITY_PX / SCALE), frequencyHz: 14 * stiff, dampingRatio: 0.85 }, this.ground, body, toM(at)),
		) as MouseJoint;
		this.kick();
	}

	/** つかんだ点を at（ボードの px）へ引く */
	drag(at: Pt): void {
		if (!this.mouse) return;
		this.mouse.setTarget(toM(at));
		this.mouse.getBodyB().setAwake(true);
		this.kick();
	}

	release(): void {
		if (!this.mouse) return;
		this.world.destroyJoint(this.mouse);
		this.mouse = null;
		this.kick();
	}

	get grabbed(): Body | null {
		return this.mouse ? this.mouse.getBodyB() : null;
	}

	// ---- 時間 ----

	addListener(l: FrameListener): () => void {
		this.listeners.add(l);
		this.kick();
		return () => this.listeners.delete(l);
	}

	/** ループを回す（止まっていれば始める） */
	kick(): void {
		if (this.frame || typeof window === 'undefined') return;
		this.last = performance.now();
		this.frame = requestAnimationFrame(this.tick);
	}

	/** 動きを見せずに n 刻み進める（動きを減らす設定で、着地した状態を一度に作るとき） */
	settle(n: number): void {
		for (let i = 0; i < n; i++) {
			for (const l of this.listeners) l.before?.(STEP);
			this.world.step(STEP, 10, 6);
		}
	}

	private tick = (now: number): void => {
		this.frame = 0;
		this.acc += Math.min((now - this.last) / 1000, STEP * MAX_STEPS);
		this.last = now;
		let n = 0;
		while (this.acc >= STEP && n < MAX_STEPS) {
			for (const l of this.listeners) l.before?.(STEP);
			this.world.step(STEP, 10, 6);
			this.acc -= STEP;
			n++;
		}
		let busy = this.mouse !== null;
		for (const l of this.listeners) if (l.after()) busy = true;
		if (!busy) {
			for (let b = this.world.getBodyList(); b; b = b.getNext()) {
				if (b.isDynamic() && b.isAwake()) {
					busy = true;
					break;
				}
			}
		}
		if (busy) {
			this.last = now;
			this.frame = requestAnimationFrame(this.tick);
		} else {
			this.acc = 0;
		}
	};
}

let instance: BoardWorld | null = null;

/** ボードの物理の世界（ページに 1 つ）。island どうしで同じものを使う */
export function boardWorld(): BoardWorld {
	if (!instance) instance = new BoardWorld();
	return instance;
}

export type { BoardWorld };
