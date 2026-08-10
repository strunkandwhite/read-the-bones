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

describe('cascade parity between manual and on-demand auto-pick', () => {
  it('a manual pick cascades into the following auto-pick seats', async () => {
    const client = await seed();
    const result = await processPick(client, {
      draftId: DRAFT, seat: 1, cardId: 1, cardName: 'Manual Card',
    });
    expect(result.picks.length).toBeGreaterThan(1);
    expect(await pickCount(client)).toBe(result.picks.length);
  });

  it('an on-demand auto-pick cascades into the following auto-pick seats', async () => {
    const client = await seed();
    const result = await triggerAutoPickOnDemand(client, DRAFT, 1);
    expect(result.pickedCard).not.toBeNull();
    expect(result.picks.length).toBeGreaterThan(1);
    expect(await pickCount(client)).toBe(result.picks.length);
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
