// 板の孔に留めたカード（PinnedCard）を、マウス・ペンでつかんで揺らす。
// 6px 動いたらつかむ（それまではクリックとして通す）。タッチはスクロールに使うので、つかまない。
// ボタンやリンク（NO_GRAB）の上からはつかまない
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { NO_GRAB } from '../../../lib/focus';
import type { Pt } from '../../../lib/physics/cable';
import type { PinnedCard } from '../../../lib/physics/pinned';

/** これより動いたら、クリックではなくつかむ */
const GRAB_THRESHOLD = 6;

interface Options {
	/** 開いているあいだだけ true */
	active: boolean;
	cardRef: RefObject<PinnedCard | null>;
	/** この要素の中で押したときだけつかむ */
	areaRef: RefObject<HTMLElement | null>;
	/** 画面の座標を、カードの物理の座標へ直す */
	toLocal: (clientX: number, clientY: number) => Pt;
	/** 物理を回し始める */
	run: () => void;
	/** 閉じている途中なら true（つかみ始めない） */
	isClosing?: () => boolean;
}

export function useGrabCard(options: Options): void {
	// 呼ぶ側の関数は描くたびに変わってよい。つける・外すのは active が変わったときだけ
	const opts = useRef(options);
	useLayoutEffect(() => {
		opts.current = options;
	});

	useEffect(() => {
		if (!options.active) return;
		const root = document.documentElement;
		/** つかみ始めの候補 */
		let pending: { id: number; x: number; y: number } | null = null;

		const onDown = (e: PointerEvent) => {
			const o = opts.current;
			if (e.button !== 0 || e.pointerType === 'touch' || o.isClosing?.()) return;
			const t = e.target as Element | null;
			if (!t || !o.areaRef.current?.contains(t) || t.closest(NO_GRAB)) return;
			pending = { id: e.pointerId, x: e.clientX, y: e.clientY };
		};
		const onMove = (e: PointerEvent) => {
			const o = opts.current;
			const card = o.cardRef.current;
			if (!card) return;
			const p = pending;
			if (p && p.id === e.pointerId && Math.hypot(e.clientX - p.x, e.clientY - p.y) > GRAB_THRESHOLD) {
				pending = null;
				// 押した瞬間に指の下にあった点をつかむ
				card.hold(o.toLocal(p.x, p.y));
				root.style.userSelect = 'none';
				window.getSelection()?.removeAllRanges();
				o.run();
			}
			if (card.held) card.move(o.toLocal(e.clientX, e.clientY));
		};
		const onUp = (e: PointerEvent) => {
			if (pending?.id === e.pointerId) pending = null;
			const o = opts.current;
			const card = o.cardRef.current;
			if (card?.held) {
				card.release();
				root.style.userSelect = '';
				o.run();
			}
		};
		window.addEventListener('pointerdown', onDown);
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
		window.addEventListener('pointercancel', onUp);
		return () => {
			window.removeEventListener('pointerdown', onDown);
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
			window.removeEventListener('pointercancel', onUp);
			root.style.userSelect = '';
		};
	}, [options.active]);
}
