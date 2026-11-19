// 吊られたタイトルの見た目（SVG）。要素を作る関数と、毎フレームの状態を書き込む関数だけを置く。
// 物理と操作は TitleScene.ts が受け持ち、ここは何を描くかを受け取って描くだけ
import type { BoardGrid } from '../../../lib/board';
import type { GlyphShape, Vec } from '../../../lib/physics/glyph';
import type { Rope } from '../../../lib/physics/rope';
import { setAttrs, show, svg } from '../../../lib/svg';

/** 重なり順の層（下から：ワイヤー、ペグ、文字、手前に出すもの） */
export interface TitleLayers {
	wires: SVGGElement;
	pegs: SVGGElement;
	letters: SVGGElement;
	over: SVGGElement;
}

/** つまんでいる文字の吊り先の下見（点線とペグの頭） */
export interface Preview {
	line: SVGLineElement;
	head: SVGCircleElement;
}

/** 1文字ぶんの要素 */
export interface LetterEls {
	g: SVGGElement;
	/** 押す・つまむための当たり（字形の外形） */
	hit: SVGPolygonElement;
	/** ワイヤーの先を近づけたときに出す外形の点線 */
	outline: SVGPolygonElement;
	/** 吊っているワイヤー */
	wire: SVGPathElement;
	/** 吊られる側の環 */
	ringEl: SVGCircleElement;
}

/** タイトル用のペグ1本ぶんの要素 */
export interface PegEls {
	head: SVGCircleElement;
	/** 空のワイヤーと、その先の環 */
	ropeLine: SVGPathElement;
	ropeRing: SVGEllipseElement;
	/** 空のワイヤーの先をつまむための当たり */
	ropeHit: SVGCircleElement;
}

/** 器の SVG を空にして、層と下見を作り直す */
export function createLayers(root: SVGSVGElement, grid: BoardGrid, width: number, height: number): { layers: TitleLayers; preview: Preview } {
	root.replaceChildren();
	root.setAttribute('width', String(width));
	root.setAttribute('height', String(height));
	const layers: TitleLayers = {
		wires: svg('g', {}, root),
		pegs: svg('g', {}, root),
		letters: svg('g', {}, root),
		over: svg('g', {}, root),
	};
	const preview: Preview = {
		line: svg('line', { stroke: 'var(--color-wire)', 'stroke-width': grid.wire, 'stroke-dasharray': '3 3' }, layers.over),
		head: svg('circle', { r: grid.peg / 2, stroke: 'var(--color-peg)', 'stroke-width': 1.5 }, layers.over),
	};
	show(preview.line, false);
	show(preview.head, false);
	return { layers, preview };
}

/** 読点。ワイヤーなしで、その位置に固定して描く（落ちない） */
export function drawComma(layers: TitleLayers, ch: string, x: number, baseline: number, size: number): void {
	const t = svg('text', { x, y: baseline, 'text-anchor': 'middle', fill: 'var(--color-ink)' }, layers.letters);
	t.style.font = `900 ${size}px var(--font-display)`;
	t.textContent = ch;
}

