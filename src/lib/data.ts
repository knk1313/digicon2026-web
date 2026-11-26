// デモデータの型と読み込み。項目の意味は docs/content-and-data.md
import demo from '../data/demo.json';

export interface Work {
	id: string;
	title: string;
	authors: string[];
	summary: string;
	description: string;
	thumbnail: string;
	/** 1つ以上。トップページの絞り込みで使う */
	categories: string[];
}

export interface Site {
	title: string;
	period: { start: string; end: string };
	theme: { title: string; statement: string };
	venue: string;
	/** お知らせを出す X アカウントの URL */
	x: string;
	works: Work[];
}

export const site: Site = demo as Site;

/** すべての作品に出てくるカテゴリー（重複なし、並びは名前順） */
export function allCategories(works: Work[]): string[] {
	return [...new Set(works.flatMap((w) => w.categories))].sort();
}

/** 会期を「2027.02.13 — 02.15」の形にする */
export function formatPeriod(p: Site['period']): string {
	const [y1, m1, d1] = p.start.split('-');
	const [y2, m2, d2] = p.end.split('-');
	const end = y1 === y2 ? `${m2}.${d2}` : `${y2}.${m2}.${d2}`;
	return `${y1}.${m1}.${d1} — ${end}`;
}

/**
 * ステートメントを連・行・句に分ける。
 * 連は空行、行は改行、句は全角スペースで区切ってある
 */
export function splitStatement(text: string): string[][][] {
	return text
		.split(/\n\s*\n/)
		.map((stanza) => stanza.split('\n').map((line) => line.split('　').filter(Boolean)));
}
