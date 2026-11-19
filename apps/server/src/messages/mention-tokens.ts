const mentionPattern = /(?<![\p{L}\p{N}])@([a-z0-9_.-]{3,64})(?![a-z0-9_.-])/giu;

export function findMentionCandidates(text: string): string[] {
  const candidates = new Set<string>();
  for (const match of text.matchAll(mentionPattern)) {
    const login = match[1];
    if (login !== undefined) candidates.add(login.toLowerCase());
  }
  return [...candidates];
}

export function resolveMentions(text: string, knownLogins: string[]): string[] {
  const known = new Set(knownLogins.map((login) => login.toLowerCase()));
  return findMentionCandidates(text).filter((candidate) => known.has(candidate));
}
