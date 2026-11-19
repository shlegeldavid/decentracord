export interface ConfirmedMention {
  id: string;
  login: string;
}

export type MessageToken =
  | { type: "text"; value: string }
  | { type: "mention"; value: string; id: string };

const mentionStartPattern = /(?<![\p{L}\p{N}])@/gu;
const mentionCharacterPattern = /^[a-z0-9_.-]$/iu;
const validLoginPattern = /^[a-z0-9_.-]{3,64}$/iu;

export function parseMentionTokens(text: string, confirmedMentions: readonly ConfirmedMention[]): MessageToken[] {
  const mentionsByLogin = new Map<string, ConfirmedMention>();

  for (const mention of confirmedMentions) {
    const login = mention.login.toLowerCase();
    if (!validLoginPattern.test(login) || mentionsByLogin.has(login)) continue;
    mentionsByLogin.set(login, mention);
  }

  const candidates = [...mentionsByLogin.values()].sort((left, right) => right.login.length - left.login.length);
  const segments: MessageToken[] = [];
  let cursor = 0;

  for (const match of text.matchAll(mentionStartPattern)) {
    const start = match.index;
    if (start < cursor) continue;

    const mention = candidates.find((candidate) => {
      const login = candidate.login.toLowerCase();
      const loginEnd = start + 1 + login.length;
      if (text.slice(start + 1, loginEnd).toLowerCase() !== login) return false;

      const nextCharacter = text[loginEnd];
      return nextCharacter === undefined || !mentionCharacterPattern.test(nextCharacter);
    });

    if (!mention) continue;

    if (start > cursor) segments.push({ type: "text", value: text.slice(cursor, start) });
    const end = start + 1 + mention.login.length;
    segments.push({ type: "mention", value: text.slice(start, end), id: mention.id });
    cursor = end;
  }

  if (cursor < text.length) segments.push({ type: "text", value: text.slice(cursor) });
  return segments;
}
