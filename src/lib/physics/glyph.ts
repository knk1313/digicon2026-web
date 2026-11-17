// 文字の形を測る。キャンバスに字を描き、インクのある画素から凸包（当たり判定の形）を作る。
// 字形の下端を床の線にちょうど合わせるため、文字の箱ではなく実際のインクの形を使う。

export interface Vec {
	x: number;
	y: number;
}

export interface GlyphShape {
	/** 重心を原点にした凸包。内側が辺の左になる向き（符号付き面積が正）にそろえてある */
	hull: Vec[];
	/** ベースラインの中央（text-anchor: middle の基準点）から見た重心 */
	centroid: Vec;
	/** ベースラインから見たインクの上端と下端（下が正） */
	inkTop: number;
	inkBottom: number;
	/** 面積と、重心まわりの慣性モーメント（密度 1） */
	area: number;
	inertia: number;
	/** 重心から最も遠い頂点までの距離 */
	radius: number;
}

/** 画素の解像度（CSS ピクセルあたり）。2 なら 0.5px 単位で形を取る */
const SCALE = 2;
/** 凸包を間引くとき、元の形から外れてよい距離（CSS ピクセル） */
const TOLERANCE = 0.35;

const cache = new Map<string, GlyphShape>();

/**
 * 字の形を測る。font は `900 96px Murecho, sans-serif` のような CSS の font の値。
 * 同じ字・同じ font は使い回す
 */
export function glyphShape(ch: string, font: string, size: number): GlyphShape {
	const key = `${ch}|${font}`;
	const hit = cache.get(key);
	if (hit) return hit;

	const w = Math.ceil(size * 2 * SCALE);
	const h = Math.ceil(size * 2 * SCALE);
	const ox = w / 2;
	const oy = Math.round(size * 1.3 * SCALE);
	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) throw new Error('canvas 2d が使えない');
	ctx.scale(SCALE, SCALE);
	ctx.font = font;
	ctx.textAlign = 'center';
	ctx.textBaseline = 'alphabetic';
	ctx.fillStyle = '#000';
	ctx.fillText(ch, ox / SCALE, oy / SCALE);
	const data = ctx.getImageData(0, 0, w, h).data;

	// 各行のインクの左端と右端の画素の角を集める（凸包にはこれで足りる）
	const pts: Vec[] = [];
	for (let y = 0; y < h; y++) {
		let min = -1;
		let max = -1;
		for (let x = 0; x < w; x++) {
			if (data[(y * w + x) * 4 + 3] >= 128) {
				if (min < 0) min = x;
				max = x;
			}
		}
		if (min < 0) continue;
		for (const [px, py] of [
			[min, y],
			[min, y + 1],
			[max + 1, y],
			[max + 1, y + 1],
		]) {
			pts.push({ x: (px - ox) / SCALE, y: (py - oy) / SCALE });
		}
	}
	if (pts.length < 3) {
		// インクがない（字がない）ときは、字の大きさの四角で代用する
		const s = size / 2;
		pts.push({ x: -s, y: -size }, { x: s, y: -size }, { x: s, y: 0 }, { x: -s, y: 0 });
	}

	let hull = simplify(convexHull(pts), TOLERANCE);
	if (signedArea(hull) < 0) hull = hull.reverse();

	const inkTop = Math.min(...hull.map((p) => p.y));
	const inkBottom = Math.max(...hull.map((p) => p.y));
	const { area, centroid } = areaCentroid(hull);
	const local = hull.map((p) => ({ x: p.x - centroid.x, y: p.y - centroid.y }));
	const shape: GlyphShape = {
		hull: local,
		centroid,
		inkTop,
		inkBottom,
		area,
		inertia: polygonInertia(local),
		radius: Math.max(...local.map((p) => Math.hypot(p.x, p.y))),
	};
	cache.set(key, shape);
	return shape;
}

function cross(o: Vec, a: Vec, b: Vec): number {
	return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** 凸包（monotone chain） */
function convexHull(points: Vec[]): Vec[] {
	const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
	const lower: Vec[] = [];
	for (const q of p) {
		while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
		lower.push(q);
	}
	const upper: Vec[] = [];
	for (let i = p.length - 1; i >= 0; i--) {
		const q = p[i];
		while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
		upper.push(q);
	}
	upper.pop();
	lower.pop();
	return lower.concat(upper);
}

/** 両隣を結ぶ線からの距離が tol より小さい頂点を、小さいものから順に取り除く */
function simplify(hull: Vec[], tol: number): Vec[] {
	const h = [...hull];
	while (h.length > 6) {
		let best = -1;
		let bestD = tol;
		for (let i = 0; i < h.length; i++) {
			const a = h[(i - 1 + h.length) % h.length];
			const b = h[(i + 1) % h.length];
			const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
			const d = Math.abs(cross(a, b, h[i])) / len;
			if (d < bestD) {
				bestD = d;
				best = i;
			}
		}
		if (best < 0) break;
		h.splice(best, 1);
	}
	return h;
}

function signedArea(p: Vec[]): number {
	let s = 0;
	for (let i = 0; i < p.length; i++) {
		const a = p[i];
		const b = p[(i + 1) % p.length];
		s += a.x * b.y - b.x * a.y;
	}
	return s / 2;
}

function areaCentroid(p: Vec[]): { area: number; centroid: Vec } {
	let a = 0;
	let cx = 0;
	let cy = 0;
	for (let i = 0; i < p.length; i++) {
		const u = p[i];
		const v = p[(i + 1) % p.length];
		const c = u.x * v.y - v.x * u.y;
		a += c;
		cx += (u.x + v.x) * c;
		cy += (u.y + v.y) * c;
	}
	a /= 2;
	return { area: Math.abs(a), centroid: { x: cx / (6 * a), y: cy / (6 * a) } };
}

/** 重心を原点にした多角形の慣性モーメント（密度 1） */
function polygonInertia(p: Vec[]): number {
	let s = 0;
	for (let i = 0; i < p.length; i++) {
		const u = p[i];
		const v = p[(i + 1) % p.length];
		const c = u.x * v.y - v.x * u.y;
		s += c * (u.x * u.x + u.x * v.x + v.x * v.x + u.y * u.y + u.y * v.y + v.y * v.y);
	}
	return Math.abs(s) / 12;
}
