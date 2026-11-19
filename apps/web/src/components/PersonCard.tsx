import { useCallback, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import type { PersonSearchResult } from "../api";
import { avatarColor, initials } from "../lib/avatar";

interface PersonCardProps {
  result: PersonSearchResult;
  onClose?: () => void;
  onStartConversation?: (person: PersonSearchResult) => Promise<void>;
  currentUserId?: string;
}

const NO_ROLES_LABEL = "Участник";
const NO_COMMON_CHANNELS_LABEL = "Нет общих каналов";

/**
 * Карточка участника из выдачи поиска людей.
 *
 * Кнопка «Написать сообщение» создаёт (или открывает существующую) переписку с
 * этим человеком. Для собственной карточки кнопка не рендерится: себе писать
 * нельзя.
 */
export function PersonCard({ result, onClose, onStartConversation, currentUserId }: PersonCardProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setAvatarElement = useCallback((element: HTMLSpanElement | null) => {
    element?.style.setProperty("background", avatarColor(result.login));
  }, [result.login]);

  const roleNames = result.roles.map((role) => role.name);
  const commonChannelNames = result.commonChannels.map((channel) => channel.name);
  const presenceLabel = result.presence === "online" ? "В сети" : "Не в сети";
  const isSelf = currentUserId !== undefined && currentUserId === result.id;

  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    onClose?.();
  }

  function stopPropagation(event: MouseEvent<HTMLElement>): void {
    event.stopPropagation();
  }

  async function startConversation(): Promise<void> {
    if (!onStartConversation || isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await onStartConversation(result);
      onClose?.();
    } catch {
      setError("Не удалось начать переписку. Попробуйте ещё раз.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section
      className="people-search-card"
      aria-label={`Карточка участника ${result.login}`}
      onKeyDown={handleKeyDown}
      onClick={stopPropagation}
    >
      <span className="member-avatar" ref={setAvatarElement} aria-hidden="true">
        {initials(result.login)}
      </span>
      <div>
        <div className="people-search-result-login">{result.login}</div>
        <div className="user-card-presence">
          <span
            className="presence-dot"
            data-presence={result.presence}
            role="img"
            aria-label={presenceLabel}
            title={presenceLabel}
          />
          <span>{result.presence === "online" ? "в сети" : "не в сети"}</span>
        </div>
        <div className="person-card-roles">
          <span>Роли</span>
          <span>{roleNames.length > 0 ? roleNames.join(", ") : NO_ROLES_LABEL}</span>
        </div>
        <div className="person-card-channels">
          <span>Общие каналы</span>
          <span>{commonChannelNames.length > 0 ? commonChannelNames.join(", ") : NO_COMMON_CHANNELS_LABEL}</span>
        </div>
        {!isSelf && (
          <div className="person-card-action">
            <button type="button" disabled={isSubmitting} onClick={() => void startConversation()}>
              Написать сообщение
            </button>
          </div>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
    </section>
  );
}
