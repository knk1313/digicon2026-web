// 板の孔に留めたカード（lib/physics/pinned.ts の PinnedCard）の、ペグ・ワイヤー・吊られる側の孔を描く SVG。
// React は最初の形を置くだけで、動いているあいだの形は drawPinWires が毎フレーム書き換える。
// 作品概要のパネル（WorkDetail）とステートメントのモーダル（StatementModal）で使う
import type { Ref } from 'react';
import type { Pt } from '../../../lib/physics/cable';

/** ペグと孔の位置、太さ。pegs[i] と grommets[i] が1本のワイヤーの両端 */
export interface PinGeom {
	/** ペグの中心 */
	pegs: Pt[];
	/** 吊られる側の孔の中心（カードが下りきったとき） */
	grommets: Pt[];
	/** ペグの頭の直径 */
	peg: number;
	/** 吊られる側の孔の直径 */
	grommet: number;
	/** ワイヤーの太さ */
	wire: number;
}

interface Props extends PinGeom {
	ref?: Ref<SVGSVGElement>;
	className: string;
	width?: number;
	height?: number;
}

export default function PinWires({ ref, className, width, height, pegs, grommets, peg, grommet, wire }: Props) {
	return (
		<svg ref={ref} aria-hidden="true" className={className} width={width} height={height}>
			<g data-wires>
				{pegs.map((p, i) => (
					<path
						key={i}
						d={`M${p.x},${p.y} L${p.x},${grommets[i].y}`}
						fill="none"
						stroke="var(--color-wire)"
						strokeWidth={wire}
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				))}
			</g>
			<g data-grommets>
				{grommets.map((g, i) => (
					<circle key={i} cx={g.x} cy={g.y} r={grommet / 2} fill="var(--color-board)" stroke="var(--color-ink)" strokeWidth={1.5} />
				))}
			</g>
			<g data-pegs>
				{pegs.map((p, i) => (
					<circle key={i} cx={p.x} cy={p.y} r={peg / 2} fill="var(--color-peg)" stroke="var(--color-peg)" strokeWidth={1.5} />
				))}
			</g>
		</svg>
	);
}

/**
 * いまのワイヤーの形（PinnedCard.strings()）を書き込む。strings が null なら、ペグの濃さだけ変える。
 * ペグは幕と一緒に現れ、一緒に消えるので、濃さは呼ぶ側が幕に合わせて渡す
 */
export function drawPinWires(svg: SVGSVGElement | null, strings: readonly { path: string; end: Pt }[] | null, pegOpacity: number): void {
	if (!svg) return;
	const pegs = svg.querySelector<SVGGElement>('[data-pegs]');
	if (pegs) pegs.style.opacity = String(pegOpacity);
	if (!strings) return;
	const wires = svg.querySelector('[data-wires]')?.children;
	const ends = svg.querySelector('[data-grommets]')?.children;
	strings.forEach((s, i) => {
		wires?.[i]?.setAttribute('d', s.path);
		const end = ends?.[i];
		end?.setAttribute('cx', s.end.x.toFixed(2));
		end?.setAttribute('cy', s.end.y.toFixed(2));
	});
}
