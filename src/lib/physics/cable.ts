// 結ぶケーブル。引継ぎ資料の B5「言葉の面」で使った ib/cable.js（Verlet のケーブル）を TypeScript にしたもの。
// 両端を関数で渡し、毎フレームその位置に留める。長さは両端の距離 × slack なので、たるんで垂れ、
// 端が動くとうねりながら追いかける。b を null にすると先が自由端になる。
// 時間は「1 フレーム = 1 刻み」で進める（モックと同じ手触りにするため）

export interface Pt {
	x: number;
	y: number;
}

interface Node extends Pt {
	px: number;
	py: number;
}

export interface CableOptions {
	/** 区間の数。多いほどなめらかにうねる */
	seg?: number;
	/** 両端の距離に対する長さの倍率。1 より大きいほどたるむ */
	slack?: number;
	/** 1 刻みごとの重力（px） */
	grav?: number;
	/** 速さの減り方。1 に近いほど長く揺れる */
	damp?: number;
	/** 長さをそろえる反復の回数 */
	iters?: number;
	/** これより短くはならない */
	minLen?: number;
}

export class Cable {
	readonly pts: Node[] = [];
	seg: number;
	slack: number;
	grav: number;
	damp: number;
	iters: number;
	minLen: number;
	/** 1 区間の長さ */
	private len = 0;

	constructor(
		public a: () => Pt,
		public b: (() => Pt) | null,
		o: CableOptions = {},
	) {
		this.seg = o.seg ?? 18;
		this.slack = o.slack ?? 1.12;
		this.grav = o.grav ?? 0.35;
		this.damp = o.damp ?? 0.97;
		this.iters = o.iters ?? 10;
		this.minLen = o.minLen ?? 10;
		const A = a();
		const B = b ? b() : { x: A.x, y: A.y + 100 };
		for (let i = 0; i <= this.seg; i++) {
			const t = i / this.seg;
			const x = A.x + (B.x - A.x) * t;
			const y = A.y + (B.y - A.y) * t;
			this.pts.push({ x, y, px: x, py: y });
		}
		this.relen();
	}

	/** 両端の距離から長さを決め直す（fixed を渡すとその長さ） */
	relen(fixed?: number): void {
		const A = this.a();
		const B = this.b ? this.b() : this.end;
		const d = fixed ?? Math.max(this.minLen, Math.hypot(B.x - A.x, B.y - A.y) * this.slack);
		this.len = d / this.seg;
	}

	get end(): Pt {
		return this.pts[this.seg];
	}

	/** 1 刻み進める。push を渡すと、その円の中の点を外へ押し出す（指でなでると揺れる） */
	step(push?: { x: number; y: number; r: number }): void {
		const P = this.pts;
		const s = this.seg;
		for (const p of P) {
			const vx = (p.x - p.px) * this.damp;
			const vy = (p.y - p.py) * this.damp;
			p.px = p.x;
			p.py = p.y;
			p.x += vx;
			p.y += vy + this.grav;
			if (push) {
				const dx = p.x - push.x;
				const dy = p.y - push.y;
				const d = Math.hypot(dx, dy);
				if (d < push.r && d > 0) {
					p.x += (dx / d) * (push.r - d) * 0.3;
					p.y += (dy / d) * (push.r - d) * 0.3;
				}
			}
		}
		for (let k = 0; k < this.iters; k++) {
			const A = this.a();
			P[0].x = A.x;
			P[0].y = A.y;
			if (this.b) {
				const B = this.b();
				P[s].x = B.x;
				P[s].y = B.y;
			}
			for (let i = 0; i < s; i++) {
				const p = P[i];
				const q = P[i + 1];
				const dx = q.x - p.x;
				const dy = q.y - p.y;
				const d = Math.hypot(dx, dy) || 1;
				const f = ((d - this.len) / d) * 0.5;
				if (i > 0) {
					p.x += dx * f;
					p.y += dy * f;
				}
				if (i + 1 < s || !this.b) {
					q.x -= dx * f;
					q.y -= dy * f;
				}
			}
		}
	}

	/** 何刻みか進めて、落ち着いた形にする（動きを減らす設定のときなど） */
	settle(n = 150): void {
		for (let i = 0; i < n; i++) this.step();
	}

	/** 真ん中の点（件数のラベルを置く） */
	mid(): Pt {
		return this.pts[this.seg >> 1];
	}

	/** 点 q がケーブルから r 以内か（押して抜く判定） */
	near(q: Pt, r: number): boolean {
		return this.pts.some((p) => Math.hypot(p.x - q.x, p.y - q.y) < r);
	}

	/** SVG の path の d */
	path(): string {
		return smoothPath(this.pts);
	}
}

/**
 * 吊るワイヤーの見た目（札・文字・ポップアップ）。少したるませ、減衰を弱くして、
 * 吊ったものが揺れると波が走り、なでると大きく揺れるようにする
 */
export const WIRE_LOOK = {
	/** 張っているときも、この倍率だけ長くして少したるませる */
	slack: 1.05,
	/** 速さの残り方（1 に近いほど長く揺れる） */
	damp: 0.975,
	grav: 0.45,
	iters: 8,
	/** マウスでなでたときに押しのける半径（px） */
	push: 22,
	/** 長さに応じた区間の数 */
	seg: (len: number) => Math.max(6, Math.min(18, Math.round(len / 12))),
};

/** 吊るワイヤーの見た目を作る。a はペグ、b は吊られる側の孔（どちらも毎フレーム読む） */
export function wireCable(a: () => Pt, b: () => Pt, len: number): Cable {
	const c = new Cable(a, b, { seg: WIRE_LOOK.seg(len), grav: WIRE_LOOK.grav, damp: WIRE_LOOK.damp, iters: WIRE_LOOK.iters });
	c.relen(len * WIRE_LOOK.slack);
	c.settle(80);
	return c;
}

/**
 * 吊るワイヤーの見た目を 1 フレーム進める。rest は張ったときの長さ（ロープの長さ）、ptr はなでている点。
 * 動いていれば true
 */
export function stepWire(c: Cable, rest: number, ptr: Pt | null, loose = 1): boolean {
	const A = c.a();
	const B = c.b ? c.b() : c.end;
	const d = Math.hypot(B.x - A.x, B.y - A.y);
	c.relen(Math.max(rest * WIRE_LOOK.slack, d * 1.02) * loose);
	const before = c.mid();
	const bx = before.x;
	const by = before.y;
	c.step(ptr ? { x: ptr.x, y: ptr.y, r: WIRE_LOOK.push } : undefined);
	const after = c.mid();
	return Math.abs(after.x - bx) + Math.abs(after.y - by) > 0.05;
}

/** 点の列を、中点を通る 2 次ベジェでつないだ SVG の path の d（canvas 版の path() と同じ曲線） */
export function smoothPath(P: readonly Pt[]): string {
	if (P.length < 2) return '';
	const f = (v: number) => v.toFixed(1);
	let d = `M${f(P[0].x)},${f(P[0].y)}`;
	for (let i = 1; i < P.length - 1; i++) {
		d += ` Q${f(P[i].x)},${f(P[i].y)} ${f((P[i].x + P[i + 1].x) / 2)},${f((P[i].y + P[i + 1].y) / 2)}`;
	}
	const last = P[P.length - 1];
	return `${d} L${f(last.x)},${f(last.y)}`;
}
