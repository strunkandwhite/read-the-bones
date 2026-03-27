import { describe, it, expect } from "vitest";
import { isLocalHost, isLocalClient } from "./isLocal";

describe("isLocalHost", () => {
  it("returns true for localhost", () => {
    expect(isLocalHost("localhost:3000")).toBe(true);
  });
  it("returns true for 127.0.0.1", () => {
    expect(isLocalHost("127.0.0.1:3000")).toBe(true);
  });
  it("returns false for production host", () => {
    expect(isLocalHost("readthebones.vercel.app")).toBe(false);
  });
  it("returns false for empty string", () => {
    expect(isLocalHost("")).toBe(false);
  });
});

describe("isLocalClient", () => {
  it("returns false in non-browser environment", () => {
    expect(isLocalClient()).toBe(false);
  });
});
