import type { MessageView } from "../api.js";
import { channelIdFromScope, messageScopeKey, scopeKeyOf, type MessageScope } from "./messageHistory.js";

export interface PendingMessage {
  clientRequestId: string;
  scopeKey: string;
  content: string;
  state: "sending" | "failed" | "queued" | "rejected";
  reason?: string;
}

type PendingEntry = PendingMessage & { attempt?: symbol };
type SendAttempt = { id: string; token: symbol; isCurrent: () => boolean };
type DeliveryReceipt = Pick<MessageView, "authorId" | "clientRequestId" | "channelId" | "conversationId">;

type DeliveryFailure =
  | { rejected: true; reason: string }
  | { rejected: false; isConnected: () => boolean };

type ChannelReplay = {
  canReplay: () => boolean;
  canView: (channelId: string) => boolean;
  send: (channelId: string, entry: PendingMessage) => Promise<void>;
};

export class MessageOutbox {
  private entries = new Map<string, PendingEntry>();

  constructor(private readonly onChange: (entries: PendingMessage[]) => void) {}

  captureSession(): () => boolean {
    const current = this.entries;
    return () => this.entries === current;
  }

  reset(): void {
    this.entries = new Map();
    this.publish();
  }

  enqueue(entry: PendingMessage): void {
    this.entries.set(entry.clientRequestId, { ...entry, state: "queued" });
    this.publish();
  }

  retryEntry(kind: MessageScope, requestId: string): { scopeId: string; entry: PendingMessage } | null {
    const entry = this.entries.get(requestId);
    const prefix = messageScopeKey(kind, "");
    if (!entry?.scopeKey.startsWith(prefix)) return null;
    const scopeId = entry.scopeKey.slice(prefix.length);
    return scopeId ? { scopeId, entry } : null;
  }

  startSending(entry: PendingMessage): SendAttempt {
    const isCurrent = this.captureSession();
    const { clientRequestId, scopeKey, content } = entry;
    const token = Symbol();
    this.entries.set(clientRequestId, { clientRequestId, scopeKey, content, state: "sending", attempt: token });
    this.publish();
    return { id: clientRequestId, token, isCurrent };
  }

  awaitsDelivery(attempt: SendAttempt): boolean {
    return attempt.isCurrent() && this.entries.has(attempt.id);
  }

  acknowledge(message: DeliveryReceipt, userId: string | undefined): void {
    const entry = this.entries.get(message.clientRequestId);
    if (message.authorId !== userId || entry?.scopeKey !== scopeKeyOf(message)) return;
    this.entries.delete(message.clientRequestId);
    this.publish();
  }

  recordFailure(kind: MessageScope, attempt: SendAttempt, failure: DeliveryFailure): PendingMessage["state"] | undefined {
    if (!attempt.isCurrent()) return;
    const current = this.entries.get(attempt.id);
    if (current?.attempt !== attempt.token || current.state === "rejected") return;
    // После восстановления связи канал уже ждёт повторной отправки.
    if (kind === "channel" && current.state === "queued" && !failure.rejected) return;

    const state = failure.rejected ? "rejected" : failure.isConnected() ? "failed" : "queued";
    this.entries.set(attempt.id, { ...current, state, ...(failure.rejected ? { reason: failure.reason } : {}) });
    this.publish();
    return state;
  }

  requeueSending(): void {
    for (const [id, entry] of this.entries) {
      if (entry.state === "sending") this.entries.set(id, { ...entry, state: "queued" });
    }
    this.publish();
  }

  dropUnreadableChannels(readable: ReadonlySet<string>): void {
    for (const [id, entry] of this.entries) {
      const channelId = channelIdFromScope(entry.scopeKey);
      if (channelId !== null && !readable.has(channelId)) this.entries.delete(id);
    }
    this.publish();
  }

  rejectChannel(channelId: string, reason: string): void {
    const scopeKey = messageScopeKey("channel", channelId);
    for (const [id, entry] of this.entries) {
      if (entry.scopeKey === scopeKey && (entry.state === "queued" || entry.state === "sending")) {
        this.entries.set(id, { ...entry, state: "rejected", reason });
      }
    }
    this.publish();
  }

  async replayChannels({ canReplay, canView, send }: ChannelReplay): Promise<void> {
    const isCurrent = this.captureSession();
    for (const entry of [...this.entries.values()]) {
      if (!isCurrent() || !canReplay()) break;
      if (entry.state !== "queued" || this.entries.get(entry.clientRequestId) !== entry) continue;
      const id = channelIdFromScope(entry.scopeKey);
      if (id && canView(id)) await send(id, entry);
    }
  }

  private publish(): void {
    this.onChange([...this.entries.values()]);
  }
}
