import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import type { Channel, ChannelCategory, Conversation, MessageView } from "../api";
import { avatarColor, initials } from "../lib/avatar";
import { conversationTitle } from "./DmRow";
import { Modal } from "./ui/Modal";

// Цель пересылки: канал или переписка. Источник проверяется на сервере
// отдельно, поэтому клиент передаёт только выбранную пару.
export type ForwardDestination = { kind: "channel" | "conversation"; id: string };

interface ForwardMessageDialogProps {
  open: boolean;
  onClose: () => void;
  source: ForwardDestination;
  message: MessageView;
  channels: Channel[];
  categories: ChannelCategory[];
  conversations: Conversation[];
  currentUserId: string;
  onForward: (target: ForwardDestination) => Promise<void>;
  timeZone: string;
}

interface ChannelGroup {
  id: string | null;
  name: string;
  channels: Channel[];
}

interface ForwardOption {
  kind: ForwardDestination["kind"];
  id: string;
  name: string;
  // Логин для аватара строки переписки; у канала аватара нет.
  avatarLogin: string | null;
}

interface ForwardGroup {
  id: string;
  name: string;
  options: ForwardOption[];
}

const CONVERSATIONS_GROUP_NAME = "Личные сообщения";

// Каналы-получатели: только те, куда участник может писать. Порядок
// групп тот же, что в сайдбаре: сначала «Без категории», затем категории.
function groupSendableChannels(channels: Channel[], categories: ChannelCategory[]): ChannelGroup[] {
  const sendable = channels.filter((channel) => channel.canSend);
  const knownCategoryIds = new Set(categories.map((category) => category.id));
  const groups: ChannelGroup[] = [];
  for (const category of categories) {
    const categoryChannels = sendable.filter((channel) => channel.categoryId === category.id);
    if (categoryChannels.length === 0) continue;
    groups.push({ id: category.id, name: category.name, channels: categoryChannels });
  }
  // Каналы вне категорий — и те, чья категория участнику не видна: иначе
  // переслать в них было бы невозможно.
  const withoutCategory = sendable.filter((channel) =>
    channel.categoryId === null || !knownCategoryIds.has(channel.categoryId));
  if (withoutCategory.length > 0) {
    groups.unshift({ id: null, name: "Без категории", channels: withoutCategory });
  }
  return groups;
}

function formatMessageDateTime(createdAt: string, timeZone: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return createdAt;
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: "UTC"
    }).format(date);
  }
}

function avatarStyle(login: string) {
  return (element: HTMLSpanElement | null) => element?.style.setProperty("background", avatarColor(login));
}

