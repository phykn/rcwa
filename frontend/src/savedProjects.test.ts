import { afterEach, describe, expect, it, vi } from "vitest";
import { api, savedSnapshotId, validateSavedProjectIndex } from "./api";

function index(count: number) {
  return {
    view: "index",
    snapshots: Array.from({ length: count }, (_, i) => ({
      id: `saved-${i}`,
      name: "Duplicate, untrusted name <script>",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    })),
    limit: 100,
    may_have_more: count === 100,
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("bounded saved-project discovery", () => {
  it.each([0, 1, 99, 100])(
    "retains exact %i-record index and its uncertainty",
    (count) => {
      const value = index(count);
      expect(validateSavedProjectIndex(value)).toBe(value);
      expect(value.may_have_more).toBe(count === 100);
    },
  );
  it.each([
    null,
    [],
    index(101),
    { ...index(99), may_have_more: true },
    { ...index(100), may_have_more: false },
    { ...index(1), may_have_more: "false" },
    { ...index(1), limit: 99 },
    { ...index(1), view: "full" },
    { ...index(1), snapshots: [{ id: "../other", name: "Bad ID" }] },
    { ...index(1), snapshots: [{ id: "ok", name: null }] },
    { ...index(2), snapshots: [index(1).snapshots[0], index(1).snapshots[0]] },
  ])(
    "rejects an invalid index rather than silently treating it as complete",
    (value) => {
      expect(() => validateSavedProjectIndex(value)).toThrow(
        /index is invalid/,
      );
    },
  );
  it("requests the real opt-in index contract using read-only HTTP", async () => {
    vi.stubGlobal("window", globalThis);
    const value = index(100);
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(value)));
    vi.stubGlobal("fetch", fetch);
    expect(await api.list()).toEqual(value);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("/api/projects?view=index");
    expect(fetch.mock.calls[0][1].method).toBeUndefined();
    expect(fetch.mock.calls[0][1].body).toBeUndefined();
  });
});

describe("exact known snapshot IDs", () => {
  it("allows the existing identifier contract and surrounding clipboard whitespace", () => {
    expect(savedSnapshotId("  saved-a_123\n")).toBe("saved-a_123");
    expect(savedSnapshotId("a".repeat(100))).toHaveLength(100);
  });
  it.each([
    "",
    " \n ",
    "../other",
    "id?view=inputs",
    "https://host/id",
    "a b",
    "a".repeat(101),
  ])("rejects invalid ID %s before loading", (value) =>
    expect(() => savedSnapshotId(value)).toThrow(/Enter a snapshot ID/),
  );
});
