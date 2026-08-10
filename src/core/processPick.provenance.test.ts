import { describe, it, expect } from 'vitest';
import type { Client } from '@libsql/client';
import { processPick, triggerAutoPickOnDemand, resumeAutoPickForCurrentSeat } from './processPick';
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
    expect(rows[0].source).toBe('manual');
    expect(rows.slice(1).every((r) => r.source === 'cascade')).toBe(true);
  });

  it('records an on-demand auto-pick as ondemand and its cascade as cascade', async () => {
    const client = await seed();
    await triggerAutoPickOnDemand(client, DRAFT, 1);
    const rows = await sources(client);
    expect(rows[0].source).toBe('ondemand');
    expect(rows.slice(1).every((r) => r.source === 'cascade')).toBe(true);
  });

  it('records a phase resume as resume', async () => {
    const client = await seed();
    await resumeAutoPickForCurrentSeat(client, DRAFT);
    const rows = await sources(client);
    expect(rows[0].source).toBe('resume');
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
