/**
 * How a pick entered the system.
 *
 * - `manual`   — a player chose the card themselves (`{card_name}`)
 * - `ondemand` — a player's client asked the server to auto-pick for them (`{auto:true}`)
 * - `resume`   — the draft entered `drafting` and the seat on the clock was auto-picked for
 * - `cascade`  — auto-picked as the chain continued after an earlier pick in the same run
 *
 * Picks made before this column existed are NULL.
 */
export type PickSource = 'manual' | 'ondemand' | 'resume' | 'cascade';
