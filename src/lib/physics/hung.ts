// 吊られた札（パネル・カード・ナビなど）の物理。引継ぎ資料のデモ集の ib/mobile.js を TypeScript にしたもの。
// ・札は重さのある点（Verlet）。糸は「伸びすぎない」制約だけで、ゆるむことはある
// ・糸が1本なら、糸の向きに合わせて傾く。2本以上なら傾けず、平行に揺れる
// ・つかんでいるあいだは、つかんだ点が指の真下に来る。糸はそのぶん伸び、離すと元の長さへ戻りながら揺れる
// ・札どうしは重ならない（長方形どうしの押し出し）。モックにはなかったので、ここで足した
// ・時間は「1 フレーム = 1 刻み」で進める（モックと同じ手触りにするため）
import { Cable, type Pt } from './cable';

export interface HungString {
	/** ペグ（板の孔）の位置 */
	a: Pt;
	/** 札の原点から吊られる側の孔までのずれ */
	off: Pt;
	/** 静止したときの糸の長さ */
	L: number;
	/** 吊られる側の孔のいまの位置 */
	end: Pt;
	/** 描くための糸（ロープ） */
	cable: Cable;
}

/** 札の外形（静止した位置での長方形） */
export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface HungBody {
	/** 原点（最初の糸の吊られる側の孔）の、静止した位置 */
	home: Pt;
	pos: Pt;
	prev: Pt;
	/** 傾き（ラジアン） */
	rot: number;
	strings: HungString[];
	/** 静かなフレームが続いた数（眠らせる判定） */
	quiet: number;
	/** 静止した位置での外形。あればほかの札とぶつかる */
	rect?: Rect;
	/** ほかの札に押されているあいだ（残りフレーム数）。糸がやわらかく伸びて、押しのけられる */
	pushed: number;
}

/** 押されているあいだの糸の硬さ（1 で伸びない。小さいほど伸びて押しのけられる） */
const PUSHED_STIFFNESS = 0.12;

const GRAVITY = 0.6;
const DAMP = 0.985;

/** 札を作る。holes は吊られる側の孔、pegs は対応するペグ（どちらも同じ座標系） */
export function createBody(holes: Pt[], pegs: Pt[], rect?: Rect): HungBody {
	const home = { ...holes[0] };
	const strings = holes.map((h, i) => {
		const a = { ...pegs[i] };
		const L = Math.max(6, Math.hypot(h.x - a.x, h.y - a.y));
		const end = { ...h };
		const cable = new Cable(
			() => a,
			() => end,
			{ seg: Math.max(3, Math.min(14, Math.round(L / 26))), grav: 0.35, damp: 0.9, iters: 8 },
		);
		cable.relen(L);
		cable.settle(60);
		return { a, off: { x: h.x - home.x, y: h.y - home.y }, L, end, cable };
	});
	return { home, pos: { ...home }, prev: { ...home }, rot: 0, strings, quiet: 0, rect, pushed: 0 };
}

/** 札をいまの速さのまま押す（スクロールで揺らすときなど） */
export function nudge(b: HungBody, vx: number, vy: number): void {
	b.prev.x -= vx;
	b.prev.y -= vy;
	b.quiet = 0;
}

/**
 * 糸が伸びすぎていたら、札を引き戻す。押されているあいだは糸がやわらかく伸びる。
 * slackAbove が true なら、吊られる側の孔がペグより上にあるあいだ糸はたるんでいて引かない（上から落ちてくるとき）
 */
export function constrain(b: HungBody, iterations = 3, slackAbove = false): void {
	const n = b.strings.length;
	const k0 = b.pushed > 0 ? PUSHED_STIFFNESS : 1;
	for (let k = 0; k < iterations; k++) {
		for (const s of b.strings) {
			const ax = b.pos.x + s.off.x - s.a.x;
			const ay = b.pos.y + s.off.y - s.a.y;
			if (slackAbove && ay < 0) continue;
			const d = Math.hypot(ax, ay);
			if (d > s.L) {
				const c = ((d - s.L) / d / n) * k0;
				b.pos.x -= ax * c;
				b.pos.y -= ay * c;
			}
		}
	}
}

/** 吊られる側の孔の位置を、札のいまの位置に合わせる */
export function syncEnds(b: HungBody): void {
	for (const s of b.strings) {
		s.end.x = b.pos.x + s.off.x;
		s.end.y = b.pos.y + s.off.y;
	}
}

/**
 * 1 刻み進める。held を渡すと、その位置へ原点を動かす（つかんでいる）。
 * 動いていれば true
 */
export function stepBody(b: HungBody, held: Pt | null, gravity = GRAVITY, slackAbove = false): boolean {
	if (b.pushed > 0) b.pushed--;
	if (held) {
		b.prev = { ...b.pos };
		b.pos = { ...held };
		b.rot *= 0.7;
	} else {
		const vx = (b.pos.x - b.prev.x) * DAMP;
		const vy = (b.pos.y - b.prev.y) * DAMP;
		b.prev = { ...b.pos };
		b.pos.x += vx;
		b.pos.y += vy + gravity;
		constrain(b, 3, slackAbove);
		// 糸が1本なら糸の向きに傾く。2本以上はまっすぐのまま
		const tgt = b.strings.length === 1 ? -Math.atan2(b.pos.x - b.strings[0].a.x, b.pos.y - b.strings[0].a.y) * 0.8 : 0;
		b.rot += (tgt - b.rot) * 0.25;
	}
	return stepStrings(b, held !== null, slackAbove);
}

