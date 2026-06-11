// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { isLocalClient } from "./isLocal";

describe("isLocalClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true for localhost", () => {
    Object.defineProperty(window, "location", {
      value: new URL("http://localhost:3000/"),
      writable: true,
      configurable: true,
    });
    expect(isLocalClient()).toBe(true);
  });

  it("returns true for 127.0.0.1", () => {
    Object.defineProperty(window, "location", {
      value: new URL("http://127.0.0.1:3000/"),
      writable: true,
      configurable: true,
    });
    expect(isLocalClient()).toBe(true);
  });

  it("returns false for a lookalike domain (localhost.evil.com is NOT local)", () => {
    Object.defineProperty(window, "location", {
      value: new URL("http://localhost.evil.com/"),
      writable: true,
      configurable: true,
    });
    expect(isLocalClient()).toBe(false);
  });

  it("returns false for a production domain", () => {
    Object.defineProperty(window, "location", {
      value: new URL("https://read-the-bones.vercel.app/"),
      writable: true,
      configurable: true,
    });
    expect(isLocalClient()).toBe(false);
  });
});
