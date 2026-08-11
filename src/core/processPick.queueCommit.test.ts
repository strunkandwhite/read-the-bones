import { describe, it, expect, vi } from 'vitest';
import type { Client } from '@libsql/client';

// Stagger candidate selection so each call lands after the previous winner's
// insert. This is the shape of several browser tabs plus the server cascade all
// firing on the same seat's turn.
vi.mock('./db/queries/pickQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./db/queries/pickQueue')>();
  let calls = 0;
  return {
    ...actual,
    getAutoPickCandidate: async (...args: Parameters<typeof actual.getAutoPickCandidate>) => {
      const n = calls++;
      // Modulo bounds the total delay across the whole file: `calls` is
      // module-scoped and never resets between tests, so an unbounded `25 * n`
      // grows past the default 5s timeout by the file's later describe blocks.
      // `% 4` preserves the within-test stagger (each concurrent batch still
      // sees increasing 0/25/50/75ms delays relative to its own calls).
      const staggerIndex = n % 4;
      if (staggerIndex > 0) await new Promise((r) => setTimeout(r, 25 * staggerIndex));
      return actual.getAutoPickCandidate(...args);
    },
  };
});

const { processPick, triggerAutoPickOnDemand } = await import('./processPick');
const { getQueue } = await import('./db/queries/pickQueue');
const { getFloatedCards } = await import('./db/queries/floatedCards');
const {
  createMemDb, insertCard, insertCubeSnapshot, insertCubeCard, insertDraft, insertSeatToken,
} = await import('./db/__tests__/testDb');

const DRAFT = 'd1';
const QUEUE_NAMES = ['Q0', 'Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7'];

function singleEntries(names: string[]) {
  return names.map((name) => ({
    mode: 'pause',
    cards: [{ id: 100 + QUEUE_NAMES.indexOf(name), name }],
  }));
}

/** Seat 1 auto-picks from an 8-card queue; seats 2 and 3 sit out. */
async function seedOneAutoPicker(): Promise<Client> {
  const client = await createMemDb();
  await insertCubeSnapshot(client, 1);
  for (let n = 0; n < QUEUE_NAMES.length; n++) {
    await insertCard(client, 100 + n, QUEUE_NAMES[n]);
    await insertCubeCard(client, 1, 100 + n, 1);
  }
  await insertDraft(client, DRAFT, { phase: 'drafting', numSeats: 3, cubeSnapshotId: 1 });
  await client.execute({
    sql: `UPDATE drafts SET picks_per_player = 8, double_pick_after_round = 8, in_app = 1 WHERE draft_id = ?`,
    args: [DRAFT],
  });
  await insertSeatToken(client, DRAFT, 1, {
    autoPick: true, queueJson: JSON.stringify(singleEntries(QUEUE_NAMES)),
  });
  await insertSeatToken(client, DRAFT, 2, { autoPick: false, queueJson: '[]' });
  await insertSeatToken(client, DRAFT, 3, { autoPick: false, queueJson: '[]' });
  return client;
}

async function pickedNames(client: Client): Promise<Set<string>> {
  const r = await client.execute({
    sql: `SELECT c.name FROM pick_events pe JOIN cards c ON c.card_id = pe.card_id
          WHERE pe.draft_id = ?`,
    args: [DRAFT],
  });
  return new Set(r.rows.map((row) => row.name as string));
}

async function queuedNames(client: Client, seat: number): Promise<string[]> {
  const q = await getQueue(client, DRAFT, seat);
  return q.flatMap((e) => e.cards.map((c) => c.name));
}

