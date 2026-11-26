// 座標の計算でよく使う関数

export interface Vec {
	x: number;
	y: number;
}

export function clamp(v: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, v));
}

/** 点 p から線分 ab までの距離 */
export function segDist(p: Vec, a: Vec, b: Vec): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
	return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}
