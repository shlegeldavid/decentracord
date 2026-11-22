import type { MessageView } from "../api.js";
import { mergeHistoryEvent, mergeHistoryPage, scopeKeyOf, type MessageHistoryPage, type ScopeKey } from "./messageHistory.js";

export type ApplyMessageOptions = {
  requestCatchUpOnGap?: boolean;
  authoritativeSnapshot?: boolean;
};

type ScopeCursor = {
  cursor?: number;
  observed: number;
  maxAppliedSeq: number;
  catchingUp: boolean;
  catchUpRequested: boolean;
};

export type HistoryPage = MessageHistoryPage & { hasMore: boolean };
type PageRequest = { after?: number; limit: number };

type CatchUpOptions = {
  key: ScopeKey;
  isSelected: () => boolean;
  canDisplay: () => boolean;
  fetchPage: (options: PageRequest) => Promise<HistoryPage>;
  showBaseline: (page: HistoryPage) => void;
  applyEvent: (message: MessageView) => void;
  markRead: () => void;
};

type RequestGuard = {
  isCurrent: () => boolean;
  canApply: () => boolean;
  sameSession: () => boolean;
};

const CATCH_UP_LIMIT = 200;

function advanceCursor(scope: ScopeCursor, cursor: number): number {
  const next = Math.max(scope.cursor ?? 0, cursor);
  scope.cursor = next;
  scope.observed = Math.max(scope.observed, next);
  return next;
}

export class HistoryCursors {
  private scopes = new Map<ScopeKey, ScopeCursor>();
  private deletedIds = new Set<string>();
  private selected: ScopeKey | null = null;
  private onGap: ((key: ScopeKey) => void) | undefined;

  reset(): void {
    this.selected = null;
    this.scopes = new Map();
    this.deletedIds = new Set();
  }

  select(key: ScopeKey | null): void {
    this.selected = key;
  }

  isSelected(key: ScopeKey): boolean {
    return this.selected === key;
  }

  forget(key: ScopeKey): void {
    this.scopes.delete(key);
  }

  maxAppliedSeq(key: ScopeKey): number {
    return this.scopes.get(key)?.maxAppliedSeq ?? 0;
  }

  setGapHandler(handler: (key: ScopeKey) => void): () => void {
    this.onGap = handler;
    return () => { this.onGap = undefined; };
  }

  beginPage(key: ScopeKey, canDisplay: () => boolean): RequestGuard {
    return this.beginRequest(key, canDisplay);
  }

  recordMessage(message: MessageView, options: ApplyMessageOptions): { key: ScopeKey; hasGap: boolean } {
    const key = scopeKeyOf(message);
    const scope = this.scope(key);
    const hasGap = this.observe(key, scope, message.updatedSeq, options.requestCatchUpOnGap !== false);
    if (message.deleted) this.deletedIds.add(message.id);
    if ((!hasGap || options.authoritativeSnapshot) && (message.deleted || !this.deletedIds.has(message.id))) {
      scope.maxAppliedSeq = Math.max(scope.maxAppliedSeq, message.seq);
    }
    return { key, hasGap };
  }

  recordDeletion(id: string, event?: { scopeKey: ScopeKey; updatedSeq: number }): void {
    this.deletedIds.add(id);
    if (event) this.observe(event.scopeKey, this.scope(event.scopeKey), event.updatedSeq, true);
  }

  recordPage(key: ScopeKey, page: MessageHistoryPage, preserveCurrent: boolean): void {
    const scope = this.scope(key);
    if (!preserveCurrent) {
      const cursor = advanceCursor(scope, page.cursor);
      if (scope.observed > cursor && this.isSelected(key)) this.onGap?.(key);
    }
    for (const message of page.messages) {
      scope.maxAppliedSeq = Math.max(scope.maxAppliedSeq, message.seq);
      if (message.deleted) this.deletedIds.add(message.id);
    }
  }

  mergeMessage(current: MessageView[], message: MessageView): MessageView[] {
    return mergeHistoryEvent(current, message, this.deletedIds);
  }

  mergePage(current: MessageView[], key: ScopeKey, page: MessageHistoryPage, preserveCurrent: boolean): MessageView[] {
    return mergeHistoryPage(current, key, page, this.deletedIds, preserveCurrent);
  }

  async catchUp(options: CatchUpOptions): Promise<void> {
    const { key, canDisplay, isSelected, markRead } = options;
    const { scope, isCurrent, canApply } = this.beginRequest(key, canDisplay);
    if (scope.catchingUp) {
      scope.catchUpRequested = true;
      return;
    }

    scope.catchingUp = true;
    let completed = false;
    try {
      const cursor = scope.cursor ?? await this.loadBaseline(scope, canApply, options);
      if (cursor === undefined) return;
      completed = await this.replayPages(scope, cursor, canApply, options);
      if (completed && canApply()) markRead();
    } catch (error) {
      if (isCurrent()) throw error;
    } finally {
      if (isCurrent()) {
        scope.catchingUp = false;
        const requested = scope.catchUpRequested;
        scope.catchUpRequested = false;
        if (completed && requested && scope.observed > (scope.cursor ?? 0) && isSelected()) {
          queueMicrotask(() => { if (isCurrent()) this.onGap?.(key); });
        }
      }
    }
  }

  private scope(key: ScopeKey): ScopeCursor {
    const existing = this.scopes.get(key);
    if (existing) return existing;
    const created = { observed: 0, maxAppliedSeq: 0, catchingUp: false, catchUpRequested: false };
    this.scopes.set(key, created);
    return created;
  }

  private beginRequest(key: ScopeKey, canDisplay: () => boolean): RequestGuard & { scope: ScopeCursor } {
    const scope = this.scope(key);
    const scopes = this.scopes;
    const isCurrent = () => this.scopes.get(key) === scope;
    return { scope, isCurrent, canApply: () => isCurrent() && canDisplay(), sameSession: () => scopes === this.scopes };
  }

  private observe(key: ScopeKey, scope: ScopeCursor, seq: number, catchUpOnGap: boolean): boolean {
    const current = scope.cursor ?? 0;
    scope.observed = Math.max(scope.observed, seq);
    if (seq <= current) return false;
    if (seq === current + 1) {
      advanceCursor(scope, seq);
      return false;
    }
    if (catchUpOnGap && this.isSelected(key)) this.onGap?.(key);
    return true;
  }

  private async loadBaseline(scope: ScopeCursor, canApply: () => boolean, options: CatchUpOptions): Promise<number | undefined> {
    if (!canApply()) return undefined;
    const page = await options.fetchPage({ limit: 50 });
    if (!canApply()) return undefined;
    this.recordPage(options.key, page, false);
    options.showBaseline(page);
    return scope.cursor;
  }

  private async replayPages(
    scope: ScopeCursor,
    after: number,
    canApply: () => boolean,
    { fetchPage, applyEvent }: CatchUpOptions
  ): Promise<boolean> {
    let cursor = after;
    while (canApply()) {
      const page = await fetchPage({ after: cursor, limit: CATCH_UP_LIMIT });
      if (!canApply()) return false;
      for (const message of page.messages) applyEvent(message);
      const next = advanceCursor(scope, page.cursor);
      if (next <= cursor) break;
      cursor = next;
      if (page.messages.length < CATCH_UP_LIMIT && scope.observed <= cursor) break;
    }
    return true;
  }
}
