// ステートメントの言葉のモビール（横棒・糸・句の札）。
// 配置は lib/statement-mobile.ts の layoutMobile が決めたものを受け取る。ここで描くのは最初の姿（釣り合わせた配置）で、
// 動き出したら MobileSim（planck）が毎フレーム、糸・横棒・札を書き換える（React の再描画には乗せない）
import { useLayoutEffect, useRef, type Ref, type RefObject } from 'react';
import type { Pt } from '../../../lib/physics/cable';
import { HOOK_UP, MobileSim, type MobilePose } from '../../../lib/physics/mobile-sim';
import type { MobileLayout, Phrase } from '../../../lib/statement-mobile';

// 札の組み方。測る札（PhraseSizer）と並べる札で同じクラスを使う
const CARD = 'absolute top-0 left-0 whitespace-nowrap border border-section-line bg-panel px-[9px] py-[3px] text-ink max-md:px-[7px]';
const CARD_JA = 'font-statement text-[17px] leading-[1.6] tracking-[0.04em] max-md:py-[2px] max-md:text-[13.5px] max-md:leading-[1.55] max-md:tracking-[0.04em]';
const CARD_LATIN = 'font-label text-[13px] font-bold leading-[1.7] max-md:text-[10.5px]';

const cardClass = (p: Phrase) => `${CARD} ${p.latin ? CARD_LATIN : CARD_JA}`;

interface Props {
	layout: MobileLayout;
	/** シートの中身の幅 */
	width: number;
	phrases: Phrase[];
	/** 作ったモビールの物理を渡す先（シートの動きを慣性として伝えるのに使う） */
	simRef: RefObject<MobileSim | null>;
}

export default function WordMobile({ layout, width, phrases, simRef }: Props) {
	const threadEls = useRef<(SVGLineElement | null)[]>([]);
	const hookEls = useRef<(SVGLineElement | null)[]>([]);
	const knotEls = useRef<(SVGCircleElement | null)[]>([]);
	const barEls = useRef<(SVGLineElement | null)[]>([]);
	const stringEls = useRef<(SVGLineElement | null)[]>([]);
	const cardEls = useRef<(HTMLSpanElement | null)[]>([]);

	// モビールの物理を作る（並びが変わるたびに作り直す）。毎フレーム、糸・横棒・札を描き直す
	useLayoutEffect(() => {
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
				const c = layout.cards[i];
				if (el) el.style.transform = `translate(${f(p.x - c.w / 2)}px, ${f(p.y - c.h / 2)}px) rotate(${p.a.toFixed(4)}rad)`;
			});
		};
		const sim = new MobileSim(
			{
				anchor: { ...layout.anchor },
				cards: layout.cards.map((c) => ({ ...c })),
				bars: layout.bars.map((b) => ({ ...b })),
				// シートの枠（中身の幅と高さ）。札と横棒はこの中に収まる
				frame: { width, height: layout.height },
			},
			draw,
		);
		simRef.current = sim;
		return () => {
			sim.destroy();
			if (simRef.current === sim) simRef.current = null;
		};
	}, [layout, width, simRef]);

	return (
		<>
			<svg aria-hidden="true" className="absolute top-0 left-0 overflow-visible" width={width} height={layout.height}>
				{layout.threads.map((t, i) => {
					const b = layout.bars[i];
					// 最初の糸はシートの上端の吊り点から、次からは前の棒の運び手の札の下端から下りる
					const top =
						i === 0
							? layout.anchor
							: (() => {
									const low = layout.cards[layout.bars[i - 1].low];
									return { x: low.x + low.w / 2, y: low.y + low.h };
								})();
					return (
						<g key={`t${i}`}>
							<line
								ref={(el) => {
									threadEls.current[i] = el;
								}}
								x1={top.x}
								y1={top.y}
								x2={b.hook}
								y2={b.y - HOOK_UP}
								stroke={t.color}
								strokeWidth={1.6}
							/>
							<line
								ref={(el) => {
									hookEls.current[i] = el;
								}}
								x1={b.hook}
								y1={b.y - HOOK_UP}
								x2={b.hook}
								y2={b.y}
								stroke={t.color}
								strokeWidth={1.6}
							/>
							{t.knot && (
								<circle
									ref={(el) => {
										knotEls.current[i] = el;
									}}
									cx={top.x}
									cy={top.y}
									r={2.6}
									fill="var(--color-ink)"
								/>
							)}
						</g>
					);
				})}
				{layout.bars.map((b, i) => (
					<line
						key={`b${i}`}
						ref={(el) => {
							barEls.current[i] = el;
						}}
						x1={b.x1}
						y1={b.y}
						x2={b.x2}
						y2={b.y}
						stroke="var(--color-ink)"
						strokeWidth={1.5}
						strokeLinecap="round"
					/>
				))}
				{layout.cards.map((c, i) => (
					<line
						key={`s${c.id}`}
						ref={(el) => {
							stringEls.current[i] = el;
						}}
						x1={c.x + c.w / 2}
						y1={c.barY}
						x2={c.x + c.w / 2}
						y2={c.y}
						stroke="var(--color-mute)"
						strokeWidth={1}
					/>
				))}
			</svg>
			<div aria-hidden="true">
				{layout.cards.map((c, i) => (
					<span
						key={c.id}
						ref={(el) => {
							cardEls.current[i] = el;
						}}
						className={cardClass(phrases[c.id])}
						style={{ transform: `translate(${c.x}px, ${c.y}px)` }}
					>
						{phrases[c.id].text}
					</span>
				))}
			</div>
		</>
	);
}

/** 札の大きさを測るための見えない複製。子の並びは phrases と同じ */
export function PhraseSizer({ ref, phrases }: { ref?: Ref<HTMLDivElement>; phrases: Phrase[] }) {
	return (
		<div ref={ref} aria-hidden="true" className="invisible absolute top-0 left-0">
			{phrases.map((p, i) => (
				<span key={i} className={cardClass(p)}>
					{p.text}
				</span>
			))}
		</div>
	);
}
