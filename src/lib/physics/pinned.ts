// ポップアップ（ステートメントのシート、作品概要のパネル）を、有孔ボードの孔に留めたカードとして動かす。
// 物理は planck.js（Box2D）。ポップアップは画面に固定された重ね合わせなので、ボードの世界（board-world.ts）には入れず、
// カードごとに小さな世界を持つ（座標はポップアップの座標の px）。
// ・開く：カードは画面の上の外から、斜めに傾いて回りながら落ちてきて、ペグからのワイヤー（ロープ関節）に受け止められ、
//   振れて水平に戻って止まる。ペグより上ではワイヤーはたるんでいて引かない（ロープの長さを、届く距離より長くしておく）
//   読むためのカードなので、揺れは数秒で収める。傾きは 2 本のワイヤーで自然に水平へ戻る（回す中心は最初の孔）
// ・つかめる：マウス関節でつかんで動かせる。つかんでいるあいだはワイヤーが伸び、離すと元の長さへ巻き戻りながら戻る
// ・閉じる：ワイヤーを巻き取りながら、上へ引き上げる
// DOM には触らず、位置（静止した位置からのずれ）と、描くためのワイヤーの形だけを返す
import { Box, MouseJoint, RopeJoint, Vec2, World, type Body } from 'planck';
import { stepWire, wireCable, type Cable, type Pt } from './cable';
import { GRAVITY_PX, SCALE, capVelocity, m, toM, toPx } from './board-world';

export type PinnedPhase = 'falling' | 'hanging' | 'lifting' | 'gone';

/** 1 刻みの時間。step() 1 回（1 フレーム）で 2 刻み進める */
const STEP = 1 / 120;
/** ワイヤーに受け止められたあとの揺れの減り方。大きいほど早く止まる */
const HANG_DAMPING = 3.4;
/** つかんでいるとき、ワイヤーが元の長さからこれだけ（px）まで伸びる */
const HOLD_STRETCH = 160;
/** 離したときの速さの上限（px/秒、ラジアン/秒）。投げ出されて大きく振れないように */
const RELEASE_MAX_SPEED = 450;
const RELEASE_MAX_SPIN = 2.5;

interface Wire {
	peg: Pt;
	/** カードの原点から吊られる側の孔までのずれ（px） */
	local: Pt;
	/** 静止したときの長さ（px） */
	L: number;
	/** いまのロープの長さ（px） */
	cur: number;
	joint: RopeJoint;
	/** 描くためのワイヤー */
	cable: Cable;
	end: Pt;
}

export class PinnedCard {
	phase: PinnedPhase = 'hanging';
	private world = new World({ gravity: Vec2(0, GRAVITY_PX / SCALE) });
	private ground: Body;
	private body: Body;
	/** 静止した位置（最初の孔） */
	private home: Pt;
	private wires: Wire[];
	private mouse: MouseJoint | null = null;
	/** 引き上げ：速さ（px/秒）と、ここまで上がったら終わり（原点の y） */
	private liftV = 0;
	private liftEnd = 0;
	private onGone: (() => void) | null = null;
	/** 静かなフレームが続いた数 */
	private quiet = 0;

	/**
	 * holes は吊られる側の孔、pegs は板の孔、rect はカードの外形（どれも同じ座標系。カードが下りきった位置）。
	 * rect がなければ傾かない（平行に振れるだけ）
	 */
	constructor(holes: Pt[], pegs: Pt[], rect?: { x: number; y: number; w: number; h: number }) {
		this.home = { ...holes[0] };
		this.ground = this.world.createBody();
		this.body = this.world.createBody({
			type: 'dynamic',
			position: toM(this.home),
			fixedRotation: !rect,
			linearDamping: 1.1,
			angularDamping: 4,
		});
		// 形は重さと回りにくさを決めるだけ（ほかの物とはぶつからない）。原点は最初の孔なので、外形の中心へずらして置く
		if (rect) {
			const c = { x: rect.x + rect.w / 2 - this.home.x, y: rect.y + Math.max(rect.h, 120) / 2 - this.home.y };
			this.body.createFixture(new Box(m(rect.w) / 2, m(Math.max(rect.h, 120)) / 2, toM(c), 0), { density: 1 });
		} else {
			this.body.createFixture(new Box(2, 1), { density: 1 });
		}
		this.wires = holes.map((h, i) => {
			const peg = { ...pegs[i] };
			const local = { x: h.x - this.home.x, y: h.y - this.home.y };
			const L = Math.max(4, Math.hypot(h.x - peg.x, h.y - peg.y));
			const joint = this.world.createJoint(
				new RopeJoint({ bodyA: this.ground, bodyB: this.body, localAnchorA: toM(peg), localAnchorB: toM(local), maxLength: m(L) }),
			) as RopeJoint;
			const end = { ...h };
			const cable = wireCable(() => peg, () => end, L);
			return { peg, local, L, cur: L, joint, cable, end };
		});
	}

