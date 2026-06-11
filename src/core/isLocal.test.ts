import { describe, it, expect } from "vitest";
import { isLocalClient } from "./isLocal";

describe("isLocalClient", () => {
  it("returns false in non-browser environment", () => {
    expect(isLocalClient()).toBe(false);
  });
});
