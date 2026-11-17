// 作品概要のパネル（WP4）。digicon:work-open（detail.id）を受けて開く。
// パネルは有孔ボードの孔に2本のワイヤーで留めたカード。画面の上の外から落ちてきてワイヤーに受け止められ、
// 揺れて止まる（lib/physics/pinned.ts）。マウスでつかんで揺らせる。
// 閉じる（閉じるボタン／Esc／外を押す）とワイヤーを巻き取って上へ引き上げる。開いているあいだはフォーカスを中に閉じ込め、
// 閉じたら開いた時点の document.activeElement（押したカード）にフォーカスを戻す。
// 動きは毎フレーム ref で style を書き換え、React の再レンダリングには乗せない。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GROMMET_OFFSET, MIN_DROP, gridFor, snapX, snapYAbove } from '../../lib/board';
import { site } from '../../lib/data';
import { EVENTS, on, type WorkOpenDetail } from '../../lib/events';
import { PinnedCard } from '../../lib/physics/pinned';

/** 吊られる側の孔の位置（パネルの幅に対する割合）。札の既定と同じ */
const HANG = [0.18, 0.82];
/** 幕が出る・消える速さ（1 フレームで残りの何割を詰めるか） */
const SCRIM_RATE = 0.12;
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';
/** つかまない要素 */
const NO_DRAG = 'a, button, input, select, textarea, [contenteditable]';

/** ペグとワイヤーの位置。座標はオーバーレイの中身の左上から（パネルが下りきった状態） */
interface Geo {
	width: number;
	height: number;
	xs: number[];
	pegY: number;
	holeY: number;
	peg: number;
	grommet: number;
	wire: number;
}

