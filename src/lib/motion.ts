// 動きを減らす設定（prefers-reduced-motion）を読む

/** 利用者が動きを減らす設定にしているか */
export function reducedMotion(): boolean {
	return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
