// ページのスクロールを止める・戻す（モーダルを開いているあいだ）。
// スクロールバーが消えても幅が変わらないよう、その分を右の余白で埋める。
// 消えた幅は --statement-sb に入れておき、画面に固定した要素（StatementButton）もその分だけ内側へ寄せる

export function lockScroll(): void {
	const html = document.documentElement;
	const sb = window.innerWidth - html.clientWidth;
	html.style.setProperty('--statement-sb', `${sb}px`);
	html.style.overflow = 'hidden';
	html.style.paddingRight = sb > 0 ? `${sb}px` : '';
}

export function unlockScroll(): void {
	const html = document.documentElement;
	html.style.removeProperty('--statement-sb');
	html.style.overflow = '';
	html.style.paddingRight = '';
}
