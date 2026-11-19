// ステートメントのシート（言葉のモビール）。
// シートは有孔ボードの孔に2本のワイヤーで留めたカード。ページを開いた直後に画面の上の外から落ちてきて、
// ワイヤーに受け止められて揺れて止まる（lib/physics/pinned.ts）。マウスでつかんで揺らせる。
// 外を押す・「閉じる ×」・Esc で、ワイヤーを巻き取って上へ引き上げられて消える。
// このファイルはシートの開閉と吊り方を受け持つ。中のモビールの組み立ては lib/statement-mobile.ts、
// 描画と揺れは statement/WordMobile.tsx
// 見た目は docs/design/components.md の StatementMobile、流れは docs/design/rules.md の ①②
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MIN_DROP, MOBILE_MAX, gridFor, snapX } from '../../lib/board';
import { site, splitStatement } from '../../lib/data';
import { EVENTS, emit, on, type StatementClosedDetail } from '../../lib/events';
import { clamp } from '../../lib/math';
import { reducedMotion } from '../../lib/motion';
import type { Pt } from '../../lib/physics/cable';
import type { MobileSim } from '../../lib/physics/mobile-sim';
import { PinnedCard } from '../../lib/physics/pinned';
import { lockScroll, unlockScroll } from '../../lib/scroll-lock';
import { MOBILE_CONFIG, buildPhrases, layoutMobile, type Size } from '../../lib/statement-mobile';
import PinWires, { drawPinWires, type PinGeom } from './pinned/PinWires';
import { useGrabCard } from './pinned/useGrabCard';
import { useModalFocus } from './pinned/useModalFocus';
import WordMobile, { PhraseSizer } from './statement/WordMobile';

// ---- 本文（連・行・句） ----

const STANZAS = splitStatement(site.theme.statement);
const { phrases: PHRASES, stanzaIds: STANZA_IDS } = buildPhrases(STANZAS);

// ---- シートを吊るペグとワイヤー（画面の座標） ----

/** シートを吊る2本のワイヤーの位置（幅に対する割合） */
const SHEET_HANG = [0.12, 0.88];

interface Geom extends PinGeom {
	/** シートの上端から画面の外へ出るまでの巻き上げ量 */
	maxLift: number;
}

/** シートの静止した位置の外形（画面の座標）。傾いたり動いたりしていても、レイアウト上の位置で測る */
function sheetRect(sheet: HTMLElement): { x: number; y: number; w: number; h: number } {
	// シートは画面に固定した重ね合わせ（inset-0）の中の absolute なので、offset はそのまま画面の座標
	return { x: sheet.offsetLeft, y: sheet.offsetTop, w: sheet.offsetWidth, h: sheet.offsetHeight };
}

/** シートを吊る孔の位置を、板の孔の格子に合わせて求める（静止した位置で） */
function measureGeom(sheet: HTMLElement): Geom | null {
	const board = document.querySelector<HTMLElement>('[data-board]');
	if (!board) return null;
	const b = board.getBoundingClientRect();
	const g = gridFor(b.width);
	const s = sheetRect(sheet);
	const r = { width: s.w, height: s.h };
	const top = s.y;
	const left = s.x;
	// ペグは、シートの上端から MIN_DROP 以上うえにある、いちばん近い孔の段
	const row = Math.floor((top - MIN_DROP - b.top - g.oy) / g.step);
	const pegY = b.top + g.oy + row * g.step;
	const xs = SHEET_HANG.map((f) => snapX(g, left - b.left + r.width * f) + b.left);
	const gy = top + g.grommet;
	return {
		pegs: xs.map((x) => ({ x, y: pegY })),
		grommets: xs.map((x) => ({ x, y: gy })),
		maxLift: top + r.height + 48,
		peg: g.peg,
		grommet: g.grommet,
		wire: g.wire,
	};
}

// ---- 開閉 ----

/** 幕のいちばん濃いとき */
const SCRIM = 0.35;

type Phase = 'open' | 'opening' | 'closing' | 'closed';

