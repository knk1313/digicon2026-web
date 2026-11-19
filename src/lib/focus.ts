// フォーカスとつかむ操作で使う要素の選び方

/** Tab で巡る要素 */
export const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';

/** マウスでつかんで揺らすとき、つかまない要素（押して使う部品） */
export const NO_GRAB = 'a, button, input, select, textarea, [contenteditable]';
