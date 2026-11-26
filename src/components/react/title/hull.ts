// 文字の外形（凸多角形）の計算
import { segDist, type Vec } from '../../../lib/math';

/** 凸多角形の頂点を、形をなるべく保ったまま max 個まで減らす（いちばん小さい三角形を作る頂点から抜く） */
export function reduceHull(pts: Vec[], max: number): Vec[] {
	const p = pts.slice();
	while (p.length > max) {
		let best = 0;
		let bestA = Infinity;
		for (let i = 0; i < p.length; i++) {
			const a = p[(i - 1 + p.length) % p.length];
			const b = p[i];
			const c = p[(i + 1) % p.length];
			const area = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y));
			if (area < bestA) {
				bestA = area;
				best = i;
			}
		}
		p.splice(best, 1);
	}
	return p;
}

/** 点 q から凸多角形 hull の辺までのいちばん近い距離。中に入っていれば 0 */
export function hullDistance(q: Vec, hull: Vec[]): number {
	let pos = 0;
	let neg = 0;
	let d = Infinity;
	for (let i = 0; i < hull.length; i++) {
		const a = hull[i];
		const b = hull[(i + 1) % hull.length];
		if ((b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x) < 0) neg++;
		else pos++;
		d = Math.min(d, segDist(q, a, b));
	}
	return pos === 0 || neg === 0 ? 0 : d;
}
