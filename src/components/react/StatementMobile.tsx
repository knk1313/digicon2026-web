// ステートメントのシート（言葉のモビール）。
// シートは有孔ボードの孔に2本のワイヤーで留めたカード。ページを開いた直後に画面の上の外から落ちてきて、
// ワイヤーに受け止められて揺れて止まる（lib/physics/pinned.ts）。マウスでつかんで揺らせる。
// 外を押す・「閉じる ×」・Esc で、ワイヤーを巻き取って上へ引き上げられて消える。
// 見た目は docs/design/components.md の StatementMobile、流れは docs/design/rules.md の ①②
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MIN_DROP, MOBILE_MAX, gridFor, snapX } from '../../lib/board';
import { site, splitStatement } from '../../lib/data';
import { EVENTS, emit, on, type StatementClosedDetail } from '../../lib/events';
import type { Pt } from '../../lib/physics/cable';
import { PinnedCard } from '../../lib/physics/pinned';
import { BAR_DENSITY, BAR_THICK, HOOK_UP, MobileSim, type MBar, type MCard, type MobilePose } from '../../lib/physics/mobile-sim';

// ---- 本文（連・行・句） ----

const STANZAS = splitStatement(site.theme.statement);

interface Phrase {
	text: string;
	/** 英字だけの句（medium など）はラベルの書体で組む */
	latin: boolean;
}

const PHRASES: Phrase[] = [];
/** 連ごとの句の番号（行の区切りは横棒では無視し、連を1本の棒に並べる） */
const STANZA_IDS: number[][] = STANZAS.map((stanza) =>
	stanza.flat().map((text) => {
		PHRASES.push({ text, latin: /^[A-Za-z]+$/.test(text) });
		return PHRASES.length - 1;
	}),
);

// ---- モビールの組み立て ----

interface Cfg {
	/** シートの左右の余白 */
	pad: number;
	/** シートの上端から最初の横棒まで */
	top: number;
	/** 札どうしの間隔 */
	gap: number;
	/** 横棒が札の外へはみ出す長さ */
	ext: number;
	/** いちばん長く垂れた札から次の横棒までの糸の長さ */
	threadGap: number;
	/** 最後の札の下の余白 */
	bottom: number;
	/** 横棒から札までの糸の長さ（順に使い回す） */
	lens: number[];
}

const DESKTOP: Cfg = { pad: 26, top: 72, gap: 8, ext: 14, threadGap: 30, bottom: 34, lens: [14, 32, 20, 42, 24, 34, 12, 28] };
const MOBILE: Cfg = { pad: 14, top: 52, gap: 6, ext: 10, threadGap: 18, bottom: 20, lens: [8, 17, 12, 22, 14, 19, 6, 15] };

/** 連と連をつなぐ糸の色（黄→青→赤）。足りなければ最後の色を使う */
const STAGE = ['var(--color-tsunagu)', 'var(--color-kawaru)', 'var(--color-umareru)'];

/** シートを吊る2本のワイヤーの位置（幅に対する割合） */
const SHEET_HANG = [0.12, 0.88];

