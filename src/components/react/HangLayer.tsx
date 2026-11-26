// data-hang の付いた要素（札・カード・ナビなど）を、板の孔のペグからワイヤーで吊る層。
// 要素そのものを、planck.js の世界（lib/physics/board-world.ts）の長方形の物体として動かす。
// タイトルの文字も同じ世界にいるので、札どうし・札と文字は重さ・回転・摩擦を持ったままぶつかる。
// ・ワイヤーはロープ関節。ペグの高さが違えば、札は自然に傾いて吊られる
// ・マウス・ペンでつかんで動かせる（マウス関節）。離すと揺れながら戻る
// ・6px 以上動かしたらドラッグとみなし、続く click（リンク・カードを開く）は起こさない
// ・ペグはつまんで別の孔へ挿し替えられる（ドラッグか、ペグを押してから行き先の孔を押す）
// ・ホバーすると、その札のペグ・ワイヤー・孔が少し目立つ（どこで吊られているかの手がかり）
// ・スクロールでは、ごくわずかに左右へ振れる（動きを減らす設定では揺らさない）
// ・タッチでは札をつかまない（ページのスクロールを妨げないため）。ペグの挿し替えはタッチでもできる
// ・端子や入力欄など、data-no-drag の中からはつかまない
// React は SVG の器を置くだけ。吊り方を測るのは hang/measure.ts、物理と操作は hang/HangScene.ts、
// 描画は hang/view.ts、見た目のワイヤーのうねりは lib/physics/cable.ts（描くためだけのロープ）
import { useEffect, useRef } from 'react';
import { HangScene } from './hang/HangScene';

export default function HangLayer() {
	const svgRef = useRef<SVGSVGElement>(null);

	useEffect(() => {
		const el = svgRef.current;
		const board = el?.closest<HTMLElement>('[data-board]');
		if (!el || !board) return;
		const scene = new HangScene(el, board);
		scene.init();
		return () => scene.destroy();
	}, []);

	return <svg ref={svgRef} aria-hidden="true" className="pointer-events-none absolute top-0 left-0 z-10" width={0} height={0} />;
}
