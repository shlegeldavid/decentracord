import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MessageView } from "../api.js";
import type { PendingMessage } from "../components/PendingMessageList";

interface MessageFeedScrollOptions {
  channelId: string;
  hasMoreHistory: boolean;
  historyLoadState: "loading" | "ready" | "error";
  isRevoked: boolean;
  onLoadEarlier: (before: number | undefined) => Promise<void>;
  messages: MessageView[];
  pending: PendingMessage[];
}

export function useMessageFeedScroll({
  channelId,
  hasMoreHistory,
  historyLoadState,
  isRevoked,
  onLoadEarlier,
  messages,
  pending
}: MessageFeedScrollOptions) {
  const [isLoadingEarlier, setIsLoadingEarlier] = useState(false);
  const [paginationError, setPaginationError] = useState(false);
  const [isAwayFromLatest, setIsAwayFromLatest] = useState(false);
  const scrollContainer = useRef<HTMLDivElement>(null);
  const topSentinel = useRef<HTMLDivElement>(null);
  const currentChannelId = useRef(channelId);
  const positionedChannelId = useRef<string | null>(null);
  const wasAtLatestRef = useRef(false);
  const latestMessage = messages.at(-1);
  const pendingRenderKey = JSON.stringify(pending.map(({ clientRequestId, content, reason, state }) => ({
    clientRequestId,
    content,
    reason,
    state
  })));
  const firstMessageSeq = messages[0]?.seq;

  function motionBehavior(): ScrollBehavior {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  }

  const updateLatestDistance = useCallback(() => {
    const container = scrollContainer.current;
    if (!container) return;
    const distanceFromLatest = Math.max(0, container.scrollHeight - container.scrollTop - container.clientHeight);
    const isAway = distanceFromLatest > 200;
    wasAtLatestRef.current = distanceFromLatest <= 2;
    setIsAwayFromLatest(isAway);
  }, []);

  function focusMessage(messageId: string, scrollToStart = false): void {
    const article = Array.from(document.querySelectorAll<HTMLElement>("[data-message-id]"))
      .find((element) => element.dataset.messageId === messageId);
    if (scrollToStart) article?.scrollIntoView({ behavior: motionBehavior(), block: "start" });
    article?.focus({ preventScroll: true });
  }

  function jumpToLatest(): void {
    const container = scrollContainer.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: motionBehavior() });
    window.requestAnimationFrame(updateLatestDistance);
  }

  useEffect(() => {
    currentChannelId.current = channelId;
    setIsLoadingEarlier(false);
    setPaginationError(false);
    setIsAwayFromLatest(false);
    positionedChannelId.current = null;
  }, [channelId]);

  const loadEarlier = useCallback(async () => {
    if (!hasMoreHistory || isLoadingEarlier || isRevoked) return;
    const container = scrollContainer.current;
    const previousHeight = container?.scrollHeight ?? 0;
    const previousTop = container?.scrollTop ?? 0;
    const channelAtStart = channelId;
    const before = firstMessageSeq;

    setPaginationError(false);
    setIsLoadingEarlier(true);
    try {
      await onLoadEarlier(before);
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => resolve());
      }));
      if (container && currentChannelId.current === channelAtStart && !isRevoked) {
        container.scrollTop = previousTop + (container.scrollHeight - previousHeight);
      }
    } catch {
      if (currentChannelId.current === channelAtStart) setPaginationError(true);
    } finally {
      setIsLoadingEarlier(false);
    }
  }, [channelId, firstMessageSeq, hasMoreHistory, isLoadingEarlier, isRevoked, onLoadEarlier]);

  useLayoutEffect(() => {
    const container = scrollContainer.current;
    if (!container || historyLoadState !== "ready" || (messages.length === 0 && pending.length === 0)) return;
    if (positionedChannelId.current !== channelId || wasAtLatestRef.current) {
      container.scrollTop = container.scrollHeight;
    }
    positionedChannelId.current = channelId;
    updateLatestDistance();
  }, [
    channelId,
    historyLoadState,
    latestMessage?.content,
    latestMessage?.id,
    latestMessage?.seq,
    pendingRenderKey,
    messages.length,
    updateLatestDistance
  ]);

  useEffect(() => {
    const sentinel = topSentinel.current;
    const container = scrollContainer.current;
    if (!sentinel || !container || firstMessageSeq === undefined || !hasMoreHistory || isRevoked || paginationError) return;
    const observer = new IntersectionObserver((entries) => {
      if (positionedChannelId.current === channelId && entries.some((entry) => entry.isIntersecting)) {
        void loadEarlier();
      }
    }, { root: container, rootMargin: "120px 0px 0px 0px", threshold: 0 });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [channelId, firstMessageSeq, hasMoreHistory, isRevoked, loadEarlier, paginationError]);

  useEffect(() => {
    const container = scrollContainer.current;
    if (!container) return;
    container.addEventListener("scroll", updateLatestDistance, { passive: true });
    updateLatestDistance();
    return () => container.removeEventListener("scroll", updateLatestDistance);
  }, [channelId, updateLatestDistance]);

  return { scrollContainer, topSentinel, focusMessage, jumpToLatest, loadEarlier, isLoadingEarlier, paginationError, isAwayFromLatest };
}