describe('a selection that never becomes a pick leaves the queue alone', () => {
  it('losing triggers do not consume queue entries', async () => {
    const client = await seedOneAutoPicker();

    await Promise.allSettled([
      triggerAutoPickOnDemand(client, DRAFT, 1),
      triggerAutoPickOnDemand(client, DRAFT, 1),
      triggerAutoPickOnDemand(client, DRAFT, 1),
      triggerAutoPickOnDemand(client, DRAFT, 1),
    ]);

    const picked = await pickedNames(client);
    const queued = await queuedNames(client, 1);
    const vanished = QUEUE_NAMES.filter((n) => !queued.includes(n) && !picked.has(n));

    expect(picked.size).toBe(1);
    expect(vanished).toEqual([]);
    expect(queued.length).toBe(QUEUE_NAMES.length - 1);
  });

  it('exactly one trigger wins and it takes the top of the queue', async () => {
    const client = await seedOneAutoPicker();

    const results = await Promise.allSettled([
      triggerAutoPickOnDemand(client, DRAFT, 1),
      triggerAutoPickOnDemand(client, DRAFT, 1),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect(await pickedNames(client)).toEqual(new Set(['Q0']));
    expect((await queuedNames(client, 1))[0]).toBe('Q1');
  });
});

describe('a cascade stopping at its depth cap leaves the queue alone', () => {
  it('does not consume the entry it was about to pick', async () => {
    const client = await createMemDb();
    await insertCubeSnapshot(client, 1);

    const cards: Array<[number, string]> = [[1, 'Manual']];
    for (let seat = 1; seat <= 3; seat++) {
      for (let n = 0; n < 6; n++) cards.push([seat * 100 + n, `S${seat}-${n}`]);
    }
    for (const [id, name] of cards) {
      await insertCard(client, id, name);
      await insertCubeCard(client, 1, id, 1);
    }
    await insertDraft(client, DRAFT, { phase: 'drafting', numSeats: 3, cubeSnapshotId: 1 });
    await client.execute({
      sql: `UPDATE drafts SET picks_per_player = 6, double_pick_after_round = 6, in_app = 1 WHERE draft_id = ?`,
      args: [DRAFT],
    });
    for (let seat = 1; seat <= 3; seat++) {
      const entries = [];
      for (let n = 0; n < 6; n++) {
        entries.push({ mode: 'pause', cards: [{ id: seat * 100 + n, name: `S${seat}-${n}` }] });
      }
      await insertSeatToken(client, DRAFT, seat, { autoPick: true, queueJson: JSON.stringify(entries) });
    }

    const before = new Map<number, string[]>();
    for (let s = 1; s <= 3; s++) before.set(s, await queuedNames(client, s));

    // maxCascade is numSeats * 2 = 6, so this run is truncated mid-chain.
    const res = await processPick(client, { draftId: DRAFT, seat: 1, cardId: 1, cardName: 'Manual' });
    expect(res.picks).toHaveLength(6);

    const picked = await pickedNames(client);
    const vanished: string[] = [];
    for (let s = 1; s <= 3; s++) {
      const after = await queuedNames(client, s);
      for (const name of before.get(s)!) {
        if (!after.includes(name) && !picked.has(name)) vanished.push(`seat ${s}: ${name}`);
      }
    }
    expect(vanished).toEqual([]);
  });
});

describe('a pick that does land still fulfills its group', () => {
  it('removes the whole group entry and floats the cards that lost out', async () => {
    const client = await createMemDb();
    await insertCubeSnapshot(client, 1);
    const cards: Array<[number, string]> = [
      [1, 'Manual'], [10, 'Group A'], [11, 'Group B'], [12, 'Group C'],
    ];
    for (const [id, name] of cards) {
      await insertCard(client, id, name);
      await insertCubeCard(client, 1, id, 1);
    }
    await insertDraft(client, DRAFT, { phase: 'drafting', numSeats: 2, cubeSnapshotId: 1 });
    await client.execute({
      sql: `UPDATE drafts SET picks_per_player = 3, double_pick_after_round = 3, in_app = 1 WHERE draft_id = ?`,
      args: [DRAFT],
    });
    await insertSeatToken(client, DRAFT, 1, { autoPick: false, queueJson: '[]' });
    await insertSeatToken(client, DRAFT, 2, {
      autoPick: true,
      queueJson: JSON.stringify([
        { mode: 'pause', cards: [{ id: 10, name: 'Group A' }, { id: 11, name: 'Group B' }, { id: 12, name: 'Group C' }] },
      ]),
    });

    const res = await processPick(client, { draftId: DRAFT, seat: 1, cardId: 1, cardName: 'Manual' });
    const seat2Pick = res.picks.find((p) => p.seat === 2);
    expect(seat2Pick?.cardName).toBe('Group A');

    expect(await queuedNames(client, 2)).toEqual([]);
    expect((await getFloatedCards(client, DRAFT, 2)).sort()).toEqual(['Group B', 'Group C']);
  });
});
