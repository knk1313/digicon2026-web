// 作品の節の island：カテゴリーの面（端子をケーブルでつなぐ）と、吊られた作品カードの一覧。
// 絞り込みの決まりは docs/design/rules.md の「4. 作品の絞り込み」、見た目は components.md の CategoryPanel と WorkCard。
// 結ぶ操作の手触りは、引継ぎ資料の B5「言葉の面」（ib/b5.html、ib/tie.js、ib/cable.js）に合わせる。
// ・ケーブル1本 = カテゴリー2つの組。組の両方をもつ作品が残る（AND）。複数の組は、どれかを満たせば残る（AND の OR）
// ・つなぎ方：端子をつかむとたるんだケーブルが出て指を追う。46px 以内のいちばん近い端子が光り、離すとつながる。
//   動かさずに離すとタップ→タップでつなげる（キーボードの Enter / Space でも同じ）
// ・ケーブル（または真ん中の件数のラベル）を押すと抜ける。マウスでなでるとケーブルが揺れる
// ・ケーブルは Verlet の物理（lib/physics/cable.ts）で毎フレーム動かし、React の描画には乗せない
// ・ペグ・ワイヤーは HangLayer が data-hang を測って描く。カードが増減したら digicon:layout を出して測り直させる
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { Work } from '../../lib/data';
import { EVENTS, emit, type WorkOpenDetail } from '../../lib/events';
import { Cable, type Pt } from '../../lib/physics/cable';

interface Props {
	works: Work[];
	categories: string[];
}

/** つないだ組。a と b は名前順に並べておく（同じ組を二重につながないため） */
interface Pair {
	a: string;
	b: string;
}

/** つないでいるときのペグ・ケーブルの色（段階色の「つなぐ」） */
const TSUNAGU = 'var(--color-tsunagu)';
/** ドラッグ中、端子の縁からこの距離（px）以内のいちばん近い端子を相手にする（tie.js と同じ） */
const NEAR_RADIUS = 46;
/** これより動いたら、タップではなくドラッグとみなす */
const DRAG_THRESHOLD = 6;
/** ケーブルのたるみ（tie.js と同じ）。引いている最中は少し張る */
const SLACK = 1.12;
const PULL_SLACK = 1.04;
/** ケーブルの最下点は、面の下端からこれより上に収める（下端の状態の行と重ねない） */
const SAG_FLOOR = 52;

const keyOf = (c: Pair) => `${c.a}|${c.b}`;
const makePair = (x: string, y: string): Pair => (x < y ? { a: x, b: y } : { a: y, b: x });

/** その組を満たす（両方のカテゴリーをもつ）作品 */
function matches(w: Work, c: Pair): boolean {
	return w.categories.includes(c.a) && w.categories.includes(c.b);
}

function countLabel(n: number): string {
	return n === 0 ? 'まだない' : `${n}作品`;
}

/**
 * 最下点が maxY を越えないたるみ。放物線で近似すると、長さ k·d のケーブルは
 * 真ん中が d·√(3(k−1)/8) ほど垂れるので、そこから k を逆算する
 */
function slackFor(p: Pt, q: Pt, maxY: number, want: number): number {
	const d = Math.hypot(q.x - p.x, q.y - p.y);
	if (d < 1) return want;
	const room = maxY - Math.max(p.y, q.y);
	if (room <= 0) return 1.005;
	return Math.max(1.005, Math.min(want, 1 + (8 * room * room) / (3 * d * d)));
}