	/** いまのずれ（静止した位置から） */
	get offset(): Pt {
		const p = toPx(this.body.getPosition());
		return { x: p.x - this.home.x, y: p.y - this.home.y };
	}

	/** いまの傾き（ラジアン。回す中心は最初の孔） */
	get angle(): number {
		return this.body.getAngle();
	}

	private setLen(w: Wire, len: number): void {
		if (Math.abs(w.cur - len) < 0.05) return;
		w.cur = len;
		w.joint.setMaxLength(m(Math.max(len, 1)));
	}

	/** いまの孔とペグの距離 */
	private dist(w: Wire): number {
		const p = toPx(this.body.getWorldPoint(toM(w.local)));
		return Math.hypot(p.x - w.peg.x, p.y - w.peg.y);
	}

	/**
	 * 上から落とす。above は静止した位置からどれだけ上に置くか（画面の外まで）、
	 * side は横のずれ（受け止められたあとに振れる大きさ）
	 */
	drop(above: number, side: number): void {
		this.release();
		const b = this.body;
		// 引き上げの途中なら、いまの位置からそのまま落とす
		if (this.phase !== 'lifting') {
			// 少し傾けて落とす（受け止められると 2 本のワイヤーで水平に戻る）
			const tilt = (side >= 0 ? -1 : 1) * (0.08 + Math.random() * 0.08);
			b.setTransform(toM({ x: this.home.x + side, y: this.home.y - above }), tilt);
			// 最初から勢いを付けて落とす（のんびり落ちてこないように）
			b.setLinearVelocity(Vec2(m(-side * 0.8), m(1500)));
			b.setAngularVelocity(-tilt * 1.5);
		} else {
			b.setLinearVelocity(Vec2(0, 0));
		}
		b.setGravityScale(1);
		this.phase = 'falling';
		this.quiet = 0;
		b.setAwake(true);
		// ペグより上にいるあいだは、ワイヤーはたるんでいて引かない
		for (const w of this.wires) this.setLen(w, Math.max(w.L, this.dist(w) + 4));
		this.syncEnds();
	}

	/** 動きを省いて、静止した位置に置く */
	place(): void {
		this.release();
		const b = this.body;
		b.setTransform(toM(this.home), 0);
		b.setLinearVelocity(Vec2(0, 0));
		b.setAngularVelocity(0);
		b.setGravityScale(1);
		for (const w of this.wires) this.setLen(w, w.L);
		this.phase = 'hanging';
		this.quiet = 0;
		this.syncEnds();
		for (const w of this.wires) {
			w.cable.relen(w.L);
			w.cable.settle(40);
		}
	}

	/** ワイヤーを巻き取って引き上げる。above まで上がったら done */
	lift(above: number, done: () => void): void {
		this.release();
		this.phase = 'lifting';
		this.liftV = 120;
		this.liftEnd = this.home.y - above;
		this.onGone = done;
		this.body.setGravityScale(0);
		this.body.setAwake(true);
		// 引き上げているあいだ、ロープでは引かない（ペグを越えて上へ抜けられるように）。ワイヤーは見た目だけ巻き取る
		for (const w of this.wires) this.setLen(w, 100000);
	}

	/** つかみ始め。p は指の位置 */
	hold(p: Pt): void {
		if (this.phase === 'lifting' || this.phase === 'gone') return;
		this.release();
		this.phase = 'hanging';
		this.body.setAwake(true);
		const mass = this.body.getMass();
		this.mouse = this.world.createJoint(
			new MouseJoint({ maxForce: 6000 * mass * (GRAVITY_PX / SCALE), frequencyHz: 14, dampingRatio: 0.85 }, this.ground, this.body, toM(p)),
		) as MouseJoint;
	}
	move(p: Pt): void {
		if (!this.mouse) return;
		this.mouse.setTarget(toM(p));
		this.body.setAwake(true);
	}
	release(): void {
		if (!this.mouse) return;
		this.world.destroyJoint(this.mouse);
		this.mouse = null;
		capVelocity(this.body, RELEASE_MAX_SPEED, RELEASE_MAX_SPIN);
	}
	get held(): boolean {
		return this.mouse !== null;
	}

