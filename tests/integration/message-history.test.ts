import { describe, expect, it } from "vitest";
import type { MessageView } from "../../apps/web/src/api.js";
import { mergeHistoryPage, messageScopeKey } from "../../apps/web/src/lib/messageHistory.js";

function message(id: string, seq: number, updatedSeq: number, fields: Partial<MessageView> = {}): MessageView {
  return {
    id,
    channelId: "channel-1",
    conversationId: null,
    authorId: "peer",
    authorLogin: "peer",
    seq,
    updatedSeq,
    content: id,
    mentions: [],
    editedAt: null,
    deleted: false,
    clientRequestId: id,
    createdAt: "2026-11-22T00:00:00Z",
    authorRoles: [],
    forwardedFrom: null,
    ...fields
  };
}

const scope = messageScopeKey("channel", "channel-1");

describe("message history merge", () => {
  it("keeps current messages and newer edits when older history arrives", () => {
    const current = message("current", 4, 4);
    const edit = message("changed", 3, 9, { content: "Текст после правки" });
    const oldEdit = message("changed", 3, 3);
    const earlier = message("earlier", 1, 1);
    const otherConversation = message("other", 2, 2, { channelId: null, conversationId: "other" });
    const page = { messages: [oldEdit, earlier], cursor: 9 };

    expect(mergeHistoryPage([current, edit, otherConversation], scope, page, new Set(), true))
      .toEqual([earlier, edit, current]);
  });

  it("keeps deletions and newer live messages when applying the latest server snapshot", () => {
    const omitted = message("omitted", 2, 2);
    const currentTombstone = message("deleted", 3, 8, { deleted: true, content: "" });
    const olderLiveCopy = message("deleted", 3, 3);
    const serverTombstone = message("server-deleted", 4, 5, {
      deleted: true,
      content: "Удалённый текст",
      mentions: [{ id: "peer", login: "peer" }]
    });
    const staleLiveCopy = message("server-deleted", 4, 7);
    const latest = message("live", 10, 10);
    const page = { messages: [olderLiveCopy, serverTombstone], cursor: 9 };

    expect(mergeHistoryPage(
      [latest, currentTombstone, staleLiveCopy, omitted],
      scope,
      page,
      new Set([currentTombstone.id, serverTombstone.id]),
      false
    )).toEqual([currentTombstone, { ...serverTombstone, content: "", mentions: [] }, latest]);
  });
});
