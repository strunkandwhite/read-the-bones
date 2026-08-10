import { describe, it, expect } from 'vitest';
import type { Client } from '@libsql/client';
import { processPick, triggerAutoPickOnDemand, resumeAutoPickForCurrentSeat } from './processPick';
import { batchInsertPicks } from './db/sync/batch';
import {
  createMemDb, insertCard, insertCubeSnapshot, insertCubeCard, insertDraft, insertSeatToken,
} from './db/__tests__/testDb';

const DRAFT = 'd1';

function queueOf(entries: Array<[number, string]>): string {
  return JSON.stringify(
    entries.map(([id, name]) => ({ mode: 'pause', cards: [{ id, name }] })),
  );
}

async function seed(): Promise<Client> {
  const client = await createMemDb();
  await insertCubeSnapshot(client, 1);
  const cards: Array<[number, string]> = [
    [1, 'Manual Card'], [11, 'S1 First'], [21, 'S2 First'], [31, 'S3 First'],
  ];
  for (const [id, name] of cards) {
    await insertCard(client, id, name);
    await insertCubeCard(client, 1, id, 1);
  }
  await insertDraft(client, DRAFT, { phase: 'drafting', numSeats: 3, cubeSnapshotId: 1 });
  await client.execute({
    sql: `UPDATE drafts SET picks_per_player = 3, double_pick_after_round = 3, in_app = 1 WHERE draft_id = ?`,
    args: [DRAFT],
  });
  await insertSeatToken(client, DRAFT, 1, { autoPick: true, queueJson: queueOf([[11, 'S1 First']]) });
  await insertSeatToken(client, DRAFT, 2, { autoPick: true, queueJson: queueOf([[21, 'S2 First']]) });
  await insertSeatToken(client, DRAFT, 3, { autoPick: true, queueJson: queueOf([[31, 'S3 First']]) });
  return client;
}

async function sources(client: Client): Promise<Array<{ pick_n: number; source: string | null }>> {
  const r = await client.execute({
    sql: `SELECT pick_n, source FROM pick_events WHERE draft_id = ? ORDER BY pick_n`,
    args: [DRAFT],
  });
  return r.rows.map((row) => ({ pick_n: row.pick_n as number, source: row.source as string | null }));
}

describe('pick provenance', () => {
  it('records a manual pick as manual and its cascade as cascade', async () => {
    const client = await seed();
    await processPick(client, { draftId: DRAFT, seat: 1, cardId: 1, cardName: 'Manual Card' });
    const rows = await sources(client);
    // Seat 1's manual pick, then seats 2 and 3 cascade off their queues; seat 3's
    // second turn (round 2) finds an empty queue and the chain halts there.
    expect(rows.length).toBe(3);
    expect(rows[0].source).toBe('manual');
    expect(rows.slice(1).every((r) => r.source === 'cascade')).toBe(true);
  });

  it('records an on-demand auto-pick as ondemand and its cascade as cascade', async () => {
    const client = await seed();
    await triggerAutoPickOnDemand(client, DRAFT, 1);
    const rows = await sources(client);
    expect(rows.length).toBe(3);
    expect(rows[0].source).toBe('ondemand');
    expect(rows.slice(1).every((r) => r.source === 'cascade')).toBe(true);
  });

  it('records a phase resume as resume', async () => {
    const client = await seed();
    await resumeAutoPickForCurrentSeat(client, DRAFT);
    const rows = await sources(client);
    expect(rows.length).toBe(3);
    expect(rows[0].source).toBe('resume');
    expect(rows.slice(1).every((r) => r.source === 'cascade')).toBe(true);
    expect(rows.map((r) => r.source)).toEqual(['resume', 'cascade', 'cascade']);
  });

  it('stamps created_at on every pick it writes', async () => {
    const client = await seed();
    await processPick(client, { draftId: DRAFT, seat: 1, cardId: 1, cardName: 'Manual Card' });
    const r = await client.execute({
      sql: `SELECT COUNT(*) AS c FROM pick_events WHERE draft_id = ? AND created_at IS NULL`,
      args: [DRAFT],
    });
    expect(r.rows[0].c as number).toBe(0);
  });
});

describe('sheet-sourced picks', () => {
  it('batchInsertPicks stamps source=sheet and a non-null created_at', async () => {
    const client = await createMemDb();
    await batchInsertPicks(client, [
      { draftId: DRAFT, pickN: 1, seat: 1, cardId: 1 },
    ]);
    const r = await client.execute({
      sql: `SELECT source, created_at FROM pick_events WHERE draft_id = ? AND pick_n = ?`,
      args: [DRAFT, 1],
    });
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].source).toBe('sheet');
    expect(r.rows[0].created_at).not.toBeNull();
  });
});