	/** 1 フレーム進める。動いていれば true（止まっていれば描き直さなくてよい） */
	step(): boolean {
		if (this.phase === 'gone') return false;
		const b = this.body;
		for (let k = 0; k < 2; k++) {
			if (this.phase === 'lifting') {
				// 巻き取り：だんだん速く引き上げ、ワイヤーはそのぶん短くする。横の揺れは収める
				this.liftV = Math.min(this.liftV * 1.06 + 40, 3600);
				const p = toPx(b.getPosition());
				b.setLinearVelocity(Vec2(m((this.home.x - p.x) * 6), m(-this.liftV)));
				b.setAngularVelocity(-b.getAngle() * 8);
			} else {
				// 落ちているあいだ（孔がペグより上）は空気抵抗をほぼなくし、受け止めたあとは揺れを早めに収める（数秒以内）
				const below = this.wires.every((w) => toPx(b.getWorldPoint(toM(w.local))).y >= w.peg.y);
				// 強くしすぎると、引っぱって離したときにのろのろ戻る。ばねのように戻って、数回振れて止まるくらい
				b.setLinearDamping(below ? HANG_DAMPING : 0.05);
				// 落ちているあいだ（ペグより上）は重力を強くして、すばやく下りてくる。受け止められたら元の重力
				b.setGravityScale(below ? 1 : 2.2);
				for (const w of this.wires) {
					const end = toPx(b.getWorldPoint(toM(w.local)));
					const d = Math.hypot(end.x - w.peg.x, end.y - w.peg.y);
					if (this.mouse) {
						// つかんでいるあいだはワイヤーが伸びる。ただし HOLD_STRETCH まで（画面の端まで引っぱれない）。離すと、そのときの長さから巻き戻す。
						// 落ちている途中でつかんだときは、いまの距離より短くして急に引き戻さないよう、近づいた分だけ縮めていく
						this.setLen(w, Math.max(w.L + HOLD_STRETCH, Math.min(w.cur, d + 4)));
					} else if (this.phase === 'falling' && end.y < w.peg.y) {
						// ペグより上：たるんでいる
						this.setLen(w, Math.max(w.L, d + 4));
					} else if (w.cur > w.L) {
						// ペグの下へ来たら受け止める。伸びていたら元の長さへ巻き戻す
						// 伸びたワイヤーは、すばやく元の長さへ巻き戻す（遠いほど速く）
						const base = Math.min(w.cur, d);
						this.setLen(w, Math.max(w.L, base + (w.L - base) * (1 - Math.exp(-9 * STEP)) - 900 * STEP));
					}
				}
			}
			this.world.step(STEP, 8, 4);
		}
		this.syncEnds();
		// 描くためのワイヤー：ペグより上ではたるんでうねるよう長め、そうでなければロープの長さ（張っていればその距離）。
		// 引き上げているあいだは巻き取られて、ペグから孔までぴんと張る
		let cableMoving = false;
		for (const w of this.wires) {
			if (this.phase === 'lifting') {
				const d = Math.hypot(w.end.x - w.peg.x, w.end.y - w.peg.y);
				w.cable.relen(Math.max(1, d));
				w.cable.step();
				continue;
			}
			// ペグより上ではたるんでうねるよう長め。つかんでいるあいだ（ロープで引いていない）は元の長さを基準にする
			const loose = w.end.y < w.peg.y ? 1.2 : 1;
			const rest = this.mouse ? w.L : w.cur;
			if (stepWire(w.cable, rest, null, loose)) cableMoving = true;
		}
		if (this.phase === 'lifting') {
			if (toPx(b.getPosition()).y <= this.liftEnd) {
				this.phase = 'gone';
				const done = this.onGone;
				this.onGone = null;
				done?.();
			}
			return true;
		}
		const v = b.getLinearVelocity();
		const speed = Math.hypot(v.x, v.y) * SCALE;
		const spin = Math.abs(b.getAngularVelocity()) + Math.abs(b.getAngle()) * 2;
		const moving = this.mouse !== null || speed > 3 || spin > 0.01 || cableMoving || this.wires.some((w) => w.cur > w.L);
		this.quiet = moving ? 0 : this.quiet + 1;
		if (this.phase === 'falling' && this.quiet > 20) this.phase = 'hanging';
		if (this.quiet > 40) {
			// 止まりきったら、静止した位置の近くならぴったり置く（小さな誤差を残さない）
			const o = this.offset;
			if (Math.hypot(o.x, o.y) < 1.5 && Math.abs(b.getAngle()) < 0.01) b.setTransform(toM(this.home), 0);
			b.setLinearVelocity(Vec2(0, 0));
			b.setAngularVelocity(0);
			this.syncEnds();
			return false;
		}
		return true;
	}

	/** 糸の本数ぶんの、描くための形 */
	strings(): { path: string; end: Pt; peg: Pt }[] {
		return this.wires.map((w) => ({ path: w.cable.path(), end: { ...w.end }, peg: w.peg }));
	}

	private syncEnds(): void {
		for (const w of this.wires) {
			const p = toPx(this.body.getWorldPoint(toM(w.local)));
			w.end.x = p.x;
			w.end.y = p.y;
		}
	}
}
