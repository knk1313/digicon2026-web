// 落ちる物体（重力、回転、床・壁・ほかの物体との当たり）。
// 形は凸多角形。速度の拘束を逐次インパルスで解き、そのあと位置のめり込みを直す。
// 座標は画面と同じ（y は下が正）。角度は正で時計回り（SVG の rotate と同じ）
import type { Vec } from './glyph';

export interface Shape {
	/** 重心を原点にした凸包。内側が辺の左になる向き */
	hull: Vec[];
	area: number;
	/** 重心まわりの慣性モーメント（密度 1） */
	inertia: number;
	radius: number;
}

export class Body {
	x = 0;
	y = 0;
	/** 角度（ラジアン） */
	a = 0;
	vx = 0;
	vy = 0;
	w = 0;
	readonly mass: number;
	readonly inertia: number;
	/** true のあいだは物理で動かさない（吊られている・つままれている）。ほかの物体からは動かない壁に見える */
	kinematic = false;
	/** 止まって眠っている。起こされるまで動かない */
	sleeping = false;
	private quiet = 0;
	/** 世界座標の凸包。updateWorld で更新する */
	readonly world: Vec[];

	constructor(readonly shape: Shape) {
		// 密度は面積に比例させるが、数の大きさをそろえるため小さくしておく
		this.mass = shape.area * 0.001;
		this.inertia = shape.inertia * 0.001;
		this.world = shape.hull.map(() => ({ x: 0, y: 0 }));
	}

	get invM(): number {
		return this.kinematic || this.sleeping ? 0 : 1 / this.mass;
	}
	get invI(): number {
		return this.kinematic || this.sleeping ? 0 : 1 / this.inertia;
	}
	get dynamic(): boolean {
		return !this.kinematic && !this.sleeping;
	}

	wake(): void {
		this.sleeping = false;
		this.quiet = 0;
	}

	/** 局所座標の点を世界座標へ */
	toWorld(p: Vec): Vec {
		const c = Math.cos(this.a);
		const s = Math.sin(this.a);
		return { x: this.x + p.x * c - p.y * s, y: this.y + p.x * s + p.y * c };
	}

	/** 世界座標の点を局所座標へ */
	toLocal(p: Vec): Vec {
		const c = Math.cos(this.a);
		const s = Math.sin(this.a);
		const dx = p.x - this.x;
		const dy = p.y - this.y;
		return { x: dx * c + dy * s, y: -dx * s + dy * c };
	}

	updateWorld(): void {
		const c = Math.cos(this.a);
		const s = Math.sin(this.a);
		const h = this.shape.hull;
		for (let i = 0; i < h.length; i++) {
			this.world[i].x = this.x + h[i].x * c - h[i].y * s;
			this.world[i].y = this.y + h[i].x * s + h[i].y * c;
		}
	}

	/** 世界座標の凸包の下端 */
	bottom(): number {
		let m = -Infinity;
		for (const p of this.world) m = Math.max(m, p.y);
		return m;
	}

	/** 眠るかどうかを数える。動きが小さい時間が続いたら眠らせる */
	countQuiet(h: number): void {
		if (this.vx * this.vx + this.vy * this.vy < 12 * 12 && Math.abs(this.w) < 0.15) {
			this.quiet += h;
			if (this.quiet > 0.4) {
				this.sleeping = true;
				this.vx = this.vy = this.w = 0;
			}
		} else {
			this.quiet = 0;
		}
	}
}

/** 動ける範囲。床は物体の下端が越えない線 */
export interface Bounds {
	floor: number;
	left: number;
	right: number;
}

interface Contact {
	a: Body;
	/** null なら床か壁 */
	b: Body | null;
	/** b から a へ向く法線 */
	nx: number;
	ny: number;
	depth: number;
	rax: number;
	ray: number;
	rbx: number;
	rby: number;
	kn: number;
	kt: number;
	jn: number;
	jt: number;
	target: number;
}

const RESTITUTION = 0.12;
const FRICTION = 0.6;
const ITERATIONS = 10;
/** この距離まで離れている接点も、先に拾っておく */
const MARGIN = 2;
/** 触れているあいだの回転の減り方（1 秒あたり） */
const ROLLING = 7;

export class World {
	bodies: Body[] = [];
	gravity = 2600;

	constructor(public bounds: Bounds) {}

	/** 動いている物体がない */
	get quiet(): boolean {
		return this.bodies.every((b) => !b.dynamic);
	}

	wakeAll(): void {
		for (const b of this.bodies) if (!b.kinematic) b.wake();
	}