/** 文字の要素を作る。原点は字形の重心 */
export function createLetterEls(layers: TitleLayers, grid: BoardGrid, ch: string, shape: GlyphShape, font: string): LetterEls {
	const wire = svg('path', { fill: 'none', stroke: 'var(--color-wire)', 'stroke-width': grid.wire, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, layers.wires);
	const ringEl = svg('circle', { r: 3, fill: 'none', stroke: 'var(--color-wire)', 'stroke-width': 1.4 }, layers.wires);
	const g = svg('g', { 'data-title-letter': ch }, layers.letters);
	const text = svg('text', { x: -shape.centroid.x, y: -shape.centroid.y, 'text-anchor': 'middle', fill: 'var(--color-ink)' }, g);
	// 形を測ったのと同じ font で描く（字形の下端と当たり判定をそろえる）
	text.style.font = font;
	text.textContent = ch;
	const pts = shape.hull.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
	const outline = svg('polygon', { points: pts, fill: 'none', stroke: 'var(--color-ink)', 'stroke-width': 1.2, 'stroke-dasharray': '4 3' }, g);
	const hit = svg('polygon', { points: pts, fill: 'transparent' }, g);
	show(outline, false);
	hit.style.touchAction = 'none';
	return { g, hit, outline, wire, ringEl };
}

/** タイトル用のペグの要素を作る */
export function createPegEls(layers: TitleLayers, grid: BoardGrid, x: number, y: number): PegEls {
	const ropeLine = svg('path', { fill: 'none', stroke: 'var(--color-wire-loose)', 'stroke-width': grid.wire, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, layers.wires);
	const ropeRing = svg('ellipse', { rx: 3, ry: 2.2, fill: 'none', stroke: 'var(--color-wire-loose)', 'stroke-width': 1.4 }, layers.wires);
	const head = svg('circle', { cx: x, cy: y, r: grid.peg / 2, stroke: 'var(--color-peg)', 'stroke-width': 1.5 }, layers.pegs);
	// 先の当たりは文字より前（over）に置く。指で押しやすいよう大きめ
	const ropeHit = svg('circle', { r: 16, fill: 'transparent' }, layers.over);
	ropeHit.style.pointerEvents = 'all';
	ropeHit.style.cursor = 'grab';
	ropeHit.style.touchAction = 'none';
	show(ropeHit, false);
	return { head, ropeLine, ropeRing, ropeHit };
}

/** 文字を押せるようにする・押せなくする */
export function setLetterInteractive(els: LetterEls, enabled: boolean): void {
	els.hit.style.pointerEvents = enabled ? 'all' : 'none';
	els.hit.style.cursor = enabled ? 'pointer' : '';
}

/**
 * 文字の位置と傾き、吊っているワイヤーを描く。
 * wire が null なら吊られていない（ワイヤーと環を隠す）。path が null ならワイヤーの形は前のまま
 */
export function drawLetter(els: LetterEls, p: Vec, angle: number, wire: { path: string | null; ring: Vec } | null): void {
	const deg = (angle * 180) / Math.PI;
	els.g.setAttribute('transform', `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)}) rotate(${deg.toFixed(3)})`);
	show(els.wire, !!wire);
	show(els.ringEl, !!wire);
	if (!wire) return;
	if (wire.path !== null) els.wire.setAttribute('d', wire.path);
	// 環の描き方は HangLayer の ring とそろえる
	setAttrs(els.ringEl, { cx: wire.ring.x, cy: wire.ring.y - 3 });
}

/**
 * タイトル用のペグを描く。fill はペグの頭の色（吊っている文字の段の色）。
 * rope は空のワイヤー（文字を吊っていれば null）、grabbable はその先をつまめるか、active はつまんでいる・選んでいるか
 */
export function drawTitlePeg(els: PegEls, o: { fill: string; rope: Rope | null; grabbable: boolean; active: boolean; wire: number }): void {
	els.head.setAttribute('fill', o.fill);
	const rope = o.rope;
	show(els.ropeLine, !!rope);
	show(els.ropeRing, !!rope);
	show(els.ropeHit, !!rope && o.grabbable);
	if (!rope) return;
	els.ropeLine.setAttribute('d', rope.toPath());
	const e = rope.end;
	const deg = (rope.endAngle * 180) / Math.PI;
	// 環は少し傾けて垂らす
	setAttrs(els.ropeRing, { transform: `translate(${e.x.toFixed(2)} ${(e.y + 2).toFixed(2)}) rotate(${(deg + 12).toFixed(2)})` });
	setAttrs(els.ropeHit, { cx: e.x, cy: e.y });
	// つまんでいる・選んでいるワイヤーは濃く太く
	const stroke = o.active ? 'var(--color-wire)' : 'var(--color-wire-loose)';
	els.ropeLine.setAttribute('stroke', stroke);
	els.ropeLine.setAttribute('stroke-width', String(o.active ? o.wire * 1.6 : o.wire));
	els.ropeRing.setAttribute('stroke', stroke);
	els.ropeRing.setAttribute('stroke-width', o.active ? '2.2' : '1.4');
}

/** 吊り先の下見を描く。target が null なら隠す。end はつまんでいる文字の環、color はその段の色 */
export function drawPreview(pv: Preview, target: Vec | null, end: Vec, color: string): void {
	show(pv.line, !!target);
	show(pv.head, !!target);
	if (!target) return;
	setAttrs(pv.head, { cx: target.x, cy: target.y, fill: color });
	setAttrs(pv.line, { x1: target.x, y1: target.y, x2: end.x, y2: end.y });
}
