import { describe, it, expect } from 'vitest';
import type { Client } from '@libsql/client';
import { resumeAutoPickForCurrentSeat } from './processPick';
import {
  createMemDb, insertCard, insertCubeSnapshot, insertCubeCard, insertDraft,
  insertSeatToken, insertPickEvent,
} from './db/__tests__/testDb';

const DRAFT = 'd1';

function queueOf(entries: Array<[number, string]>): string {
  return JSON.stringify(
    entries.map(([id, name]) => ({ mode: 'pause', cards: [{ id, name }] })),
  );
}

/**
 * 3 seats, 3 picks each. Seat 1 has already picked, so seat 2 is on the clock.
 * Seats 2 and 3 both auto-pick with stocked queues.
 */
async function seed(opts: { phase?: string; seat2AutoPick?: boolean; seat2Queue?: string } = {}): Promise<Client> {
  const client = await createMemDb();
  await insertCubeSnapshot(client, 1);
  for (const [id, name] of [[1, 'Taken'], [21, 'S2 First'], [31, 'S3 First']] as Array<[number, string]>) {
    await insertCard(client, id, name);
    await insertCubeCard(client, 1, id, 1);
  }
  await insertDraft(client, DRAFT, { phase: opts.phase ?? 'drafting', numSeats: 3, cubeSnapshotId: 1 });
  await client.execute({
    sql: `UPDATE drafts SET picks_per_player = 3, double_pick_after_round = 3, in_app = 1 WHERE draft_id = ?`,
    args: [DRAFT],
  });
  await insertPickEvent(client, DRAFT, 1, 1, 1);

  await insertSeatToken(client, DRAFT, 1, { autoPick: true, queueJson: '[]' });
  await insertSeatToken(client, DRAFT, 2, {
    autoPick: opts.seat2AutoPick ?? true,
    queueJson: opts.seat2Queue ?? queueOf([[21, 'S2 First']]),
  });
  await insertSeatToken(client, DRAFT, 3, { autoPick: true, queueJson: queueOf([[31, 'S3 First']]) });
  return client;
}

describe('resumeAutoPickForCurrentSeat', () => {
  it('picks for the seat on the clock and cascades onward', async () => {
    const client = await seed();
    const result = await resumeAutoPickForCurrentSeat(client, DRAFT);

    expect(result.picks[0].seat).toBe(2);
    expect(result.picks[0].pickN).toBe(2);
    expect(result.picks[0].cardName).toBe('S2 First');
    expect(result.picks.length).toBeGreaterThan(1);
  });

  it('does nothing when the draft is not in drafting phase', async () => {
    const client = await seed({ phase: 'setup' });
    const result = await resumeAutoPickForCurrentSeat(client, DRAFT);
    expect(result.picks).toEqual([]);
  });

  it('does nothing when the seat on the clock has auto-pick off', async () => {
    const client = await seed({ seat2AutoPick: false });
    const result = await resumeAutoPickForCurrentSeat(client, DRAFT);
    expect(result.picks).toEqual([]);
  });

  it('does nothing when the seat on the clock has an empty queue', async () => {
    const client = await seed({ seat2Queue: '[]' });
    const result = await resumeAutoPickForCurrentSeat(client, DRAFT);
    expect(result.picks).toEqual([]);
  });

  it('is safe to call twice — the second call finds nothing left to do', async () => {
    const client = await seed();
    await resumeAutoPickForCurrentSeat(client, DRAFT);
    const second = await resumeAutoPickForCurrentSeat(client, DRAFT);
    expect(second.picks).toEqual([]);
  });
});