interface Size {
	w: number;
	h: number;
}
interface PlacedCard extends MCard {
	/** 吊っている横棒の高さ（糸の上端） */
	barY: number;
}
type Bar = MBar;
interface Thread {
	x: number;
	y1: number;
	y2: number;
	color: string;
	/** 札の下端に結び目を描くか（最初の糸はシートの上端から下りるので描かない） */
	knot: boolean;
}
interface Mobile {
	anchor: Pt;
	cards: PlacedCard[];
	bars: Bar[];
	threads: Thread[];
	height: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * 句を横棒に並べて、本物のモビールのように釣り合わせる。
 * ・各連は1本の横棒に吊り、収まらない句は次の棒へ送る（縦の並びは上から順）
 * ・次の棒は、前の棒の真ん中にいちばん近い札（運び手）の下端から吊る
 * ・横の位置は下の棒から決める：棒ごとに、ぶら下がるもの全部（札と、その先の棒と札）の重さが釣り合う点（吊り点）を求め、
 *   その吊り点が上の運び手の真下に来るよう上の棒を置く。だから糸は最初からまっすぐ垂れ、全体が1本の軸のまわりにまとまる
 * ・最後に、全体をシートの中央に寄せる
 */
function layoutMobile(sizes: Size[], width: number, c: Cfg): Mobile {
	const inner = width - c.pad * 2;
	// 1. 棒ごとの句（連・棒の中の番号つき）
	const groups: { ids: number[]; si: number; k: number }[] = [];
	STANZA_IDS.forEach((ids, si) => {
		let cur: number[] = [];
		let curW = 0;
		let k = 0;
		for (const id of ids) {
			const w = sizes[id].w;
			const next = cur.length ? curW + c.gap + w : w;
			if (cur.length && next > inner - c.ext * 2) {
				groups.push({ ids: cur, si, k: k++ });
				cur = [id];
				curW = w;
			} else {
				cur.push(id);
				curW = next;
			}
		}
		if (cur.length) groups.push({ ids: cur, si, k });
	});
	const n = groups.length;

	// 2. 棒の中での札の並び（棒の左端の札の左端を 0 とした x）と、縦の位置（上から）
	const rel = groups.map((g, gi) => {
		let x = 0;
		const items = g.ids.map((id, j) => {
			const s = sizes[id];
			const it = { id, x, w: s.w, h: s.h, len: c.lens[(gi * 3 + j) % c.lens.length] };
			x += s.w + c.gap;
			return it;
		});
		const cw = x - c.gap;
		// 運び手：棒の真ん中にいちばん近い札（次の棒をここから吊る）
		let carrier = 0;
		let best = Infinity;
		items.forEach((it, j) => {
			const d = Math.abs(it.x + it.w / 2 - cw / 2);
			if (d < best) {
				best = d;
				carrier = j;
			}
		});
		return { items, cw, carrier };
	});
	const barYs: number[] = [];
	let y = c.top;
	let bottom = 0;
	rel.forEach((r) => {
		barYs.push(y);
		bottom = Math.max(...r.items.map((it) => y + it.len + it.h));
		y = bottom + c.threadGap;
	});

	// 3. 横の位置を下の棒から決める。off[g] は棒 g の札の並びの左端の x（全体の仮の座標）
	// 横棒の 1px あたりの重さ（mobile-sim.ts の横棒と同じ）
	const barMass = BAR_DENSITY * BAR_THICK;
	const off: number[] = new Array(n).fill(0);
	const hook: number[] = new Array(n).fill(0);
	let below = 0; // 下にぶら下がる重さの合計
	for (let gi = n - 1; gi >= 0; gi--) {
		const r = rel[gi];
		if (gi < n - 1) {
			// 運び手の真ん中が、下の棒の吊り点の真下（真上）に来るように置く
			const cr = r.items[r.carrier];
			off[gi] = hook[gi + 1] - (cr.x + cr.w / 2);
		}
		let m = 0;
		let mx = 0;
		r.items.forEach((it, j) => {
			const w = it.w * it.h + (j === r.carrier && gi < n - 1 ? below : 0);
			m += w;
			mx += w * (off[gi] + it.x + it.w / 2);
		});
		const barLen = r.cw + c.ext * 2;
		const bm = barLen * barMass;
		m += bm;
		mx += bm * (off[gi] + r.cw / 2);
		hook[gi] = mx / m;
		// この棒から下の重さの合計（m には下の分がもう入っている）
		below = m;
	}

	// 4. 全体をシートの中央へ寄せる
	let minX = Infinity;
	let maxX = -Infinity;
	rel.forEach((r, gi) => {
		minX = Math.min(minX, off[gi] - c.ext);
		maxX = Math.max(maxX, off[gi] + r.cw + c.ext);
	});
	const shift = width / 2 - (minX + maxX) / 2;

	const cards: PlacedCard[] = [];
	const bars: Bar[] = [];
	const threads: Thread[] = [];
	rel.forEach((r, gi) => {
		const barY = barYs[gi];
		const left = off[gi] + shift;
		const barIndex = bars.length;
		const bar: Bar = { x1: left - c.ext, x2: left + r.cw + c.ext, y: barY, low: 0, hook: hook[gi] + shift };
		bars.push(bar);
		r.items.forEach((it, j) => {
			cards.push({ id: it.id, x: left + it.x, y: barY + it.len, w: it.w, h: it.h, barY, bar: barIndex });
			if (j === r.carrier) bar.low = cards.length - 1;
		});
		const g = groups[gi];
		threads.push({
			x: bar.hook,
			y1: 0,
			y2: barY,
			// 連と連のあいだだけ段階色。同じ連の中で送った棒は普通のワイヤー
			color: g.k === 0 ? STAGE[Math.min(g.si, STAGE.length - 1)] : 'var(--color-wire)',
			knot: gi > 0,
		});
	});
	return { anchor: { x: hook[0] + shift, y: 0 }, cards, bars, threads, height: Math.ceil(bottom + c.bottom) };
}

// ---- シートを吊るペグとワイヤー（画面の座標） ----

interface Geom {
	/** ペグの中心 */
	pegs: { x: number; y: number }[];
	/** 吊られる側の孔の中心（シートが下りきったとき） */
	grommets: { x: number; y: number }[];
	/** シートの上端から画面の外へ出るまでの巻き上げ量 */
	maxLift: number;
	peg: number;
	grommet: number;
	wire: number;
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

// ---- 動き ----

const SCRIM = 0.35;
/** つかまない要素 */
const NO_DRAG = 'a, button, input, select, textarea, [contenteditable]';

function reducedMotion(): boolean {
	return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ---- ページのスクロールを止める ----

/** スクロールバーが消えても幅が変わらないよう、その分を右の余白で埋める */
function lockScroll(): void {
	const html = document.documentElement;
	const sb = window.innerWidth - html.clientWidth;
	html.style.setProperty('--statement-sb', `${sb}px`);
	html.style.overflow = 'hidden';
	html.style.paddingRight = sb > 0 ? `${sb}px` : '';
}
function unlockScroll(): void {
	const html = document.documentElement;
	html.style.removeProperty('--statement-sb');
	html.style.overflow = '';
	html.style.paddingRight = '';
}

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

type Phase = 'open' | 'opening' | 'closing' | 'closed';

// 札の組み方。測る札と並べる札で同じクラスを使う
const CARD = 'absolute top-0 left-0 whitespace-nowrap border border-section-line bg-panel px-[9px] py-[3px] text-ink max-md:px-[7px]';
const CARD_JA = 'font-statement text-[17px] leading-[1.6] tracking-[0.04em] max-md:py-[2px] max-md:text-[13.5px] max-md:leading-[1.55] max-md:tracking-[0.04em]';
const CARD_LATIN = 'font-label text-[13px] font-bold leading-[1.7] max-md:text-[10.5px]';

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
	const wiresRef = useRef<SVGGElement>(null);
	const pegsRef = useRef<SVGGElement>(null);

	/** シートの物理（板の孔に留めたカード） */
	const cardRef = useRef<PinnedCard | null>(null);
	/** モビールの物理（横棒と句の札）と、それを描く要素 */
	const simRef = useRef<MobileSim | null>(null);
	const threadEls = useRef<(SVGLineElement | null)[]>([]);
	const hookEls = useRef<(SVGLineElement | null)[]>([]);
	const knotEls = useRef<(SVGCircleElement | null)[]>([]);
	const barEls = useRef<(SVGLineElement | null)[]>([]);
	const stringEls = useRef<(SVGLineElement | null)[]>([]);
	const cardEls = useRef<(HTMLSpanElement | null)[]>([]);
	const geomRef = useRef<Geom | null>(null);
	const animRef = useRef(0);
	/** つかみ始めの候補（6px 動いたらつかむ） */
	const pendingRef = useRef<{ id: number; x: number; y: number } | null>(null);
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
		if (pegsRef.current) pegsRef.current.style.opacity = String(p);
		if (!card || !wiresRef.current) return;
		const parts = wiresRef.current.children;
		card.strings().forEach((s, i) => {
			const wire = parts[i * 2] as SVGPathElement | undefined;
			const ring = parts[i * 2 + 1] as SVGCircleElement | undefined;
			wire?.setAttribute('d', s.path);
			ring?.setAttribute('cx', s.end.x.toFixed(2));
			ring?.setAttribute('cy', s.end.y.toFixed(2));
		});
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
		setSizes([...box.children].map((el) => {
			const e = el as HTMLElement;
			return { w: Math.ceil(e.offsetWidth), h: Math.ceil(e.offsetHeight) };
		}));
		setWidth(sheet.clientWidth);
		const top = sheet.getBoundingClientRect().top - offset().y;
		setMaxH(Math.max(160, window.innerHeight - top - 16));
		setGeomAndCard(measureGeom(sheet));
	}, [setGeomAndCard]);

