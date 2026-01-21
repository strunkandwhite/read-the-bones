/**
 * Tests for the explore prompt builder.
 */

import { describe, it, expect } from "vitest";
import { buildExploreSystemPrompt } from "./explorePrompt";

describe("buildExploreSystemPrompt", () => {
  it("returns a non-empty string", () => {
    const prompt = buildExploreSystemPrompt();
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("mentions MTG draft analyst role", () => {
    const prompt = buildExploreSystemPrompt();
    expect(prompt).toContain("MTG rotisserie draft analyst");
  });

  it("includes tool use requirements", () => {
    const prompt = buildExploreSystemPrompt();
    expect(prompt).toContain("Tool Use Requirements");
    expect(prompt).toContain("Make factual claims only if supported by tool output");
  });
});
