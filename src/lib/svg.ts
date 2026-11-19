// React を通さずに SVG を組み立てて書き換えるための小さな道具

const SVG_NS = 'http://www.w3.org/2000/svg';

/** SVG の要素を作る。parent を渡すと、その末尾に加える */
export function svg<K extends keyof SVGElementTagNameMap>(
	tag: K,
	attrs: Record<string, string | number> = {},
	parent?: Element,
): SVGElementTagNameMap[K] {
	const el = document.createElementNS(SVG_NS, tag);
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
	parent?.appendChild(el);
	return el;
}

/** 属性をまとめて書き換える。数は小数第2位までに丸める（毎フレーム書く座標向け） */
export function setAttrs(el: Element, attrs: Record<string, string | number>): void {
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, typeof v === 'number' ? v.toFixed(2) : v);
}

/** 表示する・隠す */
export function show(el: SVGElement, visible: boolean): void {
	el.style.display = visible ? '' : 'none';
}
