import { useCallback, useRef, useState } from "react";
import type { Channel, ChannelCategory } from "../api.js";

type RevokedChannel = { id: string; reason: string };
export type ChannelList = { channels: Channel[]; categories: ChannelCategory[] };
export type ChannelUnreadPolicy = "replace" | "preserve" | "unchanged";

type ChannelAccessEffects = {
  forgetHistory: (id: string) => void;
  forgetSubscription: (id: string) => void;
  dropUnreadableMessages: (readableIds: ReadonlySet<string>) => void;
};

export function useWorkspaceChannels(resetHistoryStatus: (status?: "loading" | "ready") => void) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [categories, setCategories] = useState<ChannelCategory[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lastReadSeq, setLastReadSeq] = useState<number | undefined>(undefined);
  const [revoked, setRevoked] = useState<RevokedChannel | null>(null);
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const channelsRef = useRef<Channel[]>([]);
  const selectedIdRef = useRef<string | null>(null);
  const selectedSnapshot = useRef<Channel | null>(null);
  const revokedRef = useRef<RevokedChannel | null>(null);
  const unreadCountsRef = useRef<Record<string, number>>({});
  const session = useRef(0);

  const findChannel = useCallback((id: string) => channelsRef.current.find((channel) => channel.id === id), []);

  const replaceChannels = useCallback((items: Channel[]) => {
    channelsRef.current = items;
    const selected = items.find((channel) => channel.id === selectedIdRef.current);
    if (selected?.canView && revokedRef.current?.id !== selected.id) selectedSnapshot.current = selected;
    setChannels(items);
  }, []);

  const replaceChannelList = useCallback((list: ChannelList, unread: ChannelUnreadPolicy) => {
    if (unread !== "unchanged") {
      const current = unread === "preserve" ? unreadCountsRef.current : {};
      const next: Record<string, number> = {};
      for (const channel of list.channels) {
        next[channel.id] = current[channel.id] ?? channel.unreadCount ?? 0;
      }
      unreadCountsRef.current = next;
      setUnreadCounts(next);
    }
    replaceChannels(list.channels);
    setCategories(list.categories);
  }, [replaceChannels]);

  const setUnread = useCallback((id: string, count: number) => {
    const next = { ...unreadCountsRef.current, [id]: count };
    unreadCountsRef.current = next;
    setUnreadCounts(next);
  }, []);

  const incrementUnread = useCallback((id: string) => {
    setUnread(id, (unreadCountsRef.current[id] ?? 0) + 1);
  }, [setUnread]);

  const deselectChannel = useCallback(() => {
    selectedIdRef.current = null;
    selectedSnapshot.current = null;
    setSelectedId(null);
    setLastReadSeq(undefined);
  }, []);

  const clearRevocation = useCallback(() => {
    revokedRef.current = null;
    setRevoked(null);
  }, []);

  const resetChannelSession = useCallback(() => {
    session.current += 1;
    deselectChannel();
    clearRevocation();
  }, [clearRevocation, deselectChannel]);

  const leaveRevokedChannel = useCallback(() => {
    deselectChannel();
    clearRevocation();
    resetHistoryStatus();
  }, [clearRevocation, deselectChannel, resetHistoryStatus]);

  const selectReadableChannel = useCallback((id: string): boolean => {
    const channel = findChannel(id);
    if (!channel?.canView) return false;
    const changed = selectedIdRef.current !== id;
    selectedIdRef.current = id;
    selectedSnapshot.current = channel;
    setSelectedId(id);
    // Разделитель непрочитанного остаётся на месте после подтверждения прочтения.
    setLastReadSeq(channel.lastReadSeq ?? 0);
    clearRevocation();
    if (changed) resetHistoryStatus("loading");
    setUnread(id, 0);
    return true;
  }, [clearRevocation, findChannel, resetHistoryStatus, setUnread]);

  const confirmRead = useCallback((id: string, seq: number) => {
    const current = session.current;
    return () => {
      if (session.current !== current) return;
      replaceChannels(channelsRef.current.map((channel) => channel.id === id
        ? { ...channel, lastReadSeq: Math.max(channel.lastReadSeq ?? 0, seq) }
        : channel));
    };
  }, [replaceChannels]);

  const revokeSelectedChannel = useCallback((
    id: string,
    reason = "Доступ к каналу отозван",
    inaccessibleChannel?: Channel
  ) => {
    if (selectedIdRef.current !== id) return;
    const snapshot = inaccessibleChannel ?? selectedSnapshot.current;
    if (snapshot?.id === id) {
      selectedSnapshot.current = {
        ...snapshot,
        description: null,
        canView: false,
        canSend: false,
        canManageMessages: false,
        ownerEditable: false,
        unreadCount: 0
      };
    }
    const next = { id, reason };
    revokedRef.current = next;
    setRevoked(next);
    resetHistoryStatus();
  }, [resetHistoryStatus]);

  const syncSelection = useCallback((items: Channel[], preserveReason: boolean) => {
    const id = selectedIdRef.current;
    if (!id) return;

    const selected = items.find((channel) => channel.id === id);
    const lastRevoked = revokedRef.current;
    if (!selected?.canView) {
      const reason = (preserveReason || !selected) && lastRevoked?.id === id ? lastRevoked.reason : undefined;
      revokeSelectedChannel(id, reason, selected);
    } else if (lastRevoked?.id === id) {
      clearRevocation();
    }
  }, [clearRevocation, revokeSelectedChannel]);

  const reconcileChannelList = useCallback((list: ChannelList, source: "socket" | "http", effects: ChannelAccessEffects) => {
    const fromSocket = source === "socket";
    if (!fromSocket) syncSelection(list.channels, false);

    const readable = new Set(list.channels.filter((channel) => channel.canView).map((channel) => channel.id));
    for (const channel of channelsRef.current) {
      if (readable.has(channel.id)) continue;
      if (channel.canView) effects.forgetHistory(channel.id);
      effects.forgetSubscription(channel.id);
    }
    effects.dropUnreadableMessages(readable);

    if (fromSocket) syncSelection(list.channels, true);
    replaceChannelList(list, fromSocket ? "preserve" : "replace");
  }, [replaceChannelList, syncSelection]);

  const selectedChannel = revoked?.id === selectedId
    ? selectedSnapshot.current
    : channels.find((channel) => channel.id === selectedId) ?? null;

  return {
    channels, categories, selectedChannel, selectedId, selectedIdRef, revoked, revokedRef, unreadCounts, lastReadSeq,
    channelsRef, findChannel, replaceChannels, setCategories, replaceChannelList, incrementUnread,
    deselectChannel, resetChannelSession, leaveRevokedChannel, selectReadableChannel, confirmRead,
    revokeSelectedChannel, reconcileChannelList
  };
}