function reducedMotion(): boolean {
	return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function WorkDetail() {
	const [workId, setWorkId] = useState<string | null>(null);
	const [mounted, setMounted] = useState(false);
	const [geo, setGeo] = useState<Geo | null>(null);

	const rootRef = useRef<HTMLDivElement>(null);
	const scrimRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const panelRef = useRef<HTMLElement>(null);
	const svgRef = useRef<SVGSVGElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);

	/** パネルの物理 */
	const cardRef = useRef<PinnedCard | null>(null);
	/** 幕の濃さ（0〜1）と行き先 */
	const scrimRef01 = useRef(0);
	const scrimTo = useRef(0);
	/** 上へ隠すときの量（パネルが画面の上に隠れる） */
	const liftRef = useRef(2000);
	const geoRef = useRef<Geo | null>(null);
	const frameRef = useRef(0);
	const mountedRef = useRef(false);
	const closingRef = useRef(false);
	/** 閉じたあとにフォーカスを戻す要素 */
	const returnRef = useRef<HTMLElement | null>(null);
	/** 外で押し始めたか（パネルの中で押してから外で離したときは閉じない） */
	const downOutsideRef = useRef(false);
	/** つかみ始めの候補（6px 動いたらつかむ） */
	const pendingRef = useRef<{ id: number; x: number; y: number } | null>(null);

	const index = workId ? site.works.findIndex((w) => w.id === workId) : -1;
	const work = index >= 0 ? site.works[index] : null;
	const prev = index >= 0 ? site.works[(index - 1 + site.works.length) % site.works.length] : null;
	const next = index >= 0 ? site.works[(index + 1) % site.works.length] : null;

	/** 今の位置・ワイヤー・幕の濃さを DOM に書く */
	const apply = useCallback(() => {
		const card = cardRef.current;
		if (scrimRef.current) scrimRef.current.style.opacity = String(scrimRef01.current);
		if (!card) return;
		const o = card.offset;
		if (panelRef.current) panelRef.current.style.transform = `translate3d(${o.x.toFixed(2)}px, ${o.y.toFixed(2)}px, 0) rotate(${card.angle.toFixed(4)}rad)`;
		const svg = svgRef.current;
		if (!svg) return;
		const strings = card.strings();
		svg.querySelectorAll<SVGPathElement>('[data-wire]').forEach((p, i) => strings[i] && p.setAttribute('d', strings[i].path));
		svg.querySelectorAll<SVGCircleElement>('[data-grommet]').forEach((c, i) => {
			if (!strings[i]) return;
			c.setAttribute('cx', strings[i].end.x.toFixed(2));
			c.setAttribute('cy', strings[i].end.y.toFixed(2));
		});
		// ペグは幕と一緒に現れ、一緒に消える
		const pegs = svg.querySelector<SVGGElement>('[data-pegs]');
		if (pegs) pegs.style.opacity = String(scrimRef01.current);
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
			xs,
			pegY,
			holeY,
			peg: grid.peg,
			grommet: grid.grommet,
			wire: grid.wire,
		};
		liftRef.current = top + panel.offsetHeight + 40;
		// 吊り方が変わったときだけ物理を作り直す（前後の作品へ移っても揺れを引き継ぐ）
		const old = geoRef.current;
		if (!cardRef.current || !old || old.pegY !== pegY || old.holeY !== holeY || old.xs.some((x, i) => x !== xs[i])) {
			// 外形を渡すと、傾いて落ちてきて水平に戻る（回す中心は最初の孔）
			const card = new PinnedCard(
				xs.map((x) => ({ x, y: holeY })),
				xs.map((x) => ({ x, y: pegY })),
				{ x: left, y: top, w, h: panel.offsetHeight },
			);
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
				const side = (Math.random() < 0.5 ? -1 : 1) * (36 + Math.random() * 40);
				card.drop(liftRef.current, side);
			}
		}
		apply();
		run();
		closeRef.current?.focus({ preventScroll: true });
	}, [apply, run]);

	const close = useCallback(() => {
		if (!mountedRef.current || closingRef.current) return;
		closingRef.current = true;
		// 巻き上げているあいだは操作させない。フォーカスはすぐに元へ戻す
		if (rootRef.current) rootRef.current.inert = true;
		const target = returnRef.current;
		if (target?.isConnected) target.focus({ preventScroll: true });
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
			setWorkId(null);
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

	// 開く合図を受ける
	useEffect(
		() =>
			on<WorkOpenDetail>(EVENTS.workOpen, (detail) => {
				const id = detail?.id;
				if (!id || !site.works.some((w) => w.id === id)) return;
				setWorkId(id);
				if (!mountedRef.current) {
					// 開いた時点のフォーカスを覚えておく（押したカード）
					const active = document.activeElement;
					returnRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
					mountedRef.current = true;
					setMounted(true);
				} else if (closingRef.current) {
					// 巻き上げの途中で開き直されたら、その位置からまた落とす
					drop();
				}
			}),
		[drop],
	);

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

	// 作品が変わると高さが変わるので測り直す。SVG を描き直したら位置を書き直す
	useLayoutEffect(() => {
		if (mounted) measure();
	}, [workId, mounted, measure]);
	useLayoutEffect(() => {
		apply();
	}, [geo, apply]);

	// 開いているあいだ：Esc で閉じる、Tab でパネルの中を巡る、画面の大きさが変わったら測り直す、マウスでつかむ
	useEffect(() => {
		if (!mounted) return;
		const onKey = (e: KeyboardEvent) => {
			if (closingRef.current) return;
			if (e.key === 'Escape') {
				e.preventDefault();
				close();
				return;
			}
			if (e.key !== 'Tab' || !panelRef.current) return;
			const items = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
			if (items.length === 0) return;
			const first = items[0];
			const last = items[items.length - 1];
			const active = document.activeElement;
			if (e.shiftKey && (active === first || !panelRef.current.contains(active))) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && (active === last || !panelRef.current.contains(active))) {
				e.preventDefault();
				first.focus();
			}
		};
		// パネルの外へフォーカスが出たら（ほかの島のボタンなど）、中へ戻す
		const onFocusIn = (e: FocusEvent) => {
			if (closingRef.current || !panelRef.current) return;
			if (!panelRef.current.contains(e.target as Node)) closeRef.current?.focus({ preventScroll: true });
		};
		const onResize = () => measure();
		// 中身の座標での指の位置
		const local = (e: PointerEvent) => {
			const r = contentRef.current!.getBoundingClientRect();
			return { x: e.clientX - r.left, y: e.clientY - r.top };
		};
		const onDown = (e: PointerEvent) => {
			if (e.button !== 0 || e.pointerType === 'touch' || closingRef.current) return;
			const t = e.target as Element | null;
			if (!t || !panelRef.current?.contains(t) || t.closest(NO_DRAG)) return;
			pendingRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
		};
		const onMove = (e: PointerEvent) => {
			const p = pendingRef.current;
			const card = cardRef.current;
			if (!card) return;
			if (p && p.id === e.pointerId && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 6) {
				pendingRef.current = null;
				const r = contentRef.current!.getBoundingClientRect();
				card.hold({ x: p.x - r.left, y: p.y - r.top });
				document.documentElement.style.userSelect = 'none';
				window.getSelection()?.removeAllRanges();
			}
			if (card.held) {
				card.move(local(e));
				run();
			}
		};
		const onUp = (e: PointerEvent) => {
			if (pendingRef.current?.id === e.pointerId) pendingRef.current = null;
			const card = cardRef.current;
			if (card?.held) {
				card.release();
				document.documentElement.style.userSelect = '';
				run();
			}
		};
		document.addEventListener('keydown', onKey);
		document.addEventListener('focusin', onFocusIn);
		window.addEventListener('resize', onResize);
		window.addEventListener('pointerdown', onDown);
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
		window.addEventListener('pointercancel', onUp);
		return () => {
			document.removeEventListener('keydown', onKey);
			document.removeEventListener('focusin', onFocusIn);
			window.removeEventListener('resize', onResize);
			window.removeEventListener('pointerdown', onDown);
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
			window.removeEventListener('pointercancel', onUp);
			document.documentElement.style.userSelect = '';
		};
	}, [mounted, close, measure, run]);

	if (!mounted || !work) return null;

	const titleId = `work-detail-title-${work.id}`;
	const authors = work.authors.join('、');

	return createPortal(
		<div
			ref={rootRef}
			// Lenis にホイールを渡さず、後ろのページをスクロールさせない
			data-lenis-prevent
			className="fixed inset-0 z-50 overflow-y-auto overscroll-contain"
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
				<section
					ref={panelRef}
					role="dialog"
					aria-modal="true"
					aria-labelledby={titleId}
					className="plate relative mx-auto w-full max-w-[880px] cursor-grab px-10 pt-[14px] pb-8 will-change-transform max-md:cursor-auto max-md:px-4 max-md:pt-[20px] max-md:pb-6"
					style={{ transform: 'translate3d(0, -200vh, 0)' }}
				>
					<div className="flex items-start justify-between gap-4">
						<span className="tape">作品 {work.id}</span>
						<button
							ref={closeRef}
							type="button"
							onClick={close}
							className="chip cursor-pointer text-[13px] max-md:px-4 max-md:py-2 max-md:text-[14px]"
						>
							閉じる <span aria-hidden="true">×</span>
						</button>
					</div>

					<div className="mt-6 grid grid-cols-[minmax(0,400px)_minmax(0,1fr)] gap-x-8 max-md:mt-4 max-md:grid-cols-1 max-md:gap-y-5">
						{/* サムネイル（画像はまだないので、作品カードと同じ仮の面） */}
						<div aria-hidden="true" className="aspect-[16/10] rounded-[4px] border border-hair bg-hair" />
						<div>
							<h2 id={titleId} className="font-display text-[28px] font-black leading-tight max-md:text-[28px]">
								{work.title}
							</h2>
							<p className="mt-3 text-[13px] text-mute max-md:text-[14px]">{authors}</p>
							<ul className="mt-4 flex flex-wrap gap-1.5" aria-label="カテゴリー">
								{work.categories.map((c) => (
									<li key={c}>
										<span className="tape">{c}</span>
									</li>
								))}
							</ul>
							<p className="mt-4 text-[15px] leading-[1.8] max-md:text-[16px]">{work.summary}</p>
						</div>
					</div>

					<p className="mt-7 text-[15px] leading-[1.8] max-md:mt-4 max-md:text-[14px]">{work.description}</p>

					<hr className="mt-6 border-0 border-t border-hair" />

					<dl className="mt-5 flex flex-wrap items-baseline gap-x-6 gap-y-1">
						<dt className="font-label text-[12px] text-mute">クレジット</dt>
						<dd className="text-[13px] font-medium">制作：{authors}</dd>
					</dl>

					<nav aria-label="前後の作品" className="mt-5 flex justify-between gap-4 font-label text-[13px] font-bold">
						{prev && (
							<button
								type="button"
								onClick={() => setWorkId(prev.id)}
								aria-label={`前の作品：${prev.title}`}
								className="cursor-pointer py-1 hover:underline"
							>
								<span aria-hidden="true">←</span> 前の作品
							</button>
						)}
						{next && (
							<button
								type="button"
								onClick={() => setWorkId(next.id)}
								aria-label={`次の作品：${next.title}`}
								className="cursor-pointer py-1 hover:underline"
							>
								次の作品 <span aria-hidden="true">→</span>
							</button>
						)}
					</nav>
				</section>

				{/* ペグ → ワイヤー → 吊られる側の孔。パネルより手前に描き、クリックは下に通す。形は毎フレーム書き換える */}
				{geo && (
					<svg
						ref={svgRef}
						aria-hidden="true"
						className="pointer-events-none absolute top-0 left-0 overflow-visible"
						width={geo.width}
						height={geo.height}
					>
						{geo.xs.map((x) => (
							<path
								key={`w${x}`}
								data-wire
								fill="none"
								stroke="var(--color-wire)"
								strokeWidth={geo.wire}
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						))}
						<g data-pegs>
							{geo.xs.map((x) => (
								<circle
									key={`p${x}`}
									cx={x}
									cy={geo.pegY}
									r={geo.peg / 2}
									fill="var(--color-peg)"
									stroke="var(--color-peg)"
									strokeWidth={1.5}
								/>
							))}
						</g>
						{geo.xs.map((x) => (
							<circle
								key={`g${x}`}
								data-grommet
								cx={x}
								cy={geo.holeY}
								r={geo.grommet / 2}
								fill="var(--color-board)"
								stroke="var(--color-ink)"
								strokeWidth={1.5}
							/>
						))}
					</svg>
				)}
			</div>
		</div>,
		document.body,
	);
}
