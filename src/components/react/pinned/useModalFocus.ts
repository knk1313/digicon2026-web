// モーダル（aria-modal のダイアログ）のキーボード操作。
// Esc で閉じる。Tab と Shift+Tab は中の要素を巡る。中から外へフォーカスが出たら（ほかの island のボタンなど）、中へ戻す
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { FOCUSABLE } from '../../../lib/focus';

interface Options {
	/** 開いているあいだだけ true */
	active: boolean;
	/** フォーカスを閉じ込める要素 */
	containerRef: RefObject<HTMLElement | null>;
	/** 外へ出たフォーカスと、巡る先がないときのフォーカスを置く要素 */
	fallbackRef: RefObject<HTMLElement | null>;
	onEscape: () => void;
	/** 閉じている途中なら true（戻したフォーカスを引き戻さない） */
	isClosing: () => boolean;
}

export function useModalFocus(options: Options): void {
	const opts = useRef(options);
	useLayoutEffect(() => {
		opts.current = options;
	});

	useEffect(() => {
		if (!options.active) return;
		const onKey = (e: KeyboardEvent) => {
			const o = opts.current;
			if (o.isClosing()) return;
			if (e.key === 'Escape') {
				e.preventDefault();
				o.onEscape();
				return;
			}
			const box = o.containerRef.current;
			if (e.key !== 'Tab' || !box) return;
			const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)];
			if (items.length === 0) {
				e.preventDefault();
				o.fallbackRef.current?.focus();
				return;
			}
			const first = items[0];
			const last = items[items.length - 1];
			const active = document.activeElement;
			if (e.shiftKey && (active === first || active === box || !box.contains(active))) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && (active === last || !box.contains(active))) {
				e.preventDefault();
				first.focus();
			}
		};
		const onFocusIn = (e: FocusEvent) => {
			const o = opts.current;
			const box = o.containerRef.current;
			if (o.isClosing() || !box) return;
			if (e.target instanceof Node && !box.contains(e.target)) o.fallbackRef.current?.focus({ preventScroll: true });
		};
		document.addEventListener('keydown', onKey);
		document.addEventListener('focusin', onFocusIn);
		return () => {
			document.removeEventListener('keydown', onKey);
			document.removeEventListener('focusin', onFocusIn);
		};
	}, [options.active]);
}
