/**
 * Flag validation shared by the scripts that write or delete stored data.
 *
 * They all treat "no flags given" as "do the real thing", so a typo like
 * `--dryrun` silently becomes a destructive pass against the one production
 * database. Rejecting unknown `--` arguments is what keeps a mistyped
 * rehearsal from being indistinguishable from an authorized run.
 */
export function assertRecognizedFlags(args: string[], recognized: Set<string>): void {
  for (const arg of args) {
    if (arg.startsWith("--") && !recognized.has(arg)) {
      throw new Error(`Unrecognized flag: ${arg}`);
    }
  }
}
