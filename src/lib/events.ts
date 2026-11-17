// island どうしで使うイベント。一覧と意味は docs/implementation/plan.md の「イベント」

export const EVENTS = {
	/** シートを開く */
	statementOpen: 'digicon:statement-open',
	/** シートが閉じた。detail.first が true なら最初の1回 */
	statementClosed: 'digicon:statement-closed',
	/** 作品概要を開く。detail.id */
	workOpen: 'digicon:work-open',
	/** レイアウトが変わった（孔や床の位置を測り直す合図） */
	layout: 'digicon:layout',
} as const;

export interface StatementClosedDetail {
	first: boolean;
}
export interface WorkOpenDetail {
	id: string;
}

export function emit<T>(name: string, detail?: T): void {
	window.dispatchEvent(new CustomEvent(name, { detail }));
}

export function on<T>(name: string, handler: (detail: T) => void): () => void {
	const listener = (e: Event) => handler((e as CustomEvent<T>).detail);
	window.addEventListener(name, listener);
	return () => window.removeEventListener(name, listener);
}
