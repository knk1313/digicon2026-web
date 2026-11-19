// 右上に固定した「ステートメント」ボタン。押すとシートを開く合図を出す。
// 見た目は docs/design/components.md の StatementButton。開閉は StatementModal とイベントで連携する
import { useEffect, useState } from 'react';
import { KAWARU, TSUNAGU, UMARERU } from '../../lib/colors';
import { EVENTS, emit, on } from '../../lib/events';

export default function StatementButton() {
	// シートが開いているあいだは押された見た目にする（最初は開いた状態で始まる）
	const [pressed, setPressed] = useState(true);

	useEffect(() => {
		const offOpen = on(EVENTS.statementOpen, () => setPressed(true));
		const offClose = on(EVENTS.statementClosed, () => setPressed(false));
		return () => {
			offOpen();
			offClose();
		};
	}, []);

	const ink = pressed ? 'var(--color-board)' : 'var(--color-ink)';
	return (
		// シートが開いてページのスクロールバーが消えても位置が動かないよう、その幅（--statement-sb）だけ内側へ寄せる。
		// シートの幕（z-30）より手前に出す
		<div className="fixed top-0 right-[calc(1.5rem+var(--statement-sb,0px))] z-40 flex flex-col items-center max-md:right-[calc(0.75rem+var(--statement-sb,0px))]">
			{/* 画面の上端から吊るワイヤー */}
			<span aria-hidden="true" className="block h-[42px] w-[1.5px] bg-wire max-md:h-[56px]" />
			<button
				type="button"
				aria-haspopup="dialog"
				aria-expanded={pressed}
				onClick={() => emit(EVENTS.statementOpen)}
				className={`relative -mt-[9px] flex cursor-pointer items-center gap-2 rounded-md border-2 border-ink px-3 pt-4 pb-2 font-label text-[13px] font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink max-md:text-[11px] ${pressed ? 'bg-ink text-board' : 'bg-panel text-ink'}`}
			>
				{/* 吊られる側の孔 */}
				<span aria-hidden="true" className="absolute top-[4px] left-1/2 h-[9px] w-[9px] -translate-x-1/2 rounded-full border-[1.5px] border-ink bg-board" />
				{/* 小さなモビールの絵。押された状態では札が段階色になる */}
				<svg aria-hidden="true" width="20" height="18" viewBox="0 0 20 18">
					<path d="M10 0 L10 4 M2 4 L18 4 M4 4 L4 10 M10 4 L10 14 M16 4 L16 8" stroke={ink} strokeWidth="1.6" fill="none" strokeLinecap="round" />
					<rect x="1.5" y="10" width="5" height="4" rx="1" fill={pressed ? TSUNAGU : ink} />
					<rect x="7.5" y="14" width="5" height="4" rx="1" fill={pressed ? KAWARU : ink} />
					<rect x="13.5" y="8" width="5" height="4" rx="1" fill={pressed ? UMARERU : ink} />
				</svg>
				ステートメント
			</button>
		</div>
	);
}
