import { readdirSync, existsSync } from "fs";
import { join } from "path";

export interface DraftFolder {
  draftId: string;
  path: string;
  hasPicksCsv: boolean;
  hasPoolCsv: boolean;
  hasMatchesCsv: boolean;
  hasDecklistsCsv: boolean;
  hasMetadata: boolean;
}

/**
 * Scan data/ directory for draft folders with required files.
 */
export function discoverDrafts(dataDir: string, filterDraftId?: string): DraftFolder[] {
  const drafts: DraftFolder[] = [];

  if (!existsSync(dataDir)) {
    return drafts;
  }

  const entries = readdirSync(dataDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    // Skip hidden directories
    if (entry.name.startsWith(".")) continue;

    // Skip if filtering and this isn't the target draft
    if (filterDraftId && entry.name !== filterDraftId) continue;

    const draftPath = join(dataDir, entry.name);

    const draft: DraftFolder = {
      draftId: entry.name,
      path: draftPath,
      hasPicksCsv: existsSync(join(draftPath, "picks.csv")),
      hasPoolCsv: existsSync(join(draftPath, "pool.csv")),
      hasMatchesCsv: existsSync(join(draftPath, "matches.csv")),
      hasDecklistsCsv: existsSync(join(draftPath, "decklists.csv")),
      hasMetadata: existsSync(join(draftPath, "metadata.json")),
    };

    // Only include drafts with both picks.csv and pool.csv
    if (draft.hasPicksCsv && draft.hasPoolCsv) {
      drafts.push(draft);
    }
  }

  return drafts.sort((a, b) => a.draftId.localeCompare(b.draftId));
}
