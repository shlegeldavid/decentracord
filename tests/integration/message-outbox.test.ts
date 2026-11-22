import { describe, expect, it, vi } from "vitest";
import { messageScopeKey, type MessageScope } from "../../apps/web/src/lib/messageHistory.js";
import { MessageOutbox, type PendingMessage } from "../../apps/web/src/lib/messageOutbox.js";

function message(kind: MessageScope, scopeId: string, requestId: string): PendingMessage {
  return { clientRequestId: requestId, scopeKey: messageScopeKey(kind, scopeId), content: requestId, state: "queued" };
}

describe("message outbox", () => {
  it("acknowledges only the matching author and scope and ignores a later duplicate reply", () => {
    const publish = vi.fn();
    const outbox = new MessageOutbox(publish);
    const entry = message("channel", "channel-1", "request-1");
    const attempt = outbox.startSending(entry);
    const ack = { clientRequestId: entry.clientRequestId, authorId: "self", channelId: "channel-1", conversationId: null };

    outbox.acknowledge({ ...ack, authorId: "peer" }, "self");
    outbox.acknowledge({ ...ack, channelId: null, conversationId: "channel-1" }, "self");
    expect(outbox.awaitsDelivery(attempt)).toBe(true);
    expect(outbox.retryEntry("conversation", entry.clientRequestId)).toBeNull();
    expect(publish).toHaveBeenCalledOnce();

    outbox.acknowledge(ack, "self");
    expect(outbox.awaitsDelivery(attempt)).toBe(false);
    expect(publish).toHaveBeenLastCalledWith([]);
  });

  it("keeps the current channel retry and rejects only the relevant attempt", () => {
    const publish = vi.fn();
    const outbox = new MessageOutbox(publish);
    const entry = message("channel", "channel-1", "request-1");
    const first = outbox.startSending(entry);
    const transient = { rejected: false, isConnected: () => true } as const;
    const terminal = { rejected: true, reason: "Forbidden" } as const;

    outbox.requeueSending();
    expect(outbox.recordFailure("channel", first, transient)).toBeUndefined();
    expect(publish).toHaveBeenLastCalledWith([expect.objectContaining({ state: "queued" })]);
    expect(outbox.recordFailure("channel", first, terminal)).toBe("rejected");
    expect(publish).toHaveBeenLastCalledWith([expect.objectContaining({ state: "rejected", reason: "Forbidden" })]);

    const retry = outbox.startSending(entry);
    expect(outbox.recordFailure("channel", first, terminal)).toBeUndefined();
    expect(outbox.awaitsDelivery(first)).toBe(true);
    expect(outbox.recordFailure("channel", retry, transient)).toBe("failed");
    expect(publish).toHaveBeenLastCalledWith([expect.objectContaining({ state: "failed" })]);

    outbox.reset();
    outbox.enqueue(entry);
    expect(outbox.awaitsDelivery(retry)).toBe(false);
    expect(outbox.recordFailure("channel", retry, terminal)).toBeUndefined();
    expect(publish).toHaveBeenLastCalledWith([entry]);
  });

  it("rechecks channel access during replay and preserves offline conversations", async () => {
    const publish = vi.fn();
    const outbox = new MessageOutbox(publish);
    const first = message("channel", "first", "first-request");
    const revoked = message("channel", "revoked", "revoked-request");
    const last = message("channel", "last", "last-request");
    const conversation = message("conversation", "first", "dm-request");
    for (const entry of [first, revoked, last, conversation]) outbox.enqueue(entry);

    const readable = new Set(["first", "revoked", "last"]);
    const send = vi.fn(async (id: string, entry: PendingMessage) => {
      outbox.startSending(entry);
      if (id === "first") readable.delete("revoked");
    });
    await outbox.replayChannels({ canReplay: () => true, canView: (id) => readable.has(id), send });
    expect(send.mock.calls).toEqual([["first", first], ["last", last]]);

    outbox.dropUnreadableChannels(readable);
    expect(outbox.retryEntry("channel", revoked.clientRequestId)).toBeNull();
    expect(outbox.retryEntry("conversation", conversation.clientRequestId)).toEqual({ scopeId: "first", entry: conversation });
  });
});
