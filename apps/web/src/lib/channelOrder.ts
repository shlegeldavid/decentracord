import type { Channel, ChannelCategory } from "../api.js";
import type { ReorderDropTarget } from "../components/useDragReorder.js";

export function swapCategories(categories: ChannelCategory[], sourceIndex: number, targetIndex: number): ChannelCategory[] | null {
  const source = categories[sourceIndex];
  const target = categories[targetIndex];
  if (!source || !target || sourceIndex === targetIndex) return null;

  const next = [...categories];
  next[sourceIndex] = target;
  next[targetIndex] = source;
  return next;
}

export function reorderChannel(
  channels: Channel[],
  categories: ChannelCategory[],
  channelId: string,
  target: ReorderDropTarget
) {
  const source = channels.find((channel) => channel.id === channelId);
  if (!source) return null;

  const categoryIds = [null, ...categories.map((category) => category.id)];
  const grouped = new Map<string | null, Channel[]>(categoryIds.map((categoryId) => [categoryId, []]));
  for (const channel of channels) grouped.get(channel.categoryId)?.push(channel);

  const sourceGroup = grouped.get(source.categoryId);
  const targetGroup = grouped.get(target.categoryId);
  if (!sourceGroup || !targetGroup) return null;

  sourceGroup.splice(sourceGroup.indexOf(source), 1);
  const movedChannel = { ...source, categoryId: target.categoryId };
  if (target.type === "channel") {
    const targetIndex = targetGroup.findIndex((channel) => channel.id === target.channelId);
    if (targetIndex < 0) return null;
    targetGroup.splice(targetIndex + (target.position === "after" ? 1 : 0), 0, movedChannel);
  } else {
    targetGroup.push(movedChannel);
  }

  return {
    channels: categoryIds.flatMap((categoryId) => grouped.get(categoryId)!),
    groups: categoryIds.map((categoryId) => ({
      categoryId,
      channelIds: grouped.get(categoryId)!.map((channel) => channel.id)
    })),
    movedChannel
  };
}
