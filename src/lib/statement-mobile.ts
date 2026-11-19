// ステートメントの言葉のモビールの組み立て（DOM に触らない計算だけ）。
// 句の札の大きさとシートの幅から、横棒・糸・札の釣り合った配置を求める。
// 動かすのは lib/physics/mobile-sim.ts、描くのは components/react/statement/WordMobile.tsx
import { STAGE_COLORS } from './colors';
import type { Pt } from './physics/cable';
import { BAR_DENSITY, BAR_THICK, type MBar, type MCard } from './physics/mobile-sim';

// ---- 本文（連・行・句） ----

export interface Phrase {
	text: string;
	/** 英字だけの句（medium など）はラベルの書体で組む */
	latin: boolean;
}

/**
 * 連・行・句に分けた本文（data.ts の splitStatement）から、句の一覧と、連ごとの句の番号を作る。
 * 行の区切りは横棒では無視し、連を1本の棒に並べる
 */
export function buildPhrases(stanzas: string[][][]): { phrases: Phrase[]; stanzaIds: number[][] } {
	const phrases: Phrase[] = [];
	const stanzaIds = stanzas.map((stanza) =>
		stanza.flat().map((text) => {
			phrases.push({ text, latin: /^[A-Za-z]+$/.test(text) });
			return phrases.length - 1;
		}),
	);
	return { phrases, stanzaIds };
}

// ---- 組み立ての決まり ----

export interface MobileConfig {
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

/** PC とスマホの画面幅での決まり */
export const MOBILE_CONFIG: { desktop: MobileConfig; phone: MobileConfig } = {
	desktop: { pad: 26, top: 72, gap: 8, ext: 14, threadGap: 30, bottom: 34, lens: [14, 32, 20, 42, 24, 34, 12, 28] },
	phone: { pad: 14, top: 52, gap: 6, ext: 10, threadGap: 18, bottom: 20, lens: [8, 17, 12, 22, 14, 19, 6, 15] },
};

// ---- 組み立てた結果 ----

export interface Size {
	w: number;
	h: number;
}
export interface PlacedCard extends MCard {
	/** 吊っている横棒の高さ（糸の上端） */
	barY: number;
}
export interface Thread {
	x: number;
	y1: number;
	y2: number;
	color: string;
	/** 札の下端に結び目を描くか（最初の糸はシートの上端から下りるので描かない） */
	knot: boolean;
}
export interface MobileLayout {
	anchor: Pt;
	cards: PlacedCard[];
	bars: MBar[];
	threads: Thread[];
	height: number;
}

/**
 * 句を横棒に並べて、本物のモビールのように釣り合わせる。
 * ・各連は1本の横棒に吊り、収まらない句は次の棒へ送る（縦の並びは上から順）
 * ・次の棒は、前の棒の真ん中にいちばん近い札（運び手）の下端から吊る
 * ・横の位置は下の棒から決める：棒ごとに、ぶら下がるもの全部（札と、その先の棒と札）の重さが釣り合う点（吊り点）を求め、
 *   その吊り点が上の運び手の真下に来るよう上の棒を置く。だから糸は最初からまっすぐ垂れ、全体が1本の軸のまわりにまとまる
 * ・最後に、全体をシートの中央に寄せる
 *
 * sizes は句の札の大きさ（phrases と同じ並び）、stanzaIds は連ごとの句の番号
 */
export function layoutMobile(sizes: Size[], width: number, c: MobileConfig, stanzaIds: number[][]): MobileLayout {
	const inner = width - c.pad * 2;
	// 1. 棒ごとの句（連・棒の中の番号つき）
	const groups: { ids: number[]; si: number; k: number }[] = [];
	stanzaIds.forEach((ids, si) => {
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
	const bars: MBar[] = [];
	const threads: Thread[] = [];
	rel.forEach((r, gi) => {
		const barY = barYs[gi];
		const left = off[gi] + shift;
		const barIndex = bars.length;
		const bar: MBar = { x1: left - c.ext, x2: left + r.cw + c.ext, y: barY, low: 0, hook: hook[gi] + shift };
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
			// 連と連のあいだだけ段階色（黄→青→赤。足りなければ最後の色）。同じ連の中で送った棒は普通のワイヤー
			color: g.k === 0 ? STAGE_COLORS[Math.min(g.si, STAGE_COLORS.length - 1)] : 'var(--color-wire)',
			knot: gi > 0,
		});
	});
	return { anchor: { x: hook[0] + shift, y: 0 }, cards, bars, threads, height: Math.ceil(bottom + c.bottom) };
}
