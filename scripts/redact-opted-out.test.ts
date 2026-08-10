import { describe, it, expect } from "vitest";
import { parseRedactArgs } from "./redact-opted-out";

describe("parseRedactArgs", () => {
  it("recognizes --dry-run", () => {
    expect(parseRedactArgs(["--dry-run"])).toEqual({ dryRun: true });
  });

  it("defaults to a live run with no flags", () => {
    expect(parseRedactArgs([])).toEqual({ dryRun: false });
  });

  // A mistyped rehearsal flag must not be indistinguishable from an
  // authorized destructive run against the production database.
  it("rejects a misspelled dry-run flag instead of deleting", () => {
    expect(() => parseRedactArgs(["--dryrun"])).toThrow(/Unrecognized flag: --dryrun/);
    expect(() => parseRedactArgs(["--dry_run"])).toThrow(/Unrecognized flag/);
  });
});
