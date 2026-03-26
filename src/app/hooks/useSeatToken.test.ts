// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useSeatToken } from "./useSeatToken";

describe("useSeatToken", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, "", "http://localhost:3000/");
  });

  it("returns null when no draftId", () => {
    const { result } = renderHook(() => useSeatToken(null));
    expect(result.current.token).toBeNull();
    expect(result.current.hasSeatToken).toBe(false);
  });

  it("extracts token from URL and stores in localStorage", () => {
    window.history.replaceState({}, "", "http://localhost:3000/?token=abc123");
    const { result } = renderHook(() => useSeatToken("my-draft"));
    expect(result.current.token).toBe("abc123");
    expect(result.current.hasSeatToken).toBe(true);
    expect(localStorage.getItem("seatToken:my-draft")).toBe("abc123");
  });

  it("strips token from URL after extracting", () => {
    window.history.replaceState({}, "", "http://localhost:3000/?token=abc123");
    renderHook(() => useSeatToken("my-draft"));
    expect(window.location.search).not.toContain("token=");
  });

  it("reads token from localStorage when not in URL", () => {
    localStorage.setItem("seatToken:my-draft", "stored-token");
    const { result } = renderHook(() => useSeatToken("my-draft"));
    expect(result.current.token).toBe("stored-token");
    expect(result.current.hasSeatToken).toBe(true);
  });

  it("returns null when draftId present but no token anywhere", () => {
    const { result } = renderHook(() => useSeatToken("my-draft"));
    expect(result.current.token).toBeNull();
    expect(result.current.hasSeatToken).toBe(false);
  });

  it("uses different localStorage keys per draftId", () => {
    localStorage.setItem("seatToken:draft-a", "token-a");
    localStorage.setItem("seatToken:draft-b", "token-b");

    const { result: resultA } = renderHook(() => useSeatToken("draft-a"));
    const { result: resultB } = renderHook(() => useSeatToken("draft-b"));

    expect(resultA.current.token).toBe("token-a");
    expect(resultB.current.token).toBe("token-b");
  });
});
