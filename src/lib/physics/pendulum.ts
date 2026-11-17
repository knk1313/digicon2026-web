// 吊られたものの揺れ。ペグを支点にした減衰つきの振り子。
// 角度は真下が 0、時計回り（SVG の rotate と同じ向き）が正

export interface Pendulum {
	/** 角度（ラジアン） */
	theta: number;
	/** 角速度 */
	omega: number;
	/** 支点から重心までの長さ */
	length: number;
	/** 減衰の強さ（大きいほど早く止まる） */
	damping: number;
}

export function createPendulum(length: number, theta = 0, omega = 0, damping = 1.6): Pendulum {
	return { theta, omega, length, damping };
}

export function stepPendulum(p: Pendulum, h: number, gravity: number): void {
	// 時計回りに振れる（theta > 0）と重心は支点の左に動き、重力が戻す向きに働く
	const alpha = -(gravity / Math.max(p.length, 1)) * Math.sin(p.theta) - p.damping * p.omega;
	p.omega += alpha * h;
	p.theta += p.omega * h;
}

/** 止まったとみなせるか */
export function pendulumQuiet(p: Pendulum): boolean {
	return Math.abs(p.theta) < 0.002 && Math.abs(p.omega) < 0.01;
}

/** 止めて真下に向ける */
export function stopPendulum(p: Pendulum): void {
	p.theta = 0;
	p.omega = 0;
}
