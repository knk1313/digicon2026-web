// ステートメントのモーダル。本文をふつうの文章として載せたパネル。
// 動きは作品概要（WorkDetail）と同じ：パネルは有孔ボードの孔に2本のワイヤーで留めたカードで、
// 画面の上の外から落ちてきてワイヤーに受け止められ、揺れて止まる（lib/physics/pinned.ts）。マウスでつかんで揺らせる。
// 外を押す・右上のボタン（開いているあいだ「閉じる ×」になる）・Esc で閉じ、ワイヤーを巻き取って上へ引き上げる。
// ページを開いた直後は開いた状態で始まる（docs/design/rules.md の ①）。閉じたことはイベントで HangingTitle と StatementButton に伝える。
// 動きは毎フレーム ref で style を書き換え、React の再レンダリングには乗せない
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { GROMMET_OFFSET, MIN_DROP, gridFor, snapX, snapYAbove } from '../../lib/board';
import { site, splitStatement } from '../../lib/data';
import { EVENTS, emit, on, type StatementClosedDetail } from '../../lib/events';
import { reducedMotion } from '../../lib/motion';
import { PinnedCard } from '../../lib/physics/pinned';
import { lockScroll, unlockScroll } from '../../lib/scroll-lock';
import PinWires, { drawPinWires, type PinGeom } from './pinned/PinWires';
import { useGrabCard } from './pinned/useGrabCard';
import { useModalFocus } from './pinned/useModalFocus';

/** 連・行・句に分けた本文 */
const STANZAS = splitStatement(site.theme.statement);

/** 吊られる側の孔の位置（パネルの幅に対する割合）。作品概要と同じ */
const HANG = [0.18, 0.82];
/** 幕が出る・消える速さ（1 フレームで残りの何割を詰めるか） */
const SCRIM_RATE = 0.12;

/** ペグとワイヤーの位置。座標はオーバーレイの中身の左上から（パネルが下りきった状態） */
interface Geo extends PinGeom {
	/** オーバーレイの中身の大きさ（SVG の大きさ） */
	width: number;
	height: number;
}

/** 吊り方（ペグと孔の位置）が同じか */
function sameHang(a: PinGeom, b: PinGeom): boolean {
	const same = (p: { x: number; y: number }[], q: { x: number; y: number }[]) =>
		p.length === q.length && p.every((v, i) => v.x === q[i].x && v.y === q[i].y);
	return same(a.pegs, b.pegs) && same(a.grommets, b.grommets);
}