export default function StatementMobile() {
	// 最初は開いた状態（docs/design/rules.md の ①）
	const [phase, setPhase] = useState<Phase>('open');
	const phaseRef = useRef<Phase>('open');
	const [mobile, setMobile] = useState(() => window.innerWidth <= MOBILE_MAX);
	const [sizes, setSizes] = useState<Size[] | null>(null);
	const [width, setWidth] = useState(0);
	const [maxH, setMaxH] = useState<number | null>(null);
	const [geom, setGeom] = useState<Geom | null>(null);

	const overlayRef = useRef<HTMLDivElement>(null);
	const scrimRef = useRef<HTMLDivElement>(null);
	const sheetRef = useRef<HTMLDivElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const measureRef = useRef<HTMLDivElement>(null);
	const pinRef = useRef<SVGSVGElement>(null);

	/** シートの物理（板の孔に留めたカード） */
	const cardRef = useRef<PinnedCard | null>(null);
	/** モビールの物理（WordMobile が作る）。シートの動きを慣性として伝える */
	const simRef = useRef<MobileSim | null>(null);
	const geomRef = useRef<Geom | null>(null);
	const animRef = useRef(0);
	const firstRef = useRef(true);
	/** 開く前にフォーカスがあった要素 */
	const returnRef = useRef<Element | null>(null);

	const go = (p: Phase) => {
		phaseRef.current = p;
		setPhase(p);
	};

	/** いまのずれ（静止した位置から） */
	const offset = (): Pt => cardRef.current?.offset ?? { x: 0, y: 0 };

	/** シートの物理を作る。外形を渡すと傾いて落ちてきて水平に戻る。回す中心は最初の孔（CSS の transform-origin も合わせる） */
	const makeCard = (g: Geom): PinnedCard => {
		const sheet = sheetRef.current;
		if (!sheet) return new PinnedCard(g.grommets, g.pegs);
		const rect = sheetRect(sheet);
		sheet.style.transformOrigin = `${g.grommets[0].x - rect.x}px ${g.grommets[0].y - rect.y}px`;
		return new PinnedCard(g.grommets, g.pegs, rect);
	};

	// シートのずれをシート・ワイヤー・幕に当てる（毎フレーム。React の再描画には乗せない）
	const apply = useCallback(() => {
		const card = cardRef.current;
		const o = card && card.phase !== 'gone' ? card.offset : { x: 0, y: 0 };
		const sheet = sheetRef.current;
		const a = card && card.phase !== 'gone' ? card.angle : 0;
		if (sheet) sheet.style.transform = o.x || o.y || a ? `translate3d(${o.x.toFixed(2)}px, ${o.y.toFixed(2)}px, 0) rotate(${a.toFixed(4)}rad)` : '';
		// シートの動き（落ちて受け止められる、振られる）を、慣性としてモビールに伝える
		simRef.current?.setFrame(o, a);
		const g = geomRef.current;
		// 上に隠れているほど幕とペグを薄く
		const p = g ? clamp(1 - Math.max(0, -o.y) / g.maxLift, 0, 1) : 1;
		if (scrimRef.current) scrimRef.current.style.opacity = String(SCRIM * p);
		drawPinWires(pinRef.current, card ? card.strings() : null, p);
	}, []);

	/** 物理を回す。止まったら止める。settled は落ちて揺れが収まったとき */
	const run = useCallback(
		(settled?: () => void) => {
			cancelAnimationFrame(animRef.current);
			const tick = () => {
				const card = cardRef.current;
				const moving = card ? card.step() : false;
				apply();
				if (card?.phase === 'hanging' && settled) {
					settled();
					settled = undefined;
				}
				if (moving || card?.held) animRef.current = requestAnimationFrame(tick);
			};
			animRef.current = requestAnimationFrame(tick);
		},
		[apply],
	);

	/** 測った吊り方に合わせて物理を用意する。吊り方が変わらなければ揺れを引き継ぐ */
	const setGeomAndCard = useCallback((g: Geom | null) => {
		const old = geomRef.current;
		geomRef.current = g;
		setGeom(g);
		if (!g) return;
		const same =
			old &&
			cardRef.current &&
			old.pegs.every((p, i) => p.x === g.pegs[i]?.x && p.y === g.pegs[i]?.y) &&
			old.grommets.every((p, i) => Math.abs(p.x - g.grommets[i].x) < 0.5 && Math.abs(p.y - g.grommets[i].y) < 0.5);
		if (same) return;
		const prev = cardRef.current;
		const card = makeCard(g);
		if (prev && prev.phase !== 'gone') card.place();
		else card.phase = 'gone';
		cardRef.current = card;
	}, []);

	/** 画面の上の外から落とす（動きを減らす設定なら、すぐ吊った位置に置く） */
	const dropIn = useCallback(
		(settled: () => void) => {
			const card = cardRef.current;
			const g = geomRef.current;
			if (!card || !g) {
				settled();
				return;
			}
			if (reducedMotion()) {
				card.place();
				apply();
				settled();
				return;
			}
			// 少し横にずらして落とすと、受け止められたあとに振れる
			const side = (Math.random() < 0.5 ? -1 : 1) * (30 + Math.random() * 36);
			// シートの高さが決まる前でも画面の外から落ちるよう、少なくとも画面の高さぶん上から
			card.drop(Math.max(g.maxLift, window.innerHeight), side);
			apply();
			run(settled);
		},
		[apply, run],
	);

	// 句の札の大きさと、シートの幅・高さの上限を測る
	const measure = useCallback(() => {
		const sheet = sheetRef.current;
		const box = measureRef.current;
		if (!sheet || !box || phaseRef.current === 'closed') return;
		setMobile(window.innerWidth <= MOBILE_MAX);
		// 札の大きさはレイアウト上の大きさで測る（シートが傾いて落ちている最中でも、見た目の外形で大きく測らないように）
		setSizes(
			[...box.children].map((el) => {
				const e = el as HTMLElement;
				return { w: Math.ceil(e.offsetWidth), h: Math.ceil(e.offsetHeight) };
			}),
		);
		setWidth(sheet.clientWidth);
		const top = sheet.getBoundingClientRect().top - offset().y;
		setMaxH(Math.max(160, window.innerHeight - top - 16));
		setGeomAndCard(measureGeom(sheet));
	}, [setGeomAndCard]);

	const mobileLayout = useMemo(
		() => (sizes && width ? layoutMobile(sizes, width, mobile ? MOBILE_CONFIG.phone : MOBILE_CONFIG.desktop, STANZA_IDS) : null),
		[sizes, width, mobile],
	);
	// 枠線（上下 1px ずつ）の分を足す
	const sheetH = mobileLayout ? Math.min(mobileLayout.height + 2, maxH ?? Infinity) : undefined;

	// 高さが決まるとシートの下端が変わるので、ワイヤーの位置と巻き上げ量を測り直す
	useLayoutEffect(() => {
		const sheet = sheetRef.current;
		if (!sheet || phaseRef.current === 'closed') return;
		setGeomAndCard(measureGeom(sheet));
	}, [sheetH, setGeomAndCard]);

	// geom が描き直されたら、今のずれを当て直す
	useLayoutEffect(() => {
		apply();
	}, [geom, apply]);

	const open = useCallback(() => {
		const p = phaseRef.current;
		if (p === 'open' || p === 'opening') return;
		returnRef.current = document.activeElement;
		lockScroll();
		go('opening');
	}, []);

	const close = useCallback(() => {
		const p = phaseRef.current;
		if (p !== 'open' && p !== 'opening') return;
		const first = firstRef.current;
		firstRef.current = false;
		// タイトルが落ちるのはシートが巻き上がるのと同時（rules.md の ②）
		emit<StatementClosedDetail>(EVENTS.statementClosed, { first });
		unlockScroll();
		// 先に閉じ始めの状態にする（フォーカスを閉じ込める処理が、戻したフォーカスを引き戻さないように）
		go('closing');
		// 開く前にフォーカスがあった要素へ戻す。なければ（ページを開いた直後）フォーカスを外す
		const back = returnRef.current;
		if (back instanceof HTMLElement && back !== document.body && back.isConnected) back.focus({ preventScroll: true });
		else (document.activeElement as HTMLElement | null)?.blur();
		returnRef.current = null;
		const card = cardRef.current;
		const g = geomRef.current;
		if (!card || !g || reducedMotion()) {
			go('closed');
			return;
		}
		// ワイヤーを巻き取って上へ引き上げる
		card.lift(g.maxLift, () => go('closed'));
		run();
	}, [run]);

	// 開き始め：見えるようにしてから測り、上の外から落とす
	useLayoutEffect(() => {
		if (phase !== 'opening') return;
		const sheet = sheetRef.current;
		if (!sheet) return;
		const card = cardRef.current;
		if (card?.phase === 'lifting') {
			// 引き上げの途中で開き直されたら、その位置からまた落とす
			card.drop(0, 0);
			run(() => go('open'));
		} else {
			measure();
			// 閉じきった状態からは、物理を作り直して上から落とす
			const g = measureGeom(sheet);
			if (g) {
				geomRef.current = g;
				setGeom(g);
				cardRef.current = makeCard(g);
			}
			dropIn(() => go('open'));
		}
		sheet.focus({ preventScroll: true });
	}, [phase, measure, dropIn, run]);

	// 閉じきったら、次に開くときのためにずれを戻す
	useEffect(() => {
		if (phase === 'closed') {
			cancelAnimationFrame(animRef.current);
			if (sheetRef.current) sheetRef.current.style.transform = '';
		}
	}, [phase]);

	// 最初に開いた状態で出るとき：測ってから、上の外から落とす
	useEffect(() => {
		returnRef.current = document.activeElement;
		lockScroll();
		measure();
		const sheet = sheetRef.current;
		sheet?.focus({ preventScroll: true });
		const g = sheet ? measureGeom(sheet) : null;
		if (g) {
			geomRef.current = g;
			setGeom(g);
			cardRef.current = makeCard(g);
			dropIn(() => {});
		}
		// 書体が読み込まれると札の幅が変わる
		document.fonts?.ready.then(measure);
		const onResize = () => measure();
		window.addEventListener('resize', onResize);
		return () => {
			window.removeEventListener('resize', onResize);
			cancelAnimationFrame(animRef.current);
			unlockScroll();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [measure]);

	const live = phase === 'open' || phase === 'opening';
	const isClosing = () => phaseRef.current !== 'open' && phaseRef.current !== 'opening';

	// 開いているあいだ、シートをマウスでつかんで揺らせる（タッチはスクロールに使う。座標は画面のまま）
	useGrabCard({ active: live, cardRef, areaRef: sheetRef, toLocal: (x, y) => ({ x, y }), run: () => run(), isClosing });

	// 右上のボタンや「ステートメントを読む」から開く
	useEffect(() => on(EVENTS.statementOpen, open), [open]);

	// Esc で閉じる。Tab はシートの中で回し、シートの外（右上のボタンなど）に出たフォーカスはシートへ戻す
	useModalFocus({ active: live, containerRef: sheetRef, fallbackRef: sheetRef, onEscape: close, isClosing });

	const scrollable = mobileLayout && maxH !== null && mobileLayout.height + 2 > maxH;

	return (
		<div
			ref={overlayRef}
			hidden={phase === 'closed'}
			// ホイールを Lenis に渡さない（シートの中はふつうにスクロールし、外ではページを動かさない）
			data-lenis-prevent
			className={`fixed inset-0 z-30 ${live ? '' : 'pointer-events-none'}`}
		>
			{/* 暗い幕。押すと閉じる */}
			<div ref={scrimRef} aria-hidden="true" onClick={close} className="absolute inset-0 touch-none bg-ink" style={{ opacity: SCRIM }} />

			<div
				ref={sheetRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="statement-title"
				tabIndex={-1}
				className="absolute top-[104px] right-[56px] w-[min(1000px,calc(100vw-112px))] rounded-[3px] border border-section-line bg-panel outline-none will-change-transform max-md:top-[min(300px,36svh)] max-md:right-[14px] max-md:left-[14px] max-md:w-auto"
				style={{ height: sheetH }}
			>
				<div
					ref={scrollRef}
					tabIndex={scrollable ? 0 : undefined}
					aria-label={scrollable ? 'ステートメントの本文' : undefined}
					className="relative h-full overflow-x-hidden overflow-y-auto overscroll-contain outline-none"
				>
					<div className="relative" style={{ height: mobileLayout?.height }}>
						<h2 id="statement-title" className="sr-only">
							ステートメント：{site.theme.title}
						</h2>
						{/* 読み上げ用の本文。見た目のモビールは絵として扱う */}
						<div className="sr-only">
							{STANZAS.map((stanza, i) => (
								<p key={i}>
									{stanza.map((line, j) => (
										<span key={j}>
											{line.join(' ')}
											{j < stanza.length - 1 && <br />}
										</span>
									))}
								</p>
							))}
						</div>

						{mobileLayout && <WordMobile layout={mobileLayout} width={width} phrases={PHRASES} simRef={simRef} />}

						{/* 見出しのラベルと閉じるボタン */}
						<span className="tape absolute top-[18px] left-[18px] max-md:top-[14px] max-md:left-[12px] max-md:text-[10px]" aria-hidden="true">
							テーマ — コンセプト
						</span>
						<button
							type="button"
							onClick={close}
							className="chip absolute top-[14px] right-[18px] cursor-pointer py-[4px] text-[11px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink max-md:top-[10px] max-md:right-[10px]"
						>
							閉じる <span aria-hidden="true">×</span>
						</button>
					</div>
				</div>

				<PhraseSizer ref={measureRef} phrases={PHRASES} />
			</div>

			{/* 板の孔のペグからシートの孔へのワイヤー */}
			{geom && <PinWires ref={pinRef} className="pointer-events-none absolute inset-0 h-full w-full" {...geom} />}
		</div>
	);
}
