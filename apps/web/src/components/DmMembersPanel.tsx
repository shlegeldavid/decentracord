import { useState } from "react";
import {
  ApiError,
  removeConversationParticipant,
  updateConversationParticipantRight,
  type Conversation,
  type ConversationParticipant
} from "../api";
import { avatarColor, initials } from "../lib/avatar";
import { CheckIcon, CloseIcon, PlusIcon } from "./icons";

interface DmMembersPanelProps {
  conversation: Conversation | null;
  currentUserId: string;
  csrfToken: string;
  onMembersChanged: () => void;
  onOpenAddMembers: () => void;
  onSessionExpired: () => void;
}

const MEMBERS_TITLE_ID = "dm-members-title";

/**
 * Правая панель открытой переписки: состав группы, добавление и
 * удаление участников, выдача права добавлять. Состав берётся из
 * `conversation.participants` — отдельного запроса участников нет, иначе
 * второй источник состава разошёлся бы с первым.
 */
export function DmMembersPanel({
  conversation,
  currentUserId,
  csrfToken,
  onMembersChanged,
  onOpenAddMembers,
  onSessionExpired
}: DmMembersPanelProps) {
  const [grantInFlightId, setGrantInFlightId] = useState<string | null>(null);
  const [removeInFlightId, setRemoveInFlightId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  if (!conversation) return null;

  const conversationId = conversation.id;
  const isGroup = conversation.kind === "group";
  const canManageMembers = isGroup && conversation.canManageMembers;
  // Право выдаёт и отзывает только создатель: носитель права пользуется им, но
  // не передаёт дальше.
  const canGrantRight = isGroup && conversation.isCreator;
  const isBusy = grantInFlightId !== null || removeInFlightId !== null;
  const participants = [...conversation.participants].sort((left, right) =>
    left.login.localeCompare(right.login, "ru-RU", { sensitivity: "base" })
  );

  async function toggleRight(participant: ConversationParticipant): Promise<void> {
    if (grantInFlightId !== null) return;
    setGrantInFlightId(participant.id);
    setError(null);
    try {
      await updateConversationParticipantRight(
        conversationId,
        participant.id,
        !participant.canAddParticipants,
        csrfToken
      );
      // `aria-pressed` меняется только после ответа сервера: право влияет на
      // чужие действия, оптимистичное переключение показало бы несостоявшееся.
      onMembersChanged();
    } catch (toggleError: unknown) {
      if (toggleError instanceof ApiError && toggleError.status === 401) {
        onSessionExpired();
        return;
      }
      setError("Не удалось изменить право участника. Попробуйте ещё раз.");
    } finally {
      setGrantInFlightId(null);
    }
  }

  async function removeParticipant(participant: ConversationParticipant): Promise<void> {
    if (removeInFlightId !== null) return;
    setRemoveInFlightId(participant.id);
    setError(null);
    try {
      await removeConversationParticipant(conversationId, participant.id, csrfToken);
      setAnnouncement(`${participant.login} убран из переписки.`);
      onMembersChanged();
    } catch (removeError: unknown) {
      if (removeError instanceof ApiError && removeError.status === 401) {
        onSessionExpired();
        return;
      }
      setError("Не удалось изменить состав переписки. Попробуйте ещё раз.");
    } finally {
      setRemoveInFlightId(null);
    }
  }

  return (
    <aside className="settings-card member-panel dm-members-panel" aria-labelledby={MEMBERS_TITLE_ID} aria-busy={isBusy}>
      <header className="members-panel-header dm-members-header">
        <span className="dm-members-avatar" aria-hidden="true">
          {initials(participants[0]?.login ?? "?")}
        </span>
        <div className="dm-members-heading">
          <h2 id={MEMBERS_TITLE_ID}>Участники переписки</h2>
          <p className="dm-members-kind">
            {isGroup ? `Групповая переписка · ${participants.length}` : "Личная переписка"}
          </p>
        </div>
        {canManageMembers && (
          <button type="button" className="icon-btn-24" aria-label="Добавить участника" onClick={onOpenAddMembers}>
            <PlusIcon size={20} />
          </button>
        )}
      </header>
      <span className="visually-hidden" aria-live="polite">{announcement}</span>
      {error !== null && <p className="form-error" role="alert">{error}</p>}
      {participants.length === 0 ? (
        <p className="settings-copy">В переписке пока нет участников.</p>
      ) : (
        <ul className="channel-members-list" aria-label="Участники переписки">
          {participants.map((participant) => {
            const isSelf = participant.id === currentUserId;
            return (
              <li className="dm-member-row" key={participant.id} data-dm-member-id={participant.id}>
                <span
                  className="member-avatar"
                  ref={(element) => element?.style.setProperty("background", avatarColor(participant.login))}
                  aria-hidden="true"
                >
                  {initials(participant.login)}
                </span>
                <span className="dm-member-name" title={participant.login}>{participant.login}</span>
                {isSelf && <small>вы</small>}
                {canGrantRight && !isSelf && (
                  <button
                    type="button"
                    className="icon-btn-24 dm-member-grant"
                    aria-label="Право добавлять участников"
                    aria-pressed={participant.canAddParticipants}
                    aria-busy={grantInFlightId === participant.id}
                    onClick={() => void toggleRight(participant)}
                  >
                    {participant.canAddParticipants ? <CheckIcon size={16} /> : <PlusIcon size={16} />}
                  </button>
                )}
                {canManageMembers && !isSelf && (
                  <span className="dm-member-actions">
                    <button
                      type="button"
                      className="icon-btn-24"
                      aria-label={`Убрать ${participant.login} из переписки`}
                      aria-busy={removeInFlightId === participant.id}
                      onClick={() => void removeParticipant(participant)}
                    >
                      <CloseIcon size={16} />
                    </button>
                  </span>
                )}
                <span
                  className="presence-dot"
                  data-presence={participant.presence}
                  role="img"
                  aria-label={participant.presence === "online" ? "В сети" : "Не в сети"}
                  title={participant.presence === "online" ? "В сети" : "Не в сети"}
                />
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