export default function StatementModal() {
	// 最初は開いた状態で始まる
	const [mounted, setMounted] = useState(true);
	const [geo, setGeo] = useState<Geo | null>(null);

	const rootRef = useRef<HTMLDivElement>(null);
	const scrimRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const panelRef = useRef<HTMLElement>(null);
	const svgRef = useRef<SVGSVGElement>(null);

	/** パネルの物理 */
	const cardRef = useRef<PinnedCard | null>(null);
	/** 幕の濃さ（0〜1）と行き先 */
	const scrimRef01 = useRef(0);
	const scrimTo = useRef(0);
	/** 上へ隠すときの量（パネルが画面の上に隠れる） */
	const liftRef = useRef(2000);
	const geoRef = useRef<Geo | null>(null);
	const frameRef = useRef(0);
	const mountedRef = useRef(true);
	const closingRef = useRef(false);
	/** まだ一度も閉じていなければ true（最初に閉じたときだけタイトルが落ちる） */
	const firstRef = useRef(true);
	/** 閉じたあとにフォーカスを戻す要素 */
	const returnRef = useRef<HTMLElement | null>(null);
	/** 外で押し始めたか（パネルの中で押してから外で離したときは閉じない） */
	const downOutsideRef = useRef(false);

	/** 今の位置・ワイヤー・幕の濃さを DOM に書く */
	const apply = useCallback(() => {
		const card = cardRef.current;
		if (scrimRef.current) scrimRef.current.style.opacity = String(scrimRef01.current);
		if (!card) return;
		const o = card.offset;
		if (panelRef.current) panelRef.current.style.transform = `translate3d(${o.x.toFixed(2)}px, ${o.y.toFixed(2)}px, 0) rotate(${card.angle.toFixed(4)}rad)`;
		// ペグは幕と一緒に現れ、一緒に消える
		drawPinWires(svgRef.current, card.strings(), scrimRef01.current);
	}, []);

	/** 物理を回す。止まったら止める */
	const run = useCallback(() => {
		if (frameRef.current) return;
		const tick = () => {
			frameRef.current = 0;
			const card = cardRef.current;
			const moving = card ? card.step() : false;
			const s = scrimRef01.current;
			scrimRef01.current = Math.abs(scrimTo.current - s) < 0.01 ? scrimTo.current : s + (scrimTo.current - s) * SCRIM_RATE;
			apply();
			if (moving || scrimRef01.current !== scrimTo.current || card?.held) frameRef.current = requestAnimationFrame(tick);
		};
		frameRef.current = requestAnimationFrame(tick);
	}, [apply]);

	/** ペグとワイヤーの位置を測る。ペグは有孔ボードの孔に合わせる */
	const measure = useCallback(() => {
		const content = contentRef.current;
		const panel = panelRef.current;
		if (!content || !panel) return;
		const board = document.querySelector<HTMLElement>('[data-board]');
		const b = board?.getBoundingClientRect() ?? { left: 0, top: 0, width: window.innerWidth };
		const grid = gridFor(b.width);
		// オーバーレイは画面に固定。中身の左上は、スクロールしていなければ画面の左上と同じ
		const scrollTop = rootRef.current?.scrollTop ?? 0;
		const top = panel.offsetTop;
		const left = panel.offsetLeft;
		const w = panel.offsetWidth;
		// ボードの座標で格子に吸着させ、中身の座標へ戻す
		const boardTop = b.top + scrollTop;
		const pegY = snapYAbove(grid, top - MIN_DROP - boardTop) + boardTop;
		const xs = HANG.map((f) => snapX(grid, left + w * f - b.left) + b.left);
		const holeY = top + GROMMET_OFFSET;
		const g: Geo = {
			width: content.offsetWidth,
			height: content.scrollHeight,
			pegs: xs.map((x) => ({ x, y: pegY })),
			grommets: xs.map((x) => ({ x, y: holeY })),
			peg: grid.peg,
			grommet: grid.grommet,
			wire: grid.wire,
		};
		liftRef.current = top + panel.offsetHeight + 40;
		// 吊り方が変わったときだけ物理を作り直す（揺れを引き継ぐ）
		const old = geoRef.current;
		if (!cardRef.current || !old || !sameHang(old, g)) {
			// 外形を渡すと、傾いて落ちてきて水平に戻る（回す中心は最初の孔）
			const card = new PinnedCard(g.grommets, g.pegs, { x: left, y: top, w, h: panel.offsetHeight });
			panel.style.transformOrigin = `${xs[0] - left}px ${holeY - top}px`;
			if (cardRef.current && cardRef.current.phase !== 'gone') card.place();
			cardRef.current = card;
		}
		geoRef.current = g;
		setGeo(g);
	}, []);

	const drop = useCallback(() => {
		closingRef.current = false;
		if (rootRef.current) rootRef.current.inert = false;
		scrimTo.current = 1;
		const card = cardRef.current;
		if (card) {
			if (reducedMotion()) {
				card.place();
				scrimRef01.current = 1;
			} else {
				// 少し横にずらして落とすと、受け止められたあとに振れる
				const side = (Math.random() < 0.5 ? -1 : 1) * (16 + Math.random() * 20);
				card.drop(liftRef.current, side);
			}
		}
		apply();
		run();
		panelRef.current?.focus({ preventScroll: true });
	}, [apply, run]);

	const close = useCallback(() => {
		if (!mountedRef.current || closingRef.current) return;
		closingRef.current = true;
		const first = firstRef.current;
		firstRef.current = false;
		// タイトルが落ちるのは、パネルが巻き上がり始めるのと同時（rules.md の ②）
		emit<StatementClosedDetail>(EVENTS.statementClosed, { first });
		unlockScroll();
		// 巻き上げているあいだは操作させない。フォーカスはすぐに元へ戻す（なければ外す）
		if (rootRef.current) rootRef.current.inert = true;
		const target = returnRef.current;
		if (target?.isConnected) target.focus({ preventScroll: true });
		else (document.activeElement as HTMLElement | null)?.blur();
		const finish = () => {
			closingRef.current = false;
			mountedRef.current = false;
			returnRef.current = null;
			geoRef.current = null;
			cardRef.current = null;
			cancelAnimationFrame(frameRef.current);
			frameRef.current = 0;
			setGeo(null);
			setMounted(false);
		};
		scrimTo.current = 0;
		const card = cardRef.current;
		if (!card || reducedMotion()) {
			finish();
			return;
		}
		card.lift(liftRef.current, finish);
		run();
	}, [run]);

	const open = useCallback(() => {
		if (mountedRef.current && !closingRef.current) return;
		lockScroll();
		if (closingRef.current) {
			// 巻き上げの途中で開き直されたら、その位置からまた落とす
			drop();
			return;
		}
		// 開いた時点のフォーカスを覚えておく（押したボタン）
		const active = document.activeElement;
		returnRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
		mountedRef.current = true;
		setMounted(true);
	}, [drop]);

	// 右上のボタンや「ステートメントを読む」から開く。開いているあいだ「閉じる」になったボタンから閉じる
	useEffect(() => on(EVENTS.statementOpen, open), [open]);
	useEffect(() => on(EVENTS.statementClose, close), [close]);

	// ページを開いた直後は開いた状態なので、スクロールを止めておく。
	// スクロールバーが消えると幅が変わるので、下の「測って落とす」より先に止める
	useLayoutEffect(() => {
		lockScroll();
		return () => unlockScroll();
	}, []);

	// 置いた直後：測って、画面の上の外から落とす
	useLayoutEffect(() => {
		if (!mounted) return;
		cardRef.current = null;
		geoRef.current = null;
		scrimRef01.current = 0;
		measure();
		drop();
		return () => {
			cancelAnimationFrame(frameRef.current);
			frameRef.current = 0;
		};
	}, [mounted, measure, drop]);

	// SVG を描き直したら位置を書き直す
	useLayoutEffect(() => {
		apply();
	}, [geo, apply]);

	// 開いているあいだ：Esc で閉じる。Tab でパネルの中を巡り、外へ出たフォーカスはパネルへ戻す
	useModalFocus({
		active: mounted,
		containerRef: panelRef,
		fallbackRef: panelRef,
		onEscape: close,
		isClosing: () => closingRef.current,
	});

	// 開いているあいだ：パネルをマウスでつかんで揺らせる（座標はオーバーレイの中身の左上から）
	useGrabCard({
		active: mounted,
		cardRef,
		areaRef: panelRef,
		toLocal: (x, y) => {
			const r = contentRef.current!.getBoundingClientRect();
			return { x: x - r.left, y: y - r.top };
		},
		run,
		isClosing: () => closingRef.current,
	});

	// 開いているあいだ：画面の大きさが変わったとき・書体が読み込まれたとき（高さが変わる）に測り直す
	useEffect(() => {
		if (!mounted) return;
		window.addEventListener('resize', measure);
		document.fonts?.ready.then(() => {
			if (mountedRef.current) measure();
		});
		return () => window.removeEventListener('resize', measure);
	}, [mounted, measure]);

	if (!mounted) return null;

	return (
		<div
			ref={rootRef}
			// Lenis にホイールを渡さず、後ろのページをスクロールさせない
			data-lenis-prevent
			// 右上のステートメントボタン（z-40）より奥
			className="fixed inset-0 z-30 overflow-y-auto overscroll-contain"
			onPointerDown={(e) => {
				downOutsideRef.current = !panelRef.current?.contains(e.target as Node);
			}}
			onClick={(e) => {
				// 外で押して外で離したときだけ閉じる
				if (downOutsideRef.current && !panelRef.current?.contains(e.target as Node)) close();
				downOutsideRef.current = false;
			}}
		>
			{/* 後ろの幕 */}
			<div ref={scrimRef} aria-hidden="true" className="fixed inset-0 bg-ink/35" style={{ opacity: 0 }} />

			<div ref={contentRef} className="relative min-h-full px-7 pt-[124px] pb-16 max-md:px-[29px] max-md:pt-[96px]">
				{/* 閉じるボタンは置かない。右上の固定ボタンが開いているあいだ「閉じる ×」になる（StatementButton） */}
				<section
					ref={panelRef}
					role="dialog"
					aria-modal="true"
					aria-labelledby="statement-title"
					tabIndex={-1}
					className="relative mx-auto w-full max-w-[680px] cursor-grab rounded-[4px] border border-section-line bg-panel outline-none will-change-transform max-md:cursor-auto"
					style={{ transform: 'translate3d(0, -200vh, 0)' }}
				>
					<div className="border-b border-hair px-10 pt-8 pb-5 max-md:px-5 max-md:pt-6">
						<p className="font-label text-[12px] text-mute">ステートメント</p>
						<h2 id="statement-title" className="mt-2 font-display text-[30px] font-black leading-tight max-md:text-[22px]">
							{site.theme.title}
						</h2>
					</div>

					<div className="px-10 pt-6 pb-10 font-statement text-[17px] leading-[2.1] max-md:px-5 max-md:text-[15px]">
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
				</section>

				{/* ペグ → ワイヤー → 吊られる側の孔。パネルより手前に描き、クリックは下に通す。形は毎フレーム書き換える */}
				{geo && <PinWires ref={svgRef} className="pointer-events-none absolute top-0 left-0 overflow-visible" {...geo} />}
			</div>
		</div>
	);
}
