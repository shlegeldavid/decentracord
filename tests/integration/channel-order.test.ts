import { describe, expect, it } from "vitest";
import type { Channel } from "../../apps/web/src/api.js";
import type { ReorderDropTarget } from "../../apps/web/src/components/useDragReorder.js";
import { reorderChannel, swapCategories } from "../../apps/web/src/lib/channelOrder.js";

const categories = ["first", "second", "empty"].map((id, index) => ({ id, name: id, position: index + 1 }));

function channel(id: string, categoryId: string | null): Channel {
  return {
    id,
    name: id,
    categoryId,
    description: null,
    visibility: "known",
    canView: true,
    canSend: true,
    canManageMessages: false,
    ownerEditable: false
  };
}

const channels = [
  channel("without-category", null),
  channel("source", "first"),
  channel("middle", "first"),
  channel("last", "first"),
  channel("anchor", "second")
];

describe("category order", () => {
  it.each([
    { destination: 1, expected: ["second", "first", "empty"] },
    { destination: 2, expected: ["empty", "second", "first"] }
  ])("swaps categories at positions 0 and $destination", ({ destination, expected }) => {
    expect(swapCategories(categories, 0, destination)?.map(({ id }) => id)).toEqual(expected);
    expect(categories.map(({ id }) => id)).toEqual(["first", "second", "empty"]);
  });

  it.each([[-1, 1], [0, -1], [0, 0], [0, 3]])("ignores invalid swap %s to %s", (source, destination) => {
    expect(swapCategories(categories, source, destination)).toBeNull();
  });
});

describe("channel order", () => {
  const cases: Array<{ name: string; target: ReorderDropTarget; order: string[][] }> = [
    {
      name: "before the channel after removing the source",
      target: { type: "channel", categoryId: "first", channelId: "last", position: "before" },
      order: [["without-category"], ["middle", "source", "last"], ["anchor"], []]
    },
    {
      name: "after a channel in the same category",
      target: { type: "channel", categoryId: "first", channelId: "last", position: "after" },
      order: [["without-category"], ["middle", "last", "source"], ["anchor"], []]
    },
    {
      name: "into an empty category",
      target: { type: "category", categoryId: "empty" },
      order: [["without-category"], ["middle", "last"], ["anchor"], ["source"]]
    },
    {
      name: "into the uncategorized group",
      target: { type: "category", categoryId: null },
      order: [["without-category", "source"], ["middle", "last"], ["anchor"], []]
    }
  ];

  it.each(cases)("moves a channel $name", ({ target, order }) => {
    const previous = structuredClone(channels);
    const groupIds = [null, "first", "second", "empty"];
    const result = reorderChannel(channels, categories, "source", target);

    expect(result?.groups).toEqual(groupIds.map((categoryId, index) => ({ categoryId, channelIds: order[index] })));
    expect(result?.channels.map(({ id, categoryId }) => [id, categoryId])).toEqual(
      order.flatMap((ids, index) => ids.map((id) => [id, groupIds[index]]))
    );
    expect(channels).toEqual(previous);
  });

  it.each<{ id: string; target: ReorderDropTarget }>([
    { id: "missing", target: { type: "category", categoryId: null } },
    { id: "source", target: { type: "category", categoryId: "missing" } },
    { id: "source", target: { type: "channel", categoryId: "first", channelId: "missing", position: "before" } },
    { id: "source", target: { type: "channel", categoryId: "first", channelId: "source", position: "before" } }
  ])("ignores an invalid move of $id to $target", ({ id, target }) => {
    expect(reorderChannel(channels, categories, id, target)).toBeNull();
  });
});