	/** 1 刻み進める（h 秒） */
	step(h: number): void {
		const g = this.gravity;
		for (const b of this.bodies) {
			if (!b.dynamic) continue;
			b.vy += g * h;
			// 空気の抵抗の代わりにごくわずかに減らす
			const damp = Math.exp(-0.15 * h);
			b.vx *= damp;
			b.vy *= damp;
			b.w *= Math.exp(-0.6 * h);
		}

		// 少し離れている接点も先に拾う（めり込みを直したあとでも、次の刻みで速度を止められるように）
		const contacts = this.detect(MARGIN);
		for (const c of contacts) this.prepare(c, h);
		for (let it = 0; it < ITERATIONS; it++) for (const c of contacts) this.solve(c);

		// 転がり抵抗：字の凸包は丸いので、何かに触れているあいだは回転と横すべりを弱める
		const touching = new Set<Body>();
		for (const c of contacts) {
			touching.add(c.a);
			if (c.b) touching.add(c.b);
		}
		for (const b of touching) {
			if (!b.dynamic) continue;
			b.w *= Math.exp(-ROLLING * h);
			b.vx *= Math.exp(-ROLLING * 0.5 * h);
		}

		for (const b of this.bodies) {
			if (!b.dynamic) continue;
			b.x += b.vx * h;
			b.y += b.vy * h;
			b.a += b.w * h;
		}

		// めり込みを直す
		for (let it = 0; it < 3; it++) {
			for (const c of this.detect(0)) this.correct(c);
		}
		this.clampToBounds();

		for (const b of this.bodies) if (b.dynamic) b.countQuiet(h);
		this.snapSleepersToFloor();
	}

	/** すべてが止まるまで進める（動きを減らす設定のときに、着地した状態を一度に作る） */
	settle(maxSeconds = 20, h = 1 / 240): void {
		for (let t = 0; t < maxSeconds && !this.quiet; t += h) this.step(h);
		for (const b of this.bodies) {
			if (b.kinematic) continue;
			b.sleeping = true;
			b.vx = b.vy = b.w = 0;
		}
		this.clampToBounds();
		this.snapSleepersToFloor();
	}

	/** 接点を集める。margin だけ離れているものも拾う（そのとき depth は負） */
	private detect(margin: number): Contact[] {
		const out: Contact[] = [];
		for (const b of this.bodies) b.updateWorld();
		const { floor, left, right } = this.bounds;
		for (const b of this.bodies) {
			if (!b.dynamic) continue;
			for (const p of b.world) {
				if (p.y > floor - margin) out.push(contact(b, null, p, 0, -1, p.y - floor));
				if (p.x < left + margin) out.push(contact(b, null, p, 1, 0, left - p.x));
				if (p.x > right - margin) out.push(contact(b, null, p, -1, 0, p.x - right));
			}
		}
		const n = this.bodies.length;
		for (let i = 0; i < n; i++) {
			for (let j = i + 1; j < n; j++) {
				const a = this.bodies[i];
				const b = this.bodies[j];
				if (!a.dynamic && !b.dynamic) continue;
				collide(a, b, out, margin);
			}
		}
		return out;
	}

	private prepare(c: Contact, h: number): void {
		const { a, b, nx, ny } = c;
		{
			// 眠っている相手に強く当たったら起こす（質量を決める前に）
			const [dvx, dvy] = relVel(c);
			const vn = dvx * nx + dvy * ny;
			if (b && b.sleeping && vn < -60) b.wake();
			if (a.sleeping && vn < -60) a.wake();
		}
		const tx = -ny;
		const ty = nx;
		const ran = c.rax * ny - c.ray * nx;
		const rat = c.rax * ty - c.ray * tx;
		let kn = a.invM + a.invI * ran * ran;
		let kt = a.invM + a.invI * rat * rat;
		if (b) {
			const rbn = c.rbx * ny - c.rby * nx;
			const rbt = c.rbx * ty - c.rby * tx;
			kn += b.invM + b.invI * rbn * rbn;
			kt += b.invM + b.invI * rbt * rbt;
		}
		c.kn = kn > 0 ? 1 / kn : 0;
		c.kt = kt > 0 ? 1 / kt : 0;
		const [dvx, dvy] = relVel(c);
		const vn = dvx * nx + dvy * ny;
		if (c.depth < 0) {
			// まだ離れている：この刻みで隙間を詰める分までは近づいてよい
			c.target = c.depth / h;
		} else {
			// 強くぶつかったときだけ少し跳ねる
			c.target = vn < -120 ? -RESTITUTION * vn : 0;
		}
	}

	private solve(c: Contact): void {
		const { nx, ny } = c;
		let [dvx, dvy] = relVel(c);
		const vn = dvx * nx + dvy * ny;
		let jn = (c.target - vn) * c.kn;
		const old = c.jn;
		c.jn = Math.max(old + jn, 0);
		jn = c.jn - old;
		applyImpulse(c, nx * jn, ny * jn);

		[dvx, dvy] = relVel(c);
		const tx = -ny;
		const ty = nx;
		const vt = dvx * tx + dvy * ty;
		let jt = -vt * c.kt;
		const max = FRICTION * c.jn;
		const oldT = c.jt;
		c.jt = Math.max(-max, Math.min(max, oldT + jt));
		jt = c.jt - oldT;
		applyImpulse(c, tx * jt, ty * jt);
	}

