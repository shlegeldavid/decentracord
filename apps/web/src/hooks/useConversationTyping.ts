import { useCallback, useEffect, useRef, useState } from "react";

type TypingEntry = { login: string; expiresAt: number };
type TypingByConversation = Map<string, { logins: string[] }>;

const typingLifetime = 10_000;
const typingInterval = 2_000;

export function useConversationTyping(sendTyping: (conversationId: string) => boolean) {
  const entries = useRef(new Map<string, Map<string, TypingEntry>>());
  const sentAt = useRef(new Map<string, number>());
  const [typingByConversation, setTypingByConversation] = useState<TypingByConversation>(() => new Map());

  const publish = useCallback(() => {
    const next: TypingByConversation = new Map();
    for (const [conversationId, participants] of entries.current) {
      next.set(conversationId, { logins: [...participants.values()].map((entry) => entry.login) });
    }
    setTypingByConversation(next);
  }, []);

  const recordTyping = useCallback((conversationId: string, userId: string, login: string) => {
    const participants = entries.current.get(conversationId) ?? new Map<string, TypingEntry>();
    participants.set(userId, { login, expiresAt: Date.now() + typingLifetime });
    entries.current.set(conversationId, participants);
    publish();
  }, [publish]);

  const clearTyping = useCallback(() => {
    entries.current.clear();
    sentAt.current.clear();
    publish();
  }, [publish]);

  const emitTyping = useCallback((conversationId: string) => {
    const now = Date.now();
    if (now - (sentAt.current.get(conversationId) ?? 0) < typingInterval) return;
    if (sendTyping(conversationId)) sentAt.current.set(conversationId, now);
  }, [sendTyping]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [conversationId, participants] of entries.current) {
        for (const [userId, entry] of participants) {
          if (entry.expiresAt > now) continue;
          participants.delete(userId);
          changed = true;
        }
        if (participants.size === 0) entries.current.delete(conversationId);
      }
      if (changed) publish();
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [publish]);

  function typingLabelFor(conversationId: string): string | null {
    const logins = typingByConversation.get(conversationId)?.logins;
    if (!logins?.length) return null;
    return logins.length === 1 ? `${logins[0]} печатает…` : "Печатают…";
  }

  return { typingByConversation, typingLabelFor, emitTyping, recordTyping, clearTyping };
}
