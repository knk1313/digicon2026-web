// 節の範囲と床の位置を測る。落ちたものはこの床で止まる（docs/design/rules.md の 1-4）
import { MOBILE_MAX } from './board';

export interface SectionBox {
	name: string;
	/** ボードの左上を原点にした上端と下端 */
	top: number;
	bottom: number;
	/** 床の線の上端（落ちたものの字形の下端をここに合わせる） */
	floor: number;
	left: number;
	right: number;
}

/** 床の線は節の下端からこれだけ上（global.css の [data-section]::after と同じ） */
export function floorInset(width: number): number {
	return width <= MOBILE_MAX ? 8 + 2.5 : 12 + 3;
}

export function measureSections(board: HTMLElement): SectionBox[] {
	const b = board.getBoundingClientRect();
	const inset = floorInset(b.width);
	return [...board.querySelectorAll<HTMLElement>('[data-section]')].map((el) => {
		const r = el.getBoundingClientRect();
		const top = r.top - b.top;
		const bottom = r.bottom - b.top;
		return { name: el.dataset.section ?? '', top, bottom, floor: bottom - inset, left: r.left - b.left, right: r.right - b.left };
	});
}
