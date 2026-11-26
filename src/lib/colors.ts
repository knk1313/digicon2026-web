// 段階色（つなぐ → かわる → うまれる）。値は src/styles/global.css の --color-* を参照する

export const TSUNAGU = 'var(--color-tsunagu)';
export const KAWARU = 'var(--color-kawaru)';
export const UMARERU = 'var(--color-umareru)';

/** タイトルの段、ステートメントの連など、3段階で順に使う色 */
export const STAGE_COLORS = [TSUNAGU, KAWARU, UMARERU] as const;