/**
 * 糸（描くためのロープ）を進める。動いていれば true。
 * slackAbove のとき、孔がペグより上にある糸は、たるんでうねるよう長めにする
 */
export function stepStrings(b: HungBody, held: boolean, slackAbove = false): boolean {
	syncEnds(b);
	let cableMove = 0;
	for (const s of b.strings) {
		const d = Math.hypot(s.end.x - s.a.x, s.end.y - s.a.y);
		const loose = slackAbove && s.end.y < s.a.y;
		s.cable.relen(Math.max(s.L, d * (loose ? 1.2 : 1)));
		const before = s.cable.mid();
		const bx = before.x;
		const by = before.y;
		s.cable.step();
		const after = s.cable.mid();
		cableMove = Math.max(cableMove, Math.abs(after.x - bx) + Math.abs(after.y - by));
	}
	const speed = Math.abs(b.pos.x - b.prev.x) + Math.abs(b.pos.y - b.prev.y);
	const moving = held || b.pushed > 0 || speed > 0.05 || Math.abs(b.rot) > 0.001 || cableMove > 0.05;
	b.quiet = moving ? 0 : b.quiet + 1;
	return moving;
}

/**
 * 止まりきったら、静止位置にぴったり戻す（小さな誤差を残さない）。
 * ペグを付け替えて静止位置が変わっているときは、その場で止めるだけ
 */
export function restBody(b: HungBody): void {
	if (Math.hypot(b.pos.x - b.home.x, b.pos.y - b.home.y) < 1.5) {
		b.pos = { ...b.home };
		b.rot = 0;
	}
	b.prev = { ...b.pos };
	syncEnds(b);
}

/** 静止した位置が、最初に吊った位置のままか（ペグを付け替えていないか） */
export function atHome(b: HungBody): boolean {
	return b.pos.x === b.home.x && b.pos.y === b.home.y;
}

/** いまの外形 */
export function rectNow(b: HungBody): Rect | null {
	const r = b.rect;
	if (!r) return null;
	return { x: r.x + b.pos.x - b.home.x, y: r.y + b.pos.y - b.home.y, w: r.w, h: r.h };
}

/**
 * 札どうしの重なりを押し出す。重なりの浅い向き（左右か上下）へ、つかんでいない側を動かす。
 * 静止した位置で最初から重なっている組（ignore に入れた組）は押し合わない。
 * active が false の札どうし（眠っている札どうし）は調べない
 */
export function collide(bodies: HungBody[], held: HungBody | null, active: (b: HungBody) => boolean, ignore: Set<string>): void {
	for (let i = 0; i < bodies.length; i++) {
		const A = bodies[i];
		const ra = rectNow(A);
		if (!ra) continue;
		for (let j = i + 1; j < bodies.length; j++) {
			const B = bodies[j];
			if (!active(A) && !active(B)) continue;
			if (ignore.has(`${i}:${j}`)) continue;
			const rb = rectNow(B);
			if (!rb) continue;
			const ox = Math.min(ra.x + ra.w, rb.x + rb.w) - Math.max(ra.x, rb.x);
			const oy = Math.min(ra.y + ra.h, rb.y + rb.h) - Math.max(ra.y, rb.y);
			if (ox <= 0 || oy <= 0) continue;
			// 押し出す向き：A から見て B のある側
			const horiz = ox < oy;
			const sign = horiz ? Math.sign(rb.x + rb.w / 2 - (ra.x + ra.w / 2)) || 1 : Math.sign(rb.y + rb.h / 2 - (ra.y + ra.h / 2)) || 1;
			const depth = horiz ? ox : oy;
			const wa = A === held ? 0 : B === held ? 1 : 0.5;
			const wb = 1 - wa;
			const move = (b: HungBody, d: number) => {
				if (d === 0) return;
				if (horiz) {
					b.pos.x += d;
					b.prev.x += d * 0.5;
				} else {
					b.pos.y += d;
					b.prev.y += d * 0.5;
				}
				b.quiet = 0;
				// 押されているあいだは糸がやわらかく伸び、離れると揺れながら戻る
				if (b !== held) b.pushed = 12;
			};
			move(A, -sign * depth * wa);
			move(B, sign * depth * wb);
			ra.x = A.rect!.x + A.pos.x - A.home.x;
			ra.y = A.rect!.y + A.pos.y - A.home.y;
		}
	}
}

/** 静止した位置で最初から重なっている組（押し合わせない） */
export function restingOverlaps(bodies: HungBody[]): Set<string> {
	const out = new Set<string>();
	for (let i = 0; i < bodies.length; i++) {
		const a = bodies[i].rect;
		if (!a) continue;
		for (let j = i + 1; j < bodies.length; j++) {
			const b = bodies[j].rect;
			if (!b) continue;
			if (Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) && Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y)) out.add(`${i}:${j}`);
		}
	}
	return out;
}