function reducedMotion(): boolean {
	return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// カテゴリーの言葉の大きさ。Figma の面のように、少しずつ大きさを変えて散らす
const WORD_SIZE = [
	'text-[30px] max-md:text-[16px]',
	'text-[24px] max-md:text-[15px]',
	'text-[28px] max-md:text-[16px]',
	'text-[22px] max-md:text-[14px]',
	'text-[26px] max-md:text-[15px]',
];
// 3列の格子のどこに寄せるか（PC）。5つ目は右端の列に置く
const WORD_PLACE = ['md:justify-self-start', 'md:justify-self-center', 'md:justify-self-end', 'md:justify-self-start md:translate-x-[40px]', 'md:col-start-3 md:justify-self-end'];

export default function WorksBoard({ works, categories }: Props) {
	const [pairs, setPairs] = useState<Pair[]>([]);
	/** タップ→タップで選んでいる端子 */
	const [pending, setPending] = useState<string | null>(null);
	/** ドラッグ中の元の端子 */
	const [dragFrom, setDragFrom] = useState<string | null>(null);
	/** ドラッグ中、離せばつながる端子 */
	const [near, setNear] = useState<string | null>(null);

	const panelRef = useRef<HTMLDivElement>(null);
	const jackRefs = useRef(new Map<string, HTMLButtonElement>());
	/** 端子の中心（面の左上から）。面の大きさが変わるたびに測り直す */
	const jacks = useRef<Record<string, Pt>>({});
	const panelH = useRef(0);
	/** つないだケーブルの物理と、それを描く path・件数のラベル */
	const cables = useRef(new Map<string, Cable>());
	const pathRefs = useRef(new Map<string, SVGPathElement>());
	const hitRefs = useRef(new Map<string, SVGPathElement>());
	const labelRefs = useRef(new Map<string, HTMLButtonElement>());
	/** 引いている最中のケーブル */
	const pull = useRef<{ from: string; cable: Cable } | null>(null);
	const pullPath = useRef<SVGPathElement>(null);
	const pullDot = useRef<SVGCircleElement>(null);
	/** 指の位置（面の左上から）。null なら面の外 */
	const ptr = useRef<Pt | null>(null);
	/** pointerdown からの追跡。ドラッグに変わったら、続く click（タップ扱い）を無視する */
	const pointer = useRef<{ from: string; id: number; x: number; y: number; dragging: boolean } | null>(null);
	const suppressClick = useRef(false);

	// 残る作品。ケーブルがなければ全件
	const visible = useMemo(
		() => (pairs.length === 0 ? works : works.filter((w) => pairs.some((c) => matches(w, c)))),
		[works, pairs],
	);
	const counts = useMemo(() => new Map(pairs.map((c) => [keyOf(c), works.filter((w) => matches(w, c)).length])), [works, pairs]);
	const connected = useMemo(() => new Set(pairs.flatMap((c) => [c.a, c.b])), [pairs]);

	// 端子の位置を測る
	const measure = useCallback(() => {
		const panel = panelRef.current;
		if (!panel) return;
		const pr = panel.getBoundingClientRect();
		const next: Record<string, Pt> = {};
		for (const [cat, el] of jackRefs.current) {
			const r = el.getBoundingClientRect();
			next[cat] = { x: r.left - pr.left + r.width / 2, y: r.top - pr.top + r.height / 2 };
		}
		jacks.current = next;
		panelH.current = pr.height;
	}, []);

	useLayoutEffect(() => {
		const panel = panelRef.current;
		if (!panel) return;
		measure();
		document.fonts?.ready.then(measure);
		const ro = new ResizeObserver(measure);
		ro.observe(panel);
		return () => ro.disconnect();
	}, [measure]);

	// ケーブルを動かして描く。物理は毎フレーム、描画は path の d とラベルの位置を直接書き換える
	useEffect(() => {
		let frame = 0;
		const still = reducedMotion();
		const tick = () => {
			const maxY = panelH.current - SAG_FLOOR;
			const push = ptr.current && !pull.current ? { ...ptr.current, r: 18 } : undefined;
			for (const [key, k] of cables.current) {
				const A = k.a();
				const B = k.b!();
				k.slack = slackFor(A, B, maxY, SLACK);
				k.relen();
				if (still) k.settle(60);
				else k.step(push);
				const d = k.path();
				pathRefs.current.get(key)?.setAttribute('d', d);
				hitRefs.current.get(key)?.setAttribute('d', d);
				const label = labelRefs.current.get(key);
				if (label) {
					const m = k.mid();
					// ほぼ縦のケーブルは、真ん中が間の言葉に重なるので、ラベルを右へずらす
					const side = Math.abs(B.x - A.x) < 40 ? label.offsetWidth / 2 + 10 : 0;
					label.style.left = `${m.x + side}px`;
					label.style.top = `${Math.min(m.y, maxY)}px`;
				}
			}
			const p = pull.current;
			if (p && ptr.current) {
				p.cable.relen();
				p.cable.step();
				pullPath.current?.setAttribute('d', p.cable.path());
				pullDot.current?.setAttribute('cx', String(ptr.current.x));
				pullDot.current?.setAttribute('cy', String(ptr.current.y));
			}
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, []);

	// カードの増減やペグの点灯が変わったら、HangLayer に測り直させる
	useEffect(() => {
		emit(EVENTS.layout);
	}, [visible, pairs.length]);

	// Esc で選択・ドラッグをやめる
	useEffect(() => {
		if (!pending && !dragFrom) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				setPending(null);
				endPull();
				pointer.current = null;
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [pending, dragFrom]);

	const hasPair = (x: string, y: string) => pairs.some((c) => keyOf(c) === keyOf(makePair(x, y)));

	const anchor = (cat: string) => () => jacks.current[cat] ?? { x: 0, y: 0 };

	/** つなぐ。from が引いていたケーブルなら、その形を引き継いでから垂れさせる */
	const connect = (x: string, y: string, from?: Cable) => {
		if (x === y || hasPair(x, y)) return;
		const pair = makePair(x, y);
		const k = new Cable(anchor(pair.a), anchor(pair.b), { slack: SLACK });
		if (from) {
			// 引いていたケーブルは x → 指先。向きをそろえて写す
			const src = pair.a === x ? from.pts : [...from.pts].reverse();
			k.pts.forEach((p, i) => {
				const s = src[Math.round((i / k.seg) * (src.length - 1))];
				p.x = p.px = s.x;
				p.y = p.py = s.y;
			});
		}
		cables.current.set(keyOf(pair), k);
		setPairs((cs) => [...cs, pair]);
	};
	const unplug = (c: Pair) => {
		cables.current.delete(keyOf(c));
		setPairs((cs) => cs.filter((d) => keyOf(d) !== keyOf(c)));
		// 抜いたあと、フォーカスが消えないよう端子へ戻す
		jackRefs.current.get(c.a)?.focus();
	};
	const unplugAll = () => {
		cables.current.clear();
		setPairs([]);
	};

	/** 端子を押した（タップ、Enter、Space） */
	const onJackClick = (cat: string) => {
		if (suppressClick.current) {
			suppressClick.current = false;
			return;
		}
		if (pending === null) setPending(cat);
		else if (pending === cat) setPending(null);
		else {
			connect(pending, cat);
			setPending(null);
		}
	};

	const toPanel = (e: { clientX: number; clientY: number }): Pt => {
		const pr = panelRef.current!.getBoundingClientRect();
		return { x: e.clientX - pr.left, y: e.clientY - pr.top };
	};

	/** 指先にいちばん近い、つなげる端子（端子の縁から NEAR_RADIUS 以内） */
	const nearest = (at: Pt, from: string): string | null => {
		let best: string | null = null;
		let bestD = NEAR_RADIUS;
		for (const [cat, el] of jackRefs.current) {
			if (cat === from || hasPair(from, cat)) continue;
			const q = jacks.current[cat];
			if (!q) continue;
			const d = Math.max(0, Math.hypot(q.x - at.x, q.y - at.y) - el.offsetWidth / 2);
			if (d < bestD) {
				best = cat;
				bestD = d;
			}
		}
		return best;
	};

	const endPull = () => {
		pull.current = null;
		setDragFrom(null);
		setNear(null);
	};

	const onJackPointerDown = (cat: string) => (e: PointerEvent<HTMLButtonElement>) => {
		if (e.button !== 0) return;
		pointer.current = { from: cat, id: e.pointerId, x: e.clientX, y: e.clientY, dragging: false };
		e.currentTarget.setPointerCapture(e.pointerId);
	};
	const onJackPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
		const p = pointer.current;
		if (!p || p.id !== e.pointerId) return;
		ptr.current = toPanel(e);
		if (!p.dragging && Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD) return;
		if (!p.dragging) {
			p.dragging = true;
			setPending(null);
			setDragFrom(p.from);
			pull.current = { from: p.from, cable: new Cable(anchor(p.from), () => ptr.current ?? jacks.current[p.from], { slack: PULL_SLACK }) };
		}
		const n = nearest(ptr.current, p.from);
		setNear((cur) => (cur === n ? cur : n));
	};
	const onJackPointerUp = (e: PointerEvent<HTMLButtonElement>) => {
		const p = pointer.current;
		if (!p || p.id !== e.pointerId) return;
		pointer.current = null;
		if (!p.dragging) return; // タップは click で扱う
		suppressClick.current = true;
		const target = nearest(toPanel(e), p.from);
		const from = pull.current?.cable;
		endPull();
		if (target) connect(p.from, target, from);
		// click が来ない環境でも、次のタップを飲み込まないようにする
		setTimeout(() => (suppressClick.current = false), 0);
	};
	const onJackPointerCancel = () => {
		pointer.current = null;
		endPull();
	};

	// 選択中は相手になれる端子を、ドラッグ中はいちばん近い端子だけを目立たせる
	const source = dragFrom ?? pending;
	const isLit = (cat: string) => (dragFrom ? cat === near : pending !== null && cat !== pending && !hasPair(pending, cat));

	const status =
		pairs.length === 0
			? `全${works.length}作品`
			: visible.length === 0
				? 'つないだ組に当てはまる作品は、まだありません'
				: `${visible.length}作品が残っています`;

	return (
		<>
			{/* カテゴリーの面 */}
			<div
				ref={panelRef}
				className="plate relative mt-[84px] px-10 pt-12 pb-[88px] max-md:mt-[64px] max-md:px-3 max-md:pt-9 max-md:pb-[72px]"
				data-hang="0.1,0.5,0.9"
				data-hang-lit={pairs.length > 0 ? TSUNAGU : undefined}
				role="group"
				aria-label="カテゴリーの面"
				onPointerMove={(e) => {
					if (e.pointerType === 'mouse' || pull.current) ptr.current = toPanel(e);
				}}
				onPointerLeave={() => {
					if (!pull.current) ptr.current = null;
				}}
			>
				<p className="sr-only">
					端子を押して選び、もう1つの端子を押すとケーブルでつながり、両方のカテゴリーをもつ作品だけが残ります。ケーブルのラベルを押すと抜けます。Esc で選択をやめます。
				</p>
				<ul className="relative z-20 grid grid-cols-3 items-center gap-x-6 gap-y-14 max-md:grid-cols-2 max-md:gap-x-2 max-md:gap-y-9">
					{categories.map((cat, i) => {
						const on = connected.has(cat);
						const selected = source === cat;
						const lit = isLit(cat);
						return (
							<li key={cat} className={`flex items-center gap-2.5 max-md:gap-1.5 ${WORD_PLACE[i % WORD_PLACE.length]}`}>
								<span className={`font-display font-black leading-none whitespace-nowrap ${WORD_SIZE[i % WORD_SIZE.length]}`}>{cat}</span>
								<button
									type="button"
									ref={(el) => {
										if (el) jackRefs.current.set(cat, el);
										else jackRefs.current.delete(cat);
									}}
									data-jack={cat}
									aria-label={`${cat}の端子`}
									aria-pressed={selected}
									onClick={() => onJackClick(cat)}
									onPointerDown={onJackPointerDown(cat)}
									onPointerMove={onJackPointerMove}
									onPointerUp={onJackPointerUp}
									onPointerCancel={onJackPointerCancel}
									className={[
										'relative grid h-[22px] w-[22px] shrink-0 cursor-crosshair touch-none place-items-center rounded-full border-2 bg-ink transition-[outline-color,transform] max-md:h-[20px] max-md:w-[20px]',
										'outline-offset-[3px] focus-visible:outline-2 focus-visible:outline-ink',
										selected || lit ? 'border-tsunagu outline-2 outline-tsunagu' : 'border-ink',
										dragFrom && lit ? 'scale-125' : '',
									].join(' ')}
								>
									{/* 端子の穴 */}
									<span aria-hidden="true" className="block h-[8px] w-[8px] rounded-full border border-hair bg-wire" />
								</button>
								{/* ランプ：つないでいると黄色に点く */}
								<span
									aria-hidden="true"
									className={`block h-[7px] w-[7px] shrink-0 rounded-full border ${on ? 'border-ink bg-tsunagu' : 'border-mute bg-panel'}`}
								/>
								{on && <span className="sr-only">（つないでいる）</span>}
							</li>
						);
					})}
				</ul>

				{/* ケーブル。端子より下、言葉より上に重ねる。形は毎フレーム書き換える */}
				<svg aria-hidden="true" className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-visible">
					{pairs.map((c) => {
						const key = keyOf(c);
						return (
							<g key={key} className="cursor-pointer" onClick={() => unplug(c)}>
								{/* 押しやすいよう、見えない太い線を下に敷く */}
								<path
									ref={(el) => {
										if (el) hitRefs.current.set(key, el);
										else hitRefs.current.delete(key);
									}}
									fill="none"
									stroke="transparent"
									strokeWidth={18}
									style={{ pointerEvents: 'stroke' }}
								/>
								<path
									ref={(el) => {
										if (el) pathRefs.current.set(key, el);
										else pathRefs.current.delete(key);
									}}
									fill="none"
									stroke={TSUNAGU}
									strokeWidth={3}
									strokeLinecap="round"
									strokeLinejoin="round"
									style={{ pointerEvents: 'stroke' }}
								/>
							</g>
						);
					})}
					{dragFrom && (
						<>
							<path ref={pullPath} fill="none" stroke={TSUNAGU} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
							<circle ref={pullDot} r={4} fill={TSUNAGU} stroke="var(--color-ink)" strokeWidth={1} />
						</>
					)}
				</svg>

				{/* ケーブルの真ん中の件数のラベル。押すと抜ける。位置は毎フレーム書き換える */}
				{pairs.map((c) => {
					const key = keyOf(c);
					const n = counts.get(key) ?? 0;
					return (
						<button
							key={key}
							ref={(el) => {
								if (el) labelRefs.current.set(key, el);
								else labelRefs.current.delete(key);
							}}
							type="button"
							onClick={() => unplug(c)}
							aria-label={`${c.a}と${c.b}のケーブルを抜く（${n === 0 ? '当てはまる作品なし' : `${n}作品`}）`}
							title="押すと抜けます"
							className="tape absolute z-30 -translate-x-1/2 -translate-y-1/2 cursor-pointer whitespace-nowrap outline-offset-2 focus-visible:outline-2 focus-visible:outline-ink"
						>
							{countLabel(n)} ×
						</button>
					);
				})}

				{/* 状態の読み上げと、全部抜くボタン */}
				<div className="absolute right-4 bottom-3 left-4 z-30 flex items-center justify-between gap-3 font-label text-[12px] text-mute max-md:right-3 max-md:left-3 max-md:text-[11px]">
					<p aria-live="polite">
						{pending ? `${pending}を選択中。つなぐ相手の端子を押してください` : status}
					</p>
					{pairs.length > 0 && (
						<button type="button" onClick={unplugAll} className="cursor-pointer underline underline-offset-2 hover:text-ink">
							すべて抜く
						</button>
					)}
				</div>
			</div>

			{/* 作品カード */}
			{visible.length === 0 ? (
				<div className="plate mt-[96px] inline-block px-7 pt-8 pb-6 max-md:mt-[72px] max-md:px-5" data-hang="0.18,0.82">
					<span className="tape">0作品</span>
					<p className="mt-3 font-display text-[24px] font-black max-md:text-[19px]">まだない</p>
					<p className="mt-1 text-[14px] text-mute">新しい関係かもしれない。</p>
					<button type="button" onClick={unplugAll} className="chip mt-5 cursor-pointer">
						ケーブルを抜いて全件に戻す
					</button>
				</div>
			) : (
				<ul
					aria-label="作品一覧"
					className="mt-[96px] grid grid-cols-5 gap-x-[30px] gap-y-[84px] max-lg:grid-cols-3 max-md:mt-[72px] max-md:grid-cols-2 max-md:gap-x-4 max-md:gap-y-[64px]"
				>
					{visible.map((w) => (
						<li key={w.id}>
							<article
								className="plate group relative h-full px-3 pt-6 pb-4 focus-within:outline-2 focus-within:outline-offset-[3px] focus-within:outline-ink"
								data-hang="0.25,0.75"
								data-hang-lit={pairs.length > 0 ? TSUNAGU : undefined}
							>
								<div className="aspect-[16/10] rounded-[4px] border border-hair bg-board" aria-hidden="true" />
								<h3 className="mt-3 text-[15px] font-medium leading-snug">
									{/* カード全体を押せるよう、ボタンの当たりをカードいっぱいに広げる */}
									<button
										type="button"
										data-work-id={w.id}
										onClick={() => emit<WorkOpenDetail>(EVENTS.workOpen, { id: w.id })}
										className="cursor-pointer text-left outline-none after:absolute after:inset-0 after:content-[''] group-hover:underline"
									>
										{w.title}
									</button>
								</h3>
								<p className="mt-1 text-[12px] text-mute">{w.authors.join('、')}</p>
								<p className="mt-3 flex flex-wrap gap-1.5">
									{w.categories.map((c) => (
										<span key={c} className="chip">
											{c}
										</span>
									))}
								</p>
							</article>
						</li>
					))}
				</ul>
			)}
		</>
	);
}
