import { describe, it, expect } from 'vitest';
import type { Client } from '@libsql/client';
import { processPick, triggerAutoPickOnDemand } from './processPick';
import {
  createMemDb, insertCard, insertCubeSnapshot, insertCubeCard, insertDraft, insertSeatToken,
} from './db/__tests__/testDb';

const DRAFT = 'd1';

const CARDS: Array<[number, string]> = [
  [1, 'Manual Card'],
  [11, 'S1 First'], [12, 'S1 Second'],
  [21, 'S2 First'], [22, 'S2 Second'],
  [31, 'S3 First'], [32, 'S3 Second'],
];

function queueOf(entries: Array<[number, string]>): string {
  return JSON.stringify(
    entries.map(([id, name]) => ({ mode: 'pause', cards: [{ id, name }] })),
  );
}

/** 3 seats, 3 picks each, all single-pick rounds. Every seat auto-picks with a queue. */
async function seed(): Promise<Client> {
  const client = await createMemDb();
  await insertCubeSnapshot(client, 1);
  for (const [id, name] of CARDS) {
    await insertCard(client, id, name);
    await insertCubeCard(client, 1, id, 1);
  }
  await insertDraft(client, DRAFT, { phase: 'drafting', numSeats: 3, cubeSnapshotId: 1 });
  await client.execute({
    sql: `UPDATE drafts SET picks_per_player = 3, double_pick_after_round = 3, in_app = 1 WHERE draft_id = ?`,
    args: [DRAFT],
  });
  await insertSeatToken(client, DRAFT, 1, { autoPick: true, queueJson: queueOf([[11, 'S1 First'], [12, 'S1 Second']]) });
  await insertSeatToken(client, DRAFT, 2, { autoPick: true, queueJson: queueOf([[21, 'S2 First'], [22, 'S2 Second']]) });
  await insertSeatToken(client, DRAFT, 3, { autoPick: true, queueJson: queueOf([[31, 'S3 First'], [32, 'S3 Second']]) });
  return client;
}

async function pickCount(client: Client): Promise<number> {
  const r = await client.execute({
    sql: `SELECT COUNT(*) AS c FROM pick_events WHERE draft_id = ?`,
    args: [DRAFT],
  });
  return r.rows[0].c as number;
}

/**
 * Seat 3 has no queued cards at all, so — unlike `seed()` above, whose every
 * seat has two queue entries and cascades all the way to the maxCascade bound
 * — the chain here halts naturally on "no candidate" for seat 3, well short
 * of the bound. This is the regime real drafts spend nearly all their time
 * in: a seat simply has nothing queued, not a runaway chain.
 */
async function seedNaturalHalt(): Promise<Client> {
  const client = await createMemDb();
  await insertCubeSnapshot(client, 1);
  for (const [id, name] of CARDS) {
    await insertCard(client, id, name);
    await insertCubeCard(client, 1, id, 1);
  }
  await insertDraft(client, DRAFT, { phase: 'drafting', numSeats: 3, cubeSnapshotId: 1 });
  await client.execute({
    sql: `UPDATE drafts SET picks_per_player = 3, double_pick_after_round = 3, in_app = 1 WHERE draft_id = ?`,
    args: [DRAFT],
  });
  await insertSeatToken(client, DRAFT, 1, { autoPick: true, queueJson: queueOf([[11, 'S1 First'], [12, 'S1 Second']]) });
  await insertSeatToken(client, DRAFT, 2, { autoPick: true, queueJson: queueOf([[21, 'S2 First'], [22, 'S2 Second']]) });
  await insertSeatToken(client, DRAFT, 3, { autoPick: true, queueJson: null });
  return client;
}

describe('cascade parity between manual and on-demand auto-pick', () => {
  it('a manual pick cascades into the following auto-pick seats', async () => {
    const client = await seed();
    const result = await processPick(client, {
      draftId: DRAFT, seat: 1, cardId: 1, cardName: 'Manual Card',
    });
    // This seed's queues keep every seat auto-picking until the cascade is
    // truncated by maxCascade (numSeats * 2 = 6) — the bounded regime, not a
    // natural stop. See `seedNaturalHalt` below for the untruncated regime.
    expect(result.picks.length).toBe(6);
    expect(await pickCount(client)).toBe(result.picks.length);
  });

  it('an on-demand auto-pick cascades into the following auto-pick seats', async () => {
    const client = await seed();
    const result = await triggerAutoPickOnDemand(client, DRAFT, 1);
    expect(result.pickedCard).not.toBeNull();
    // Same maxCascade-truncated regime as the manual-pick test above.
    expect(result.picks.length).toBe(6);
    expect(await pickCount(client)).toBe(result.picks.length);
  });

  it('halts naturally on an empty queue well before the maxCascade bound', async () => {
    const client = await seedNaturalHalt();
    const result = await processPick(client, {
      draftId: DRAFT, seat: 1, cardId: 1, cardName: 'Manual Card',
    });
    // Seat 2 cascades once (its queue has a candidate), then seat 3's empty
    // queue stops the chain on "no candidate" — 2 picks total, nowhere near
    // the maxCascade bound of 6 exercised by the tests above.
    expect(result.picks.length).toBe(2);
    expect(await pickCount(client)).toBe(2);
  });

  it('both entry points advance the draft by the same number of picks', async () => {
    const manualClient = await seed();
    await processPick(manualClient, { draftId: DRAFT, seat: 1, cardId: 11, cardName: 'S1 First' });

    const autoClient = await seed();
    await triggerAutoPickOnDemand(autoClient, DRAFT, 1);

    expect(await pickCount(autoClient)).toBe(await pickCount(manualClient));
  });

  it('the on-demand result reports the seat that triggered it as its first pick', async () => {
    const client = await seed();
    const result = await triggerAutoPickOnDemand(client, DRAFT, 1);
    expect(result.picks[0].seat).toBe(1);
    expect(result.picks[0].pickN).toBe(1);
    expect(result.pickedCard?.cardName).toBe(result.picks[0].cardName);
  });
});
