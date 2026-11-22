import type { MessageView } from "../api.js";

export const CHANNEL_SCOPE_PREFIX = "channel:";
export const CONVERSATION_SCOPE_PREFIX = "conversation:";

export type MessageScope = "channel" | "conversation";
export type ScopeKey = string;
export type MessageHistoryPage = { messages: MessageView[]; cursor: number };

export function messageScopeKey(kind: MessageScope, id: string): ScopeKey {
  return `${kind}:${id}`;
}

export function scopeKeyOf(message: MessageView): ScopeKey {
  return message.conversationId
    ? messageScopeKey("conversation", message.conversationId)
    : `${CHANNEL_SCOPE_PREFIX}${message.channelId}`;
}

export function channelIdFromScope(scopeKey: ScopeKey): string | null {
  return scopeKey.startsWith(CHANNEL_SCOPE_PREFIX) ? scopeKey.slice(CHANNEL_SCOPE_PREFIX.length) : null;
}

export function compareMessageOrder(left: MessageView, right: MessageView): number {
  return left.seq - right.seq;
}

export function withoutDeletedContent(message: MessageView): MessageView {
  return { ...message, deleted: true, content: "", mentions: [] };
}

export function mergeHistoryPage(
  current: MessageView[],
  scopeKey: ScopeKey,
  page: MessageHistoryPage,
  deletedIds: ReadonlySet<string>,
  preserveCurrent: boolean
): MessageView[] {
  const next = new Map<string, MessageView>();
  for (const message of page.messages) {
    if (message.deleted) next.set(message.id, withoutDeletedContent(message));
    else if (!deletedIds.has(message.id)) next.set(message.id, message);
  }

  for (const message of current) {
    if (scopeKeyOf(message) !== scopeKey || (!message.deleted && deletedIds.has(message.id))) continue;
    const fromPage = next.get(message.id);
    const keep = fromPage
      ? message.updatedSeq > fromPage.updatedSeq
      : message.deleted || preserveCurrent || message.updatedSeq > page.cursor;
    if (keep) next.set(message.id, message);
  }
  return [...next.values()].sort(compareMessageOrder);
}
