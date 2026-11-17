// 吊られた札（HangLayer）とタイトルの文字（HangingTitle）が、互いの位置を知るための置き場。
// 別々の island なので、ここに毎フレームの位置を書き、相手はそれを読む。座標はどちらもボード（[data-board]）の左上から
import type { Rect } from './hung';

/** 札のいまの外形（動いている札も、いまの位置で） */
export const panels = new Map<HTMLElement, Rect>();

/** つままれている文字の外形（この箱に重なった札は押しのけられる） */
export const draggedLetters: Rect[] = [];

type Listener = () => void;
const listeners = new Set<Listener>();

/** 札が動いたときに呼ばれる（文字を起こして、落ち直させるため） */
export function onPanelsMoved(fn: Listener): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

export function panelsMoved(): void {
	for (const fn of listeners) fn();
}

/** 文字がつままれているとき、札の側に毎フレーム動かしてもらうための合図 */
const letterListeners = new Set<Listener>();
export function onLettersDragged(fn: Listener): () => void {
	letterListeners.add(fn);
	return () => letterListeners.delete(fn);
}
export function lettersDragged(): void {
	for (const fn of letterListeners) fn();
}
