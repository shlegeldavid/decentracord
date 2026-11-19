import { describe, expect, it } from "vitest";
import { findMentionCandidates, resolveMentions } from "../../apps/server/src/messages/mention-tokens.js";

describe("message mention resolution", () => {
  it("finds unique candidates in lowercase and keeps their first appearance order", () => {
    expect(findMentionCandidates("@Ivan.petrov, @IVAN! @IVAN")).toEqual(["ivan.petrov", "ivan"]);
  });

  it("resolves the longest complete login and preserves text order", () => {
    expect(resolveMentions("@ivan.petrov then @anna then @ivan", ["ivan", "ivan.petrov", "anna"]))
      .toEqual(["ivan.petrov", "anna", "ivan"]);
  });

  it("discards unknown logins", () => {
    expect(resolveMentions("hello @nobody", ["ivan"])).toEqual([]);
  });

  it("does not resolve a shorter partial login", () => {
    expect(resolveMentions("@ivan.petrov", ["ivan"])).toEqual([]);
  });

  it("deduplicates repeated known mentions", () => {
    expect(resolveMentions("@ivan @anna @ivan", ["ivan", "anna"])).toEqual(["ivan", "anna"]);
  });

  it("rejects tokens embedded in words and outside login length bounds", () => {
    const tooLong = "a".repeat(65);
    expect(findMentionCandidates(`snake_case_name@ivan x@anna é@petrov @ab @${tooLong}`)).toEqual([]);
  });
});
