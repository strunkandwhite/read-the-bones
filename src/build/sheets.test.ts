import { describe, it, expect } from "vitest";
import { rowsToCsv, parseSheetIdFromUrl } from "./sheets";

describe("sheets", () => {
  describe("rowsToCsv", () => {
    it("converts simple rows to CSV", () => {
      const rows = [
        ["A", "B", "C"],
        ["1", "2", "3"],
      ];
      expect(rowsToCsv(rows)).toBe("A,B,C\n1,2,3");
    });

    it("handles empty cells", () => {
      const rows = [
        ["A", "", "C"],
        ["", "2", ""],
      ];
      expect(rowsToCsv(rows)).toBe("A,,C\n,2,");
    });

    it("handles null and undefined values", () => {
      const rows = [[null, undefined, "C"]];
      expect(rowsToCsv(rows)).toBe(",,C");
    });

    it("escapes commas in values", () => {
      const rows = [["Hello, World", "B"]];
      expect(rowsToCsv(rows)).toBe('"Hello, World",B');
    });

    it("escapes quotes in values", () => {
      const rows = [['Say "Hello"', "B"]];
      expect(rowsToCsv(rows)).toBe('"Say ""Hello""",B');
    });

    it("escapes newlines in values", () => {
      const rows = [["Line1\nLine2", "B"]];
      expect(rowsToCsv(rows)).toBe('"Line1\nLine2",B');
    });

    it("handles numbers and booleans", () => {
      const rows = [[123, true, false]];
      expect(rowsToCsv(rows)).toBe("123,true,false");
    });
  });

  describe("parseSheetIdFromUrl", () => {
    it("extracts sheet ID from standard URL", () => {
      const url =
        "https://docs.google.com/spreadsheets/d/1KRXt6DfuGHmJG8yYfgCjSNtMJbMKPQDo1UUsdsJGMKY/edit?gid=1758262163#gid=1758262163";
      expect(parseSheetIdFromUrl(url)).toBe("1KRXt6DfuGHmJG8yYfgCjSNtMJbMKPQDo1UUsdsJGMKY");
    });

    it("extracts sheet ID from URL without gid", () => {
      const url =
        "https://docs.google.com/spreadsheets/d/1KRXt6DfuGHmJG8yYfgCjSNtMJbMKPQDo1UUsdsJGMKY/edit";
      expect(parseSheetIdFromUrl(url)).toBe("1KRXt6DfuGHmJG8yYfgCjSNtMJbMKPQDo1UUsdsJGMKY");
    });

    it("handles sheet IDs with hyphens and underscores", () => {
      const url = "https://docs.google.com/spreadsheets/d/1-OOxgvYZ0dgwmIsE0y3KLRHTcnh-5zmmkP6xtVWUqzE/edit";
      expect(parseSheetIdFromUrl(url)).toBe("1-OOxgvYZ0dgwmIsE0y3KLRHTcnh-5zmmkP6xtVWUqzE");
    });

    it("returns null for invalid URLs", () => {
      expect(parseSheetIdFromUrl("https://example.com")).toBeNull();
      expect(parseSheetIdFromUrl("not a url")).toBeNull();
    });

    it("returns null for URLs without /d/ pattern", () => {
      expect(parseSheetIdFromUrl("https://docs.google.com/spreadsheets/")).toBeNull();
    });
  });
});
