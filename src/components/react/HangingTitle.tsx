// 吊られたタイトル「つなぐ、／かわる、／うまれる」（docs/design/rules.md の ①〜③と「結び直す」）。
// 吊られている → statement-closed（first）で一斉に落ちる → 最初の画面の床（や札の上）で止まる →
// 押せば次の空きのペグへ、つまめば空いているタイトル用のペグ（空のワイヤー）へ吊り直す。空のワイヤーの先をつまんで文字へ伸ばしてもよい。
// 文字を吊れるのはタイトル用のペグだけ（板のほかの孔には吊らない）。
// 文字は planck.js の世界（lib/physics/board-world.ts）の凸多角形の物体。吊った札（HangLayer）も同じ世界にいるので、
// 文字と札は重さ・回転・摩擦を持ったまま正しくぶつかる。
// React は SVG の器と案内を置くだけで、中身は title/TitleScene.ts（物理と操作）と title/view.ts（描画）が作って動かす
import { useEffect, useRef, useState } from 'react';
import { MOBILE_MAX } from '../../lib/board';
import { TitleScene } from './title/TitleScene';

export default function HangingTitle() {
	const svgRef = useRef<SVGSVGElement>(null);
	const [hint, setHint] = useState<number | null>(null);

	useEffect(() => {
		const el = svgRef.current;
		const board = el?.closest<HTMLElement>('[data-board]');
		const hero = el?.closest<HTMLElement>('[data-section]');
		if (!el || !board || !hero) return;
		const scene = new TitleScene(el, board, hero, (top) => {
			// スマホでは、落ちた直後に一度だけ案内を出す
			if (window.innerWidth <= MOBILE_MAX) setHint(top);
		});
		void scene.init();
		return () => scene.destroy();
	}, []);

	useEffect(() => {
		if (hint === null) return;
		const id = window.setTimeout(() => setHint(null), 6000);
		return () => window.clearTimeout(id);
	}, [hint]);

	return (
		<>
			{/* 下の段へのワイヤーが上の段の文字の後ろを通るよう、HangLayer（z-10）より前に出す */}
			<svg ref={svgRef} aria-hidden="true" className="pointer-events-none absolute top-0 left-0 z-20 overflow-visible" width={0} height={0} />
			{hint !== null && (
				<p role="status" className="tape absolute left-[26px] z-20" style={{ top: hint }}>
					文字を押すと、上のフックに順に吊られる
				</p>
			)}
		</>
	);
}
