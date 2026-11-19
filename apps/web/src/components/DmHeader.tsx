import type { Conversation } from "../api";
import { avatarColor, initials } from "../lib/avatar";
import { conversationTitle } from "./DmRow";

interface DmHeaderProps {
  conversation: Conversation;
  currentUserId: string;
}

/**
 * Шапка открытой переписки: аватар или стек аватаров и логины вместо
 * названия канала. Знак `#`, плашка видимости, кнопка-название закреплений и
 * «Свойства канала» в переписке не рендерятся.
 */
export function DmHeader({ conversation, currentUserId }: DmHeaderProps) {
  const title = conversationTitle(conversation, currentUserId);
  const allLogins = conversation.participants.map((participant) => participant.login).join(", ");
  const stack = conversation.participants.slice(0, 2);

  return (
    <>
      {conversation.kind === "direct" ? (
        <span
          className="member-avatar"
          ref={(element) => element?.style.setProperty("background", avatarColor(title))}
          aria-hidden="true"
        >
          {initials(title)}
        </span>
      ) : (
        <span className="dm-avatar-stack dm-avatar-stack--header" aria-hidden="true">
          {stack.map((participant) => (
            <span
              key={participant.id}
              className="member-avatar dm-row-avatar"
              ref={(element) => element?.style.setProperty("background", avatarColor(participant.login))}
            >
              {initials(participant.login)}
            </span>
          ))}
        </span>
      )}
      <h2 id="workspace-messages-title" title={allLogins}>{title}</h2>
    </>
  );
}