	const mobileLayout = useMemo(
		() => (sizes && width ? layoutMobile(sizes, width, mobile ? MOBILE : DESKTOP) : null),
		[sizes, width, mobile],
	);

	// モビールの物理を作る（並びが変わるたびに作り直す）。毎フレーム、糸・横棒・札を描き直す
	useLayoutEffect(() => {
		if (!mobileLayout) return;
		const draw = (pose: MobilePose) => {
			const f = (v: number) => v.toFixed(2);
			const line = (el: SVGLineElement | null, a: Pt, b: Pt) => {
				if (!el) return;
				el.setAttribute('x1', f(a.x));
				el.setAttribute('y1', f(a.y));
				el.setAttribute('x2', f(b.x));
				el.setAttribute('y2', f(b.y));
			};
			pose.threads.forEach((t, i) => {
				line(threadEls.current[i], t.top, t.hook);
				line(hookEls.current[i], t.hook, t.foot);
				const k = knotEls.current[i];
				if (k) {
					k.setAttribute('cx', f(t.top.x));
					k.setAttribute('cy', f(t.top.y));
				}
			});
			pose.bars.forEach(([a, b], i) => line(barEls.current[i], a, b));
			pose.strings.forEach(([a, b], i) => line(stringEls.current[i], a, b));
			pose.cards.forEach((p, i) => {
				const el = cardEls.current[i];
				const c = mobileLayout.cards[i];
				if (el) el.style.transform = `translate(${f(p.x - c.w / 2)}px, ${f(p.y - c.h / 2)}px) rotate(${p.a.toFixed(4)}rad)`;
			});
		};
		const sim = new MobileSim(
			{
				anchor: { ...mobileLayout.anchor },
				cards: mobileLayout.cards.map((c) => ({ ...c })),
				bars: mobileLayout.bars.map((b) => ({ ...b })),
				// シートの枠（中身の幅と高さ）。札と横棒はこの中に収まる
				frame: { width, height: mobileLayout.height },
			},
			draw,
		);
		simRef.current = sim;
		return () => {
			sim.destroy();
			if (simRef.current === sim) simRef.current = null;
		};
	}, [mobileLayout, width]);
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

