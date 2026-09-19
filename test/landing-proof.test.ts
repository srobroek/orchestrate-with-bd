import { describe, expect, test } from "bun:test";
import { missingLandingProof } from "../src/tools/ledger";

describe("delivered landing proof", () => {
  test("requires PR URL, merge anchor, and reviewed head", () => {
    expect(missingLandingProof({ id: "x", metadata: { delivered: true } })).toEqual(["pr", "merge_sha", "head_sha"]);
    expect(missingLandingProof({ id: "x", metadata: { delivered: true, pr: "https://github.com/o/r/pull/1", merge_sha: "abc" } })).toEqual(["head_sha"]);
  });

  test("does not constrain ordinary beads", () => {
    expect(missingLandingProof({ id: "x", metadata: { role: "implementer" } })).toEqual([]);
  });
});
