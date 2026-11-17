// ワイヤー（Verlet 積分のロープ）。先頭はペグに固定し、残りの点は重力で垂れる。
// 抜けたワイヤーは、長さを縮めながら上へ跳ねて、短く垂れた状態に落ち着く。
// 先をつまむと（pull）指まで伸びてうねりながら追い、離すと（release）縮んで垂れ戻る。
// 点の数と減衰は、引継ぎ資料の ib/cable.js（B3・B5）のうねり方に合わせてある
import { smoothPath, type Pt } from './cable';

interface Point {
	x: number;
	y: number;
	px: number;
	py: number;
}

/** 1 刻み（1/240 秒）ごとの速さの残り方。1 に近いほど長くうねる */
const DAMP = 0.996;
/** つまんで引いているときのたるみ */
const PULL_SLACK = 1.1;
/** 長さを target に寄せる速さ（1/秒）。離したあとは、垂れ落ちながらゆっくり巻き戻す */
const RATE = 14;
const RELEASE_RATE = 2.5;

export class Rope {
	readonly pts: Point[];
	/** いまの 1 区間の長さ。target に向けて縮める・伸ばす */
	private seg: number;
	private target: number;
	/** 垂れているときの 1 区間の長さ */
	private rest: number;
	/** 先をつまんでいる点。null なら自由端 */
	private pin: Pt | null = null;
	private rate = RATE;
	private quietTime = 0;
	sleeping = false;

	/**
	 * (ax, ay) はペグ、(bx, by) は抜けた瞬間の先端。length は落ち着いたときの長さ
	 */
	constructor(ax: number, ay: number, bx: number, by: number, length: number, n = 16) {
		this.pts = [];
		for (let i = 0; i < n; i++) {
			const t = i / (n - 1);
			const x = ax + (bx - ax) * t;
			const y = ay + (by - ay) * t;
			this.pts.push({ x, y, px: x, py: y });
		}
		this.seg = Math.hypot(bx - ax, by - ay) / (n - 1);
		this.rest = length / (n - 1);
		this.target = this.rest;
	}

	/** 先端に上向きの勢いを与える（抜けた瞬間に跳ねる）。先ほど強い */
	kick(speed: number, h: number): void {
		const n = this.pts.length;
		this.pts.forEach((p, i) => {
			p.py = p.y + speed * h * (i / (n - 1));
			p.px = p.x + (Math.random() - 0.5) * speed * 0.3 * h * (i / (n - 1));
		});
		this.wake();
	}

	/** 先をつまんで (x, y) まで引く。届くまで伸びる */
	pull(x: number, y: number): void {
		this.pin = { x, y };
		this.rate = RATE;
		const a = this.pts[0];
		this.target = Math.max(this.rest, (Math.hypot(x - a.x, y - a.y) * PULL_SLACK) / (this.pts.length - 1));
		this.wake();
	}

	/** 先を離す。もとの長さへ縮みながら垂れ戻る */
	release(): void {
		this.pin = null;
		this.target = this.rest;
		this.rate = RELEASE_RATE;
		this.wake();
	}

	get pulled(): boolean {
		return this.pin !== null;
	}

	/** (x, y) から半径 r の中の点を外へ押し出す（指でなでると揺れる）。押したら true */
	push(x: number, y: number, r: number): boolean {
		let hit = false;
		for (let i = 1; i < this.pts.length; i++) {
			const p = this.pts[i];
			const dx = p.x - x;
			const dy = p.y - y;
			const d = Math.hypot(dx, dy);
			if (d < r && d > 0) {
				p.x += (dx / d) * (r - d) * 0.5;
				p.y += (dy / d) * (r - d) * 0.5;
				hit = true;
			}
		}
		if (hit) this.wake();
		return hit;
	}

	wake(): void {
		this.sleeping = false;
		this.quietTime = 0;
	}

	step(h: number, gravity: number): void {
		if (this.sleeping) return;
		this.seg += (this.target - this.seg) * (1 - Math.exp(-this.rate * h));
		const n = this.pts.length;
		const last = this.pin ? n - 1 : n;
		let move = 0;
		for (let i = 1; i < last; i++) {
			const p = this.pts[i];
			const vx = (p.x - p.px) * DAMP;
			const vy = (p.y - p.py) * DAMP;
			p.px = p.x;
			p.py = p.y;
			p.x += vx;
			p.y += vy + gravity * h * h;
			move = Math.max(move, Math.abs(vx) + Math.abs(vy));
		}
		for (let it = 0; it < 10; it++) {
			if (this.pin) {
				const e = this.pts[n - 1];
				e.x = e.px = this.pin.x;
				e.y = e.py = this.pin.y;
			}
			for (let i = 0; i < n - 1; i++) {
				const a = this.pts[i];
				const b = this.pts[i + 1];
				const dx = b.x - a.x;
				const dy = b.y - a.y;
				const d = Math.hypot(dx, dy) || 1e-6;
				const diff = (d - this.seg) / d;
				const fixA = i === 0;
				const fixB = this.pin !== null && i + 1 === n - 1;
				if (fixA && fixB) continue;
				if (fixA) {
					// 先頭はペグに固定
					b.x -= dx * diff;
					b.y -= dy * diff;
				} else if (fixB) {
					a.x += dx * diff;
					a.y += dy * diff;
				} else {
					a.x += dx * diff * 0.5;
					a.y += dy * diff * 0.5;
					b.x -= dx * diff * 0.5;
					b.y -= dy * diff * 0.5;
				}
			}
		}
		if (!this.pin && move < 0.02 && Math.abs(this.seg - this.target) < 0.05) {
			this.quietTime += h;
			if (this.quietTime > 0.3) this.sleeping = true;
		} else {
			this.quietTime = 0;
		}
	}

	/** 落ち着いた状態（ペグから真下に垂れる）にすぐ置く */
	settle(): void {
		this.pin = null;
		this.target = this.seg = this.rest;
		const a = this.pts[0];
		this.pts.forEach((p, i) => {
			p.x = p.px = a.x;
			p.y = p.py = a.y + this.seg * i;
		});
		this.sleeping = true;
	}

	get end(): { x: number; y: number } {
		return this.pts[this.pts.length - 1];
	}

	/** 先端の区間の向き（ラジアン。真下が 0、時計回りが正） */
	get endAngle(): number {
		const n = this.pts.length;
		const a = this.pts[n - 2];
		const b = this.pts[n - 1];
		return Math.atan2(-(b.x - a.x), b.y - a.y);
	}

	/** SVG の path の d（点の間をなめらかにつなぐ） */
	toPath(): string {
		return smoothPath(this.pts);
	}
}