	// 開いているあいだ、シートをマウスでつかんで揺らせる（タッチはスクロールに使う）
	useEffect(() => {
		if (phase !== 'open' && phase !== 'opening') return;
		const onDown = (e: PointerEvent) => {
			if (e.button !== 0 || e.pointerType === 'touch') return;
			const t = e.target as Element | null;
			if (!t || !sheetRef.current?.contains(t) || t.closest(NO_DRAG)) return;
			pendingRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
		};
		const onMove = (e: PointerEvent) => {
			const card = cardRef.current;
			if (!card) return;
			const p = pendingRef.current;
			if (p && p.id === e.pointerId && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 6) {
				pendingRef.current = null;
				card.hold({ x: p.x, y: p.y });
				document.documentElement.style.userSelect = 'none';
				window.getSelection()?.removeAllRanges();
				run();
			}
			if (card.held) card.move({ x: e.clientX, y: e.clientY });
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
		window.addEventListener('pointerdown', onDown);
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
		window.addEventListener('pointercancel', onUp);
		return () => {
			window.removeEventListener('pointerdown', onDown);
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
			window.removeEventListener('pointercancel', onUp);
			document.documentElement.style.userSelect = '';
		};
	}, [phase, run]);

	// 右上のボタンや「ステートメントを読む」から開く
	useEffect(() => on(EVENTS.statementOpen, open), [open]);

	// Esc で閉じる。Tab はシートの中で回す
	useEffect(() => {
		if (phase !== 'open' && phase !== 'opening') return;
		const sheet = sheetRef.current;
		if (!sheet) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				close();
				return;
			}
			if (e.key !== 'Tab') return;
			const items = [...sheet.querySelectorAll<HTMLElement>(FOCUSABLE)];
			if (items.length === 0) {
				e.preventDefault();
				sheet.focus();
				return;
			}
			const first = items[0];
			const last = items[items.length - 1];
			const active = document.activeElement;
			if (e.shiftKey && (active === first || active === sheet || !sheet.contains(active))) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && (active === last || !sheet.contains(active))) {
				e.preventDefault();
				first.focus();
			}
		};
		// シートの外（右上のボタンなど）にフォーカスが出たら戻す
		const onFocusIn = (e: FocusEvent) => {
			if (phaseRef.current !== 'open' && phaseRef.current !== 'opening') return;
			if (e.target instanceof Node && !sheet.contains(e.target)) sheet.focus({ preventScroll: true });
		};
		document.addEventListener('keydown', onKey);
		document.addEventListener('focusin', onFocusIn);
		return () => {
			document.removeEventListener('keydown', onKey);
			document.removeEventListener('focusin', onFocusIn);
		};
	}, [phase, close]);

	const scrollable = mobileLayout && maxH !== null && mobileLayout.height + 2 > maxH;
	const live = phase === 'open' || phase === 'opening';

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

						{/* モビール：糸・横棒・札は MobileSim（planck）が毎フレーム動かす。ここは最初の姿（釣り合わせた配置） */}
						{mobileLayout && (
							<svg aria-hidden="true" className="absolute top-0 left-0 overflow-visible" width={width} height={mobileLayout.height}>
								{mobileLayout.threads.map((t, i) => {
									const b = mobileLayout.bars[i];
									const top = i === 0 ? mobileLayout.anchor : (() => {
										const low = mobileLayout.cards[mobileLayout.bars[i - 1].low];
										return { x: low.x + low.w / 2, y: low.y + low.h };
									})();
									return (
										<g key={`t${i}`}>
											<line ref={(el) => {
												threadEls.current[i] = el;
											}} x1={top.x} y1={top.y} x2={b.hook} y2={b.y - HOOK_UP} stroke={t.color} strokeWidth={1.6} />
											<line ref={(el) => {
												hookEls.current[i] = el;
											}} x1={b.hook} y1={b.y - HOOK_UP} x2={b.hook} y2={b.y} stroke={t.color} strokeWidth={1.6} />
											{t.knot && <circle ref={(el) => {
														knotEls.current[i] = el;
													}} cx={top.x} cy={top.y} r={2.6} fill="var(--color-ink)" />}
										</g>
									);
								})}
								{mobileLayout.bars.map((b, i) => (
									<line key={`b${i}`} ref={(el) => {
										barEls.current[i] = el;
									}} x1={b.x1} y1={b.y} x2={b.x2} y2={b.y} stroke="var(--color-ink)" strokeWidth={1.5} strokeLinecap="round" />
								))}
								{mobileLayout.cards.map((c, i) => (
									<line key={`s${c.id}`} ref={(el) => {
										stringEls.current[i] = el;
									}} x1={c.x + c.w / 2} y1={c.barY} x2={c.x + c.w / 2} y2={c.y} stroke="var(--color-mute)" strokeWidth={1} />
								))}
							</svg>
						)}
						<div aria-hidden="true">
							{mobileLayout?.cards.map((c, i) => (
								<span
									key={c.id}
									ref={(el) => {
										cardEls.current[i] = el;
									}}
									className={`${CARD} ${PHRASES[c.id].latin ? CARD_LATIN : CARD_JA}`}
									style={{ transform: `translate(${c.x}px, ${c.y}px)` }}
								>
									{PHRASES[c.id].text}
								</span>
							))}
						</div>

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

				{/* 札の大きさを測るための見えない複製 */}
				<div ref={measureRef} aria-hidden="true" className="invisible absolute top-0 left-0">
					{PHRASES.map((p, i) => (
						<span key={i} className={`${CARD} ${p.latin ? CARD_LATIN : CARD_JA}`}>
							{p.text}
						</span>
					))}
				</div>
			</div>

			{/* 板の孔のペグからシートの孔へのワイヤー */}
			{geom && (
				<svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full">
					{/* 子の並びは apply() が前提にしている：ワイヤー、孔、ワイヤー、孔… */}
					<g ref={wiresRef}>
						{geom.pegs.flatMap((p, i) => [
							<path
								key={`w${i}`}
								d={`M${p.x},${p.y} L${p.x},${geom.grommets[i].y}`}
								fill="none"
								stroke="var(--color-wire)"
								strokeWidth={geom.wire}
								strokeLinecap="round"
								strokeLinejoin="round"
							/>,
							<circle
								key={`g${i}`}
								cx={geom.grommets[i].x}
								cy={geom.grommets[i].y}
								r={geom.grommet / 2}
								fill="var(--color-board)"
								stroke="var(--color-ink)"
								strokeWidth={1.5}
							/>,
						])}
					</g>
					<g ref={pegsRef}>
						{geom.pegs.map((p, i) => (
							<circle key={i} cx={p.x} cy={p.y} r={geom.peg / 2} fill="var(--color-peg)" stroke="var(--color-peg)" strokeWidth={1.5} />
						))}
					</g>
				</svg>
			)}
		</div>
	);
}
