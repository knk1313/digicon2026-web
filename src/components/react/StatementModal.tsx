// ステートメントのモーダル。画面の中央にパネルを出し、本文をふつうの文章として載せる。
// ページを開いた直後は開いた状態で始まる（docs/design/rules.md の ①）。
// 外を押す・「閉じる ×」・Esc で閉じる。閉じたことはイベントで HangingTitle と StatementButton に伝える
import { useCallback, useEffect, useRef, useState } from 'react';
import { site, splitStatement } from '../../lib/data';
import { EVENTS, emit, on, type StatementClosedDetail } from '../../lib/events';
import { lockScroll, unlockScroll } from '../../lib/scroll-lock';
import { useModalFocus } from './pinned/useModalFocus';

/** 連・行・句に分けた本文 */
const STANZAS = splitStatement(site.theme.statement);

export default function StatementModal() {
	const [open, setOpen] = useState(true);
	const openRef = useRef(true);
	/** まだ一度も閉じていなければ true（最初に閉じたときだけタイトルが落ちる） */
	const firstRef = useRef(true);
	/** 開く前にフォーカスがあった要素 */
	const returnRef = useRef<Element | null>(null);
	const panelRef = useRef<HTMLDivElement>(null);

	const show = useCallback(() => {
		if (openRef.current) return;
		returnRef.current = document.activeElement;
		openRef.current = true;
		lockScroll();
		setOpen(true);
	}, []);

	const close = useCallback(() => {
		if (!openRef.current) return;
		openRef.current = false;
		const first = firstRef.current;
		firstRef.current = false;
		unlockScroll();
		setOpen(false);
		emit<StatementClosedDetail>(EVENTS.statementClosed, { first });
		// 開く前にフォーカスがあった要素へ戻す。なければ（ページを開いた直後）フォーカスを外す
		const back = returnRef.current;
		if (back instanceof HTMLElement && back !== document.body && back.isConnected) back.focus({ preventScroll: true });
		else (document.activeElement as HTMLElement | null)?.blur();
		returnRef.current = null;
	}, []);

	// 最初は開いた状態で始まる
	useEffect(() => {
		returnRef.current = document.activeElement;
		lockScroll();
		return () => unlockScroll();
	}, []);

	// 開いたらパネルにフォーカスを置く
	useEffect(() => {
		if (open) panelRef.current?.focus({ preventScroll: true });
	}, [open]);

	// 右上のボタンや「ステートメントを読む」から開く
	useEffect(() => on(EVENTS.statementOpen, show), [show]);

	// Esc で閉じる。Tab はパネルの中で回す
	useModalFocus({ active: open, containerRef: panelRef, fallbackRef: panelRef, onEscape: close, isClosing: () => !openRef.current });

	if (!open) return null;

	return (
		<div
			// ホイールを Lenis に渡さない（パネルの中はふつうにスクロールし、外ではページを動かさない）
			data-lenis-prevent
			className="fixed inset-0 z-30 flex items-center justify-center p-6 max-md:p-3"
		>
			{/* 暗い幕。押すと閉じる */}
			<div aria-hidden="true" onClick={close} className="absolute inset-0 bg-ink/35" />

			<div
				ref={panelRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="statement-title"
				tabIndex={-1}
				className="relative flex max-h-[min(86svh,860px)] w-[min(680px,100%)] flex-col rounded-[4px] border border-section-line bg-panel outline-none"
			>
				<div className="flex items-start justify-between gap-4 border-b border-hair px-10 pt-8 pb-5 max-md:px-5 max-md:pt-6">
					<div>
						<p className="font-label text-[12px] text-mute">ステートメント</p>
						<h2 id="statement-title" className="mt-2 font-display text-[30px] font-black leading-tight max-md:text-[22px]">
							{site.theme.title}
						</h2>
					</div>
					<button
						type="button"
						onClick={close}
						className="chip shrink-0 cursor-pointer py-[4px] text-[11px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
					>
						閉じる <span aria-hidden="true">×</span>
					</button>
				</div>

				<div className="overflow-y-auto overscroll-contain px-10 pt-6 pb-10 font-statement text-[17px] leading-[2.1] max-md:px-5 max-md:text-[15px]">
					{STANZAS.map((stanza, i) => (
						<p key={i} className={i > 0 ? 'mt-[1.6em]' : undefined}>
							{stanza.map((line, j) => (
								<span key={j}>
									{line.join('　')}
									{j < stanza.length - 1 && <br />}
								</span>
							))}
						</p>
					))}
				</div>
			</div>
		</div>
	);
}
