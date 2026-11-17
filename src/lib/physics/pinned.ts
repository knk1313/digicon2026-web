// ポップアップ（ステートメントのシート、作品概要のパネル）を、有孔ボードの孔に留めたカードとして動かす。
// ・開く：カードは画面の上の外から落ちてきて、板の孔のペグからのワイヤーに受け止められ、揺れて止まる
//   （少し横にずらして落とすので、受け止められたあと振り子のように振れる）
// ・つかめる：マウスでつかんで動かせ、離すと揺れて戻る（ほかの札と同じ）
// ・閉じる：ワイヤーを巻き取って、上へ引き上げる
// 物理は hung.ts（ib/mobile.js と同じ手触り）。DOM には触らず、位置と糸の形だけを返す
import type { Pt } from './cable';
import { createBody, constrain, restBody, stepBody, stepStrings, syncEnds, type HungBody } from './hung';

export type PinnedPhase = 'falling' | 'hanging' | 'lifting' | 'gone';

export class PinnedCard {
	body: HungBody;
	phase: PinnedPhase = 'hanging';
	/** 引き上げる速さ（px / フレーム） */
	private liftV = 0;
	/** ここまで上がったら引き上げ終わり（原点の y） */
	private liftEnd = 0;
	private onGone: (() => void) | null = null;
	/** つかんでいる点（原点からのずれ）と指の位置 */
	private grab: { g: Pt; ptr: Pt } | null = null;

	/** holes は吊られる側の孔、pegs は板の孔（どちらも同じ座標系。カードが下りきった位置） */
	constructor(holes: Pt[], pegs: Pt[]) {
		this.body = createBody(holes, pegs);
	}

	/** いまのずれ（静止した位置から） */
	get offset(): Pt {
		return { x: this.body.pos.x - this.body.home.x, y: this.body.pos.y - this.body.home.y };
	}

	/**
	 * 上から落とす。above は静止した位置からどれだけ上に置くか（画面の外まで）、
	 * side は横のずれ（受け止められたあとに振れる大きさ）
	 */
	drop(above: number, side: number): void {
		const b = this.body;
		// 引き上げの途中なら、いまの位置からそのまま落とす
		if (this.phase !== 'lifting') {
			b.pos = { x: b.home.x + side, y: b.home.y - above };
			b.prev = { x: b.pos.x, y: b.pos.y - 4 };
		} else {
			b.prev = { ...b.pos };
		}
		this.restoreLength();
		this.phase = 'falling';
		b.quiet = 0;
		syncEnds(b);
	}

	/** 動きを省いて、静止した位置に置く */
	place(): void {
		this.restoreLength();
		restBody(this.body);
		this.phase = 'hanging';
	}

	/** ワイヤーを巻き取って引き上げる。above まで上がったら done */
	lift(above: number, done: () => void): void {
		this.grab = null;
		this.phase = 'lifting';
		this.liftV = 2;
		this.liftEnd = this.body.home.y - above;
		this.onGone = done;
		this.body.quiet = 0;
	}

	/** つかみ始め。p は指の位置 */
	hold(p: Pt): void {
		if (this.phase === 'lifting' || this.phase === 'gone') return;
		const b = this.body;
		this.grab = { g: { x: p.x - b.pos.x, y: p.y - b.pos.y }, ptr: { ...p } };
		this.phase = 'hanging';
	}
	move(p: Pt): void {
		if (this.grab) this.grab.ptr = { ...p };
	}
	release(): void {
		this.grab = null;
	}
	get held(): boolean {
		return this.grab !== null;
	}

	/** 1 フレーム進める。動いていれば true（止まっていれば描き直さなくてよい） */
	step(): boolean {
		const b = this.body;
		if (this.phase === 'gone') return false;
		if (this.phase === 'lifting') {
			// 巻き取り：ワイヤーを短くしながら、だんだん速く引き上げる。横の揺れは収める
			this.liftV = Math.min(this.liftV * 1.12 + 0.6, 60);
			b.prev = { ...b.pos };
			b.pos.y -= this.liftV;
			b.pos.x += (b.home.x - b.pos.x) * 0.15;
			for (const s of b.strings) {
				const d = Math.hypot(b.pos.x + s.off.x - s.a.x, b.pos.y + s.off.y - s.a.y);
				s.L = Math.max(2, Math.min(s.L, d));
			}
			stepStrings(b, true);
			if (b.pos.y <= this.liftEnd) {
				this.phase = 'gone';
				const done = this.onGone;
				this.onGone = null;
				done?.();
			}
			return true;
		}
		const held = this.grab ? { x: this.grab.ptr.x - this.grab.g.x, y: this.grab.ptr.y - this.grab.g.y } : null;
		// 落ちているあいだ、ペグより上ではワイヤーはたるんでいて引かない（ペグの下まで落ちて受け止められる）
		const falling = this.phase === 'falling';
		const moving = stepBody(b, held, undefined, falling);
		if (!held) {
			constrain(b, 3, falling);
			// 読むためのカードなので、受け止められたあとの揺れは早めに収める（数秒以内）
			if (b.strings.every((s) => b.pos.y + s.off.y >= s.a.y)) {
				b.prev.x += (b.pos.x - b.prev.x) * 0.025;
				b.prev.y += (b.pos.y - b.prev.y) * 0.025;
			}
		}
		syncEnds(b);
		if (this.phase === 'falling' && b.quiet > 20) this.phase = 'hanging';
		if (!moving && b.quiet > 40) {
			restBody(b);
			return false;
		}
		return true;
	}

	/** 糸の本数ぶんの、描くための形 */
	strings(): { path: string; end: Pt; peg: Pt }[] {
		return this.body.strings.map((s) => ({ path: s.cable.path(), end: { ...s.end }, peg: s.a }));
	}

	private restoreLength(): void {
		for (const s of this.body.strings) {
			s.L = Math.hypot(s.off.x + this.body.home.x - s.a.x, s.off.y + this.body.home.y - s.a.y);
		}
	}
}
