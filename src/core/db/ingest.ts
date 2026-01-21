export {
  parseIngestArgs,
  incrementalPicks,
  incrementalMatches,
  incrementalDecklists,
  main,
} from "./ingest/index";

import { main } from "./ingest/index";

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("/ingest.ts") ||
    process.argv[1].endsWith("/ingest.js"));

if (isDirectRun) {
  main().catch((error) => {
    console.error("[ingest] Fatal error:", error);
    process.exit(1);
  });
}