export function ForwardMessageDialog({
  open,
  onClose,
  source,
  message,
  channels,
  categories,
  conversations,
  currentUserId,
  onForward,
  timeZone
}: ForwardMessageDialogProps) {
  const [selected, setSelected] = useState<ForwardDestination | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);

  // «Личные сообщения» идут первой группой, затем группы каналов в порядке
  // сайдбара. Источник-переписка и источник-канал из списка исключены.
  const groups = useMemo(() => {
    const conversationOptions: ForwardOption[] = conversations
      .filter((conversation) => !(source.kind === "conversation" && conversation.id === source.id))
      .map((conversation) => {
        const title = conversationTitle(conversation, currentUserId);
        return { kind: "conversation", id: conversation.id, name: title, avatarLogin: title } as const;
      });
    const channelGroups: ForwardGroup[] = groupSendableChannels(channels, categories)
      .map((group) => ({
        id: group.id ?? "__uncategorized__",
        name: group.name,
        options: group.channels
          .filter((channel) => !(source.kind === "channel" && channel.id === source.id))
          .map((channel) => ({ kind: "channel", id: channel.id, name: channel.name, avatarLogin: null }) as const)
      }))
      .filter((group) => group.options.length > 0);
    return conversationOptions.length > 0
      ? [{ id: "__conversations__", name: CONVERSATIONS_GROUP_NAME, options: conversationOptions }, ...channelGroups]
      : channelGroups;
  }, [categories, channels, conversations, currentUserId, source]);

  useEffect(() => {
    if (!open) return;
    setSelected(null);
    setErrorMessage(null);
    setIsSubmitting(false);
  }, [open]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (isSubmitting || selected === null) return;

    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      await onForward(selected);
    } catch {
      // Диалог остаётся открытым, выбранная цель сохраняется.
      setErrorMessage("Не удалось переслать сообщение. Попробуйте ещё раз.");
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleOptionKeyDown(event: KeyboardEvent<HTMLButtonElement>, option: ForwardDestination): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const options = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>(".forward-channel-option") ?? []);
      const currentIndex = options.indexOf(event.currentTarget);
      if (currentIndex < 0 || options.length === 0) return;
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : -1;
      const next = options[(currentIndex + offset + options.length) % options.length];
      next?.focus();
      const kind = next?.dataset.forwardKind;
      const id = next?.dataset.forwardId;
      if ((kind === "channel" || kind === "conversation") && id) setSelected({ kind, id });
      return;
    }
    if (event.key === "Enter") {
      // Enter выбирает цель и переводит фокус на кнопку «Переслать».
      event.preventDefault();
      setSelected(option);
      submitRef.current?.focus();
    }
  }

  const sourceName = source.kind === "channel"
    ? channels.find((channel) => channel.id === source.id)?.name ?? ""
    : (() => {
      const conversation = conversations.find((entry) => entry.id === source.id);
      return conversation ? conversationTitle(conversation, currentUserId) : "";
    })();
  const sourceLabel = source.kind === "channel" ? "Канал-источник" : "Переписка-источник";
  const previewTitle = `${sourceLabel}: ${sourceName}. Автор: ${message.authorLogin}. ${formatMessageDateTime(message.createdAt, timeZone)}`;

  return (
    <Modal
      open={open}
      onClose={() => { if (!isSubmitting) onClose(); }}
      labelledBy="forward-dialog-title"
      dialogClassName="modal-dialog forward-dialog"
    >
      <form onSubmit={(event) => void handleSubmit(event)} aria-busy={isSubmitting}>
        <h2 id="forward-dialog-title" className="settings-section-title" tabIndex={-1}>Переслать сообщение</h2>
        <div className="forward-preview" title={previewTitle}>
          {message.content}
        </div>
        {groups.length === 0 ? (
          <div className="forward-channel-empty">
            <p>Нет каналов или переписок, куда можно переслать.</p>
            <p>У вас нет права отправки ни в один канал и нет переписок.</p>
          </div>
        ) : (
          <div
            className="forward-channel-list"
            role="listbox"
            aria-label="Получатели"
            ref={listRef}
          >
            {groups.map((group) => (
              <div
                className="forward-channel-group"
                key={group.id}
                role="group"
                aria-label={group.name}
              >
                <p className="forward-channel-group-title" data-forward-group={group.name}>{group.name}</p>
                {group.options.map((option) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected?.kind === option.kind && selected.id === option.id}
                    className="forward-channel-option"
                    data-forward-kind={option.kind}
                    data-forward-id={option.id}
                    {...(option.kind === "channel" ? { "data-channel-id": option.id } : {})}
                    key={`${option.kind}:${option.id}`}
                    disabled={isSubmitting}
                    onClick={() => setSelected({ kind: option.kind, id: option.id })}
                    onKeyDown={(event) => handleOptionKeyDown(event, { kind: option.kind, id: option.id })}
                  >
                    {option.avatarLogin !== null && (
                      <span className="member-avatar" ref={avatarStyle(option.avatarLogin)} aria-hidden="true">
                        {initials(option.avatarLogin)}
                      </span>
                    )}
                    <span>{option.name}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
        {errorMessage && <p className="form-error" role="alert">{errorMessage}</p>}
        <div className="modal-actions forward-dialog-actions">
          <button type="button" className="btn btn-secondary" disabled={isSubmitting} onClick={onClose}>Отмена</button>
          <button
            ref={submitRef}
            type="submit"
            className="btn btn-primary"
            disabled={isSubmitting || selected === null}
            aria-busy={isSubmitting}
          >
            {isSubmitting ? "Пересылаем…" : "Переслать"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