	private correct(c: Contact): void {
		const { a, b, nx, ny } = c;
		const wall = b === null;
		const slop = wall ? 0 : 0.3;
		const beta = wall ? 0.8 : 0.4;
		const C = c.depth - slop;
		if (C <= 0) return;
		const ran = c.rax * ny - c.ray * nx;
		let k = a.invM + a.invI * ran * ran;
		let rbn = 0;
		if (b) {
			rbn = c.rbx * ny - c.rby * nx;
			k += b.invM + b.invI * rbn * rbn;
		}
		if (k <= 0) return;
		const p = (beta * C) / k;
		a.x += nx * p * a.invM;
		a.y += ny * p * a.invM;
		a.a += a.invI * ran * p;
		if (b) {
			b.x -= nx * p * b.invM;
			b.y -= ny * p * b.invM;
			b.a -= b.invI * rbn * p;
		}
		a.updateWorld();
		b?.updateWorld();
	}

	/** 床と壁は平行移動だけでぴったり押し戻す（字形の下端が床を越えないように） */
	private clampToBounds(): void {
		const { floor, left, right } = this.bounds;
		for (const b of this.bodies) {
			if (b.kinematic) continue;
			b.updateWorld();
			let minX = Infinity;
			let maxX = -Infinity;
			let maxY = -Infinity;
			for (const p of b.world) {
				minX = Math.min(minX, p.x);
				maxX = Math.max(maxX, p.x);
				maxY = Math.max(maxY, p.y);
			}
			if (maxY > floor) b.y -= maxY - floor;
			if (minX < left) b.x += left - minX;
			else if (maxX > right) b.x -= maxX - right;
			b.updateWorld();
		}
	}

	/** 眠った物体が床からわずかに浮いていたら、床に下ろす（浮かないように） */
	private snapSleepersToFloor(): void {
		const floor = this.bounds.floor;
		for (const b of this.bodies) {
			if (!b.sleeping) continue;
			const gap = floor - b.bottom();
			if (gap > 0 && gap < 1.5) {
				b.y += gap;
				b.updateWorld();
			}
		}
	}
}

function contact(a: Body, b: Body | null, p: Vec, nx: number, ny: number, depth: number): Contact {
	return {
		a,
		b,
		nx,
		ny,
		depth,
		rax: p.x - a.x,
		ray: p.y - a.y,
		rbx: b ? p.x - b.x : 0,
		rby: b ? p.y - b.y : 0,
		kn: 0,
		kt: 0,
		jn: 0,
		jt: 0,
		target: 0,
	};
}

/** a の接点の速度から b の接点の速度を引いたもの */
function relVel(c: Contact): [number, number] {
	const { a, b } = c;
	let x = a.vx - a.w * c.ray;
	let y = a.vy + a.w * c.rax;
	if (b) {
		x -= b.vx - b.w * c.rby;
		y -= b.vy + b.w * c.rbx;
	}
	return [x, y];
}

function applyImpulse(c: Contact, px: number, py: number): void {
	const { a, b } = c;
	a.vx += px * a.invM;
	a.vy += py * a.invM;
	a.w += a.invI * (c.rax * py - c.ray * px);
	if (b) {
		b.vx -= px * b.invM;
		b.vy -= py * b.invM;
		b.w -= b.invI * (c.rbx * py - c.rby * px);
	}
}

/**
 * 凸多角形どうしの当たり。片方の頂点がもう片方の内側に入っていたら、
 * いちばん近い辺から押し出す向きを接点の法線にする。深いものから 3 つまで
 */
function collide(a: Body, b: Body, out: Contact[], margin: number): void {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	const r = a.shape.radius + b.shape.radius + margin;
	if (dx * dx + dy * dy > r * r) return;
	const found: Contact[] = [];
	for (const p of a.world) {
		const hit = inside(b.world, p, margin);
		if (hit) found.push(contact(a, b, p, hit.nx, hit.ny, hit.depth));
	}
	for (const p of b.world) {
		const hit = inside(a.world, p, margin);
		if (hit) found.push(contact(a, b, p, -hit.nx, -hit.ny, hit.depth));
	}
	found.sort((u, v) => v.depth - u.depth);
	out.push(...found.slice(0, 3));
}

/**
 * 点が凸多角形の内側（外側 margin 以内も含む）なら、いちばん近い辺までの距離とその辺の外向きの法線を返す。
 * 外側にあるときの距離は負
 */
function inside(poly: Vec[], p: Vec, margin: number): { nx: number; ny: number; depth: number } | null {
	let best: { nx: number; ny: number; depth: number } | null = null;
	for (let i = 0; i < poly.length; i++) {
		const u = poly[i];
		const v = poly[(i + 1) % poly.length];
		const ex = v.x - u.x;
		const ey = v.y - u.y;
		const len = Math.hypot(ex, ey) || 1;
		// 内側は辺の左。左なら正
		const d = (ex * (p.y - u.y) - ey * (p.x - u.x)) / len;
		if (d < -margin) return null;
		if (!best || d < best.depth) best = { nx: ey / len, ny: -ex / len, depth: d };
	}
	return best;
}
