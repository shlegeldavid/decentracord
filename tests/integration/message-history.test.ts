import { describe, expect, it, vi } from "vitest";
import type { MessageView } from "../../apps/web/src/api.js";
import { HistoryCursors, type HistoryPage } from "../../apps/web/src/lib/historyCursors.js";
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

function deferredPage() {
  let resolve!: (page: HistoryPage) => void;
  const promise = new Promise<HistoryPage>((done) => { resolve = done; });
  return { promise, resolve };
}

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

describe("history cursors", () => {
  it("keeps page read positions separate from the event cursor and retains deletions", async () => {
    const cursors = new HistoryCursors();
    cursors.select(scope);
    const ordinary = message("ordinary", 1, 7);
    const live = message("live", 2, 8);
    cursors.recordPage(scope, { messages: [ordinary], cursor: 7 }, true);
    expect(cursors.recordMessage(live, {}).hasGap).toBe(true);
    expect(cursors.maxAppliedSeq(scope)).toBe(1);

    const baseline: HistoryPage = { messages: [ordinary], cursor: 7, hasMore: false };
    const fetchPage = vi.fn().mockResolvedValueOnce(baseline)
      .mockResolvedValueOnce({ messages: [live], cursor: 8, hasMore: false });
    const markRead = vi.fn();
    await cursors.catchUp({
      key: scope,
      isSelected: () => true,
      canDisplay: () => true,
      fetchPage,
      showBaseline: vi.fn(),
      applyEvent: (entry) => { cursors.recordMessage(entry, { authoritativeSnapshot: true }); },
      markRead
    });
    expect(fetchPage.mock.calls).toEqual([[{ limit: 50 }], [{ after: 7, limit: 200 }]]);
    expect(cursors.maxAppliedSeq(scope)).toBe(2);
    expect(markRead).toHaveBeenCalledOnce();

    cursors.recordDeletion(live.id, { scopeKey: scope, updatedSeq: 9 });
    expect(cursors.mergeMessage([ordinary], live)).toEqual([ordinary]);
    expect(cursors.mergePage([ordinary], scope, { messages: [live], cursor: 8 }, true)).toEqual([ordinary]);
  });

  it("rechecks access and ignores replies after forgetting a scope or replacing the session", async () => {
    const cursors = new HistoryCursors();
    const dm = messageScopeKey("conversation", "conversation-1");
    cursors.select(scope);
    const canDisplay = () => cursors.isSelected(scope);
    const request = cursors.beginPage(scope, canDisplay);
    expect(request.canApply()).toBe(true);
    cursors.select(dm);
    expect(request.canApply()).toBe(false);
    expect(request.sameSession()).toBe(true);

    cursors.select(scope);
    const applyEvent = vi.fn();
    const read = vi.fn();
    const delayed = deferredPage();
    cursors.recordPage(scope, { messages: [], cursor: 2 }, false);
    const pending = cursors.catchUp({
      key: scope,
      isSelected: canDisplay,
      canDisplay,
      fetchPage: () => delayed.promise,
      showBaseline: vi.fn(),
      applyEvent,
      markRead: read
    });
    cursors.forget(scope);
    const replacement = cursors.beginPage(scope, canDisplay);
    delayed.resolve({ messages: [message("late", 3, 3)], cursor: 3, hasMore: false });
    await pending;
    expect(request.canApply()).toBe(false);
    expect(replacement.canApply()).toBe(true);
    expect(applyEvent).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    cursors.reset();
    expect(replacement.sameSession()).toBe(false);
    expect(replacement.canApply()).toBe(false);
  });

  it("coalesces requests during replay and retries a gap that remains after the last page", async () => {
    const cursors = new HistoryCursors();
    cursors.select(scope);
    cursors.recordPage(scope, { messages: [], cursor: 3 }, false);
    const onGap = vi.fn();
    cursors.setGapHandler(onGap);
    const first = deferredPage();
    const last = { messages: [], cursor: 4, hasMore: false };
    const fetchPage = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(last);
    const options = {
      key: scope,
      isSelected: () => true,
      canDisplay: () => true,
      fetchPage,
      showBaseline: vi.fn(),
      applyEvent: vi.fn(),
      markRead: vi.fn()
    };
    const replay = cursors.catchUp(options);
    cursors.recordMessage(message("ahead", 10, 10), { requestCatchUpOnGap: false });
    await cursors.catchUp(options);
    expect(fetchPage).toHaveBeenCalledExactlyOnceWith({ after: 3, limit: 200 });
    first.resolve(last);
    await replay;
    expect(fetchPage.mock.calls).toEqual([[{ after: 3, limit: 200 }], [{ after: 4, limit: 200 }]]);
    expect(onGap).toHaveBeenCalledExactlyOnceWith(scope);
    expect(options.markRead).toHaveBeenCalledOnce();
  });
});
