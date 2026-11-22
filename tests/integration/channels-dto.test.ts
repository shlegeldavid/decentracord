import { describe, expect, it } from "vitest";
import {
  parseCategoryNameBody,
  parseChannelOverridesBody,
  parseCreateChannelBody,
  parseReorderCategoriesBody,
  parseReorderChannelsBody,
  parseUpdateChannelBody
} from "../../apps/server/src/channels/channels.dto.js";

const categoryId = "12345678-1234-4234-8234-123456789012";
const channelId = "12345678-1234-4234-8234-123456789013";
const name = "📝".repeat(80);
const description = "📘".repeat(1024);

describe("channel management bodies", () => {
  it("uses the same trimmed Unicode names for channels and categories", () => {
    expect(parseCategoryNameBody({ name: ` ${name} ` })).toEqual({ name });
    expect(parseCreateChannelBody({ name: ` ${name} ` })).toEqual({
      name, categoryId: null, description: null, overrides: []
    });
    expect(parseUpdateChannelBody({ name: ` ${name} ` })).toEqual({ name });
  });

  it.each(["", " ", name + "📝", "название\u0000"])("rejects an invalid name", (invalid) => {
    expect(parseCategoryNameBody({ name: invalid })).toBeNull();
    expect(parseCreateChannelBody({ name: invalid })).toBeNull();
    expect(parseUpdateChannelBody({ name: invalid })).toBeNull();
  });

  it("preserves omitted and explicitly cleared channel fields", () => {
    expect(parseUpdateChannelBody({ visibility: "known" })).toEqual({ visibility: "known" });
    expect(parseUpdateChannelBody({ categoryId: null, description: null })).toEqual({ categoryId: null, description: null });
    expect(parseCreateChannelBody({ name, categoryId, description })).toEqual({ name, categoryId, description, overrides: [] });
    expect(parseUpdateChannelBody({ categoryId, description })).toEqual({ categoryId, description });
  });

  it.each([
    { categoryId: "not-a-uuid" }, { categoryId: undefined },
    { description: description + "📘" }, { description: "описание\u0000" }, { description: undefined },
    { extra: true }
  ])("rejects invalid or unknown channel fields", (invalid) => {
    expect(parseCreateChannelBody({ name, ...invalid })).toBeNull();
    expect(parseUpdateChannelBody({ name, ...invalid })).toBeNull();
  });

  it("keeps the expected keys for category names and orders", () => {
    expect(parseCategoryNameBody({ name, extra: true })).toBeNull();
    expect(parseUpdateChannelBody({})).toBeNull();
    expect(parseReorderCategoriesBody({ categoryIds: [categoryId] })).toEqual({ categoryIds: [categoryId] });
    expect(parseReorderCategoriesBody({ categoryIds: [null] })).toBeNull();
    expect(parseReorderCategoriesBody({ categoryIds: [categoryId], extra: true })).toBeNull();
  });

  it("accepts a null category and rejects duplicate groups or channel ids", () => {
    const uncategorized = { categoryId: null, channelIds: [channelId] };
    const category = { categoryId, channelIds: [] };
    expect(parseReorderChannelsBody({ groups: [uncategorized, category] })).toEqual({ groups: [uncategorized, category] });
    expect(parseReorderChannelsBody({ groups: [uncategorized, { ...uncategorized, channelIds: [] }] })).toBeNull();
    expect(parseReorderChannelsBody({ groups: [uncategorized, { ...category, channelIds: [channelId] }] })).toBeNull();
    expect(parseReorderChannelsBody({ groups: [{ ...uncategorized, extra: true }] })).toBeNull();
    expect(parseReorderChannelsBody({ groups: [{ channelIds: [] }] })).toBeNull();
  });

  it("keeps channel creation and override update body rules separate", () => {
    const override = { subject: "everyone", subjectId: null, permission: "VIEW_CHANNEL", effect: "allow" };
    expect(parseCreateChannelBody({ name, overrides: [override] })?.overrides).toEqual([override]);
    expect(parseChannelOverridesBody({ overrides: [override] })).toEqual([override]);
    expect(parseChannelOverridesBody({ name, overrides: [override] })).toBeNull();
    expect(parseCreateChannelBody({ name, overrides: [{ ...override, permission: "ADMINISTRATOR" }] })).toBeNull();
  });
});
