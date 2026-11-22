import { useCallback, useEffect, useState } from "react";
import type { RefObject } from "react";
import { ApiError, getPinnedMessages, pinMessage, unpinMessage } from "../api.js";

type ChannelPinsOptions = {
  channelId: string | null;
  selectedChannelId: RefObject<string | null>;
  csrfToken: string | null;
  onError: (message: string | null) => void;
  onSessionExpired: () => void;
};

export function useChannelPins({ channelId, selectedChannelId, csrfToken, onError, onSessionExpired }: ChannelPinsOptions) {
  const [messageIds, setMessageIds] = useState<Set<string>>(() => new Set());
  const [open, setOpen] = useState(false);

  const setPinned = useCallback((messageId: string, pinned: boolean) => {
    setMessageIds((current) => {
      if (current.has(messageId) === pinned) return current;
      const next = new Set(current);
      if (pinned) next.add(messageId);
      else next.delete(messageId);
      return next;
    });
  }, []);

  useEffect(() => {
    setMessageIds(new Set());
    setOpen(false);
    if (!channelId) return;
    let active = true;
    void getPinnedMessages(channelId).then((pins) => {
      if (active) setMessageIds(new Set(pins.map((pin) => pin.messageId)));
    }).catch(() => {
      if (active) setMessageIds(new Set());
    });
    return () => { active = false; };
  }, [channelId]);

  const changePinned = useCallback(async (messageId: string, pinned: boolean) => {
    const target = selectedChannelId.current;
    if (!target || !csrfToken) return;
    onError(null);
    try {
      const request = pinned ? pinMessage : unpinMessage;
      await request(target, messageId, csrfToken);
      if (selectedChannelId.current === target) setPinned(messageId, pinned);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired();
      } else if (selectedChannelId.current === target) {
        onError(error instanceof ApiError ? error.message : pinned
          ? "Не удалось закрепить сообщение."
          : "Не удалось снять закрепление.");
      }
    }
  }, [csrfToken, selectedChannelId, setPinned, onError, onSessionExpired]);

  return { messageIds, open, setOpen, setPinned, changePinned };
}
