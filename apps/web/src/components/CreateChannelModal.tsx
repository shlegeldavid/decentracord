import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  ApiError,
  getChannelSubjects,
  type ChannelCategory,
  type ChannelMemberSubject,
  type ChannelOverride,
  type ChannelSubject,
  type CreateChannelInput
} from "../api";
import { ChannelPermissionGrid, type ChannelPermissionSubject } from "./ChannelPermissionGrid";
import { requestError } from "./settings/ChannelOverrideEditor";
import { Modal } from "./ui/Modal";

interface CreateChannelModalProps {
  open: boolean;
  category: ChannelCategory | null;
  onClose: () => void;
  onCreate: (input: CreateChannelInput) => Promise<void>;
  onSessionExpired: () => void;
}

const initialOverrides: ChannelOverride[] = [
  { subject: "everyone", subjectId: null, permission: "VIEW_CHANNEL", effect: "allow" },
  { subject: "everyone", subjectId: null, permission: "SEND_MESSAGES", effect: "allow" }
];

function permissionSubjects(roles: ChannelSubject[], members: ChannelMemberSubject[]): ChannelPermissionSubject[] {
  return [
    { subject: "everyone", subjectId: null, label: "@everyone" },
    ...roles.map((role) => ({ subject: "role" as const, subjectId: role.id, label: role.name })),
    ...members.map((member) => ({ subject: "member" as const, subjectId: member.id, label: member.login }))
  ];
}

function createErrorMessage(error: unknown): string {
  const message = requestError(error);
  return message === "Не удалось выполнить запрос. Попробуйте ещё раз."
    ? "Не удалось создать канал. Попробуйте ещё раз."
    : message;
}

export function CreateChannelModal({
  open,
  category,
  onClose,
  onCreate,
  onSessionExpired
}: CreateChannelModalProps) {
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [subjects, setSubjects] = useState<ChannelPermissionSubject[]>([
    { subject: "everyone", subjectId: null, label: "@everyone" }
  ]);
  const [overrides, setOverrides] = useState<ChannelOverride[]>(initialOverrides);
  const [isPrivate, setIsPrivate] = useState(false);
  const [isLoadingSubjects, setIsLoadingSubjects] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setName("");
    setDescription("");
    setOverrides(initialOverrides.map((override) => ({ ...override })));
    setIsPrivate(false);
    setError(null);
    setIsLoadingSubjects(true);
    void getChannelSubjects().then((result) => {
      if (active) setSubjects(permissionSubjects(result.roles, result.members));
    }).catch((loadError: unknown) => {
      if (!active) return;
      if (loadError instanceof ApiError && loadError.status === 401) {
        onSessionExpired();
        return;
      }
      setError(createErrorMessage(loadError));
    }).finally(() => {
      if (active) setIsLoadingSubjects(false);
    });
    return () => {
      active = false;
    };
  }, [onSessionExpired, open]);

  function updateOverrides(next: ChannelOverride[]): void {
    setOverrides(next);
    const everyoneView = next.find((override) =>
      override.subject === "everyone" && override.subjectId === null && override.permission === "VIEW_CHANNEL"
    );
    setIsPrivate(everyoneView?.effect === "deny");
  }

  function setPrivate(value: boolean): void {
    const next = overrides.filter((override) => !(
      override.subject === "everyone" && override.subjectId === null && override.permission === "VIEW_CHANNEL"
    ));
    next.push({
      subject: "everyone",
      subjectId: null,
      permission: "VIEW_CHANNEL",
      effect: value ? "deny" : "allow"
    });
    setIsPrivate(value);
    setOverrides(next);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (isSubmitting || isLoadingSubjects) return;

    const channelName = name.trim();
    const nameLength = Array.from(channelName).length;
    if (nameLength < 1 || nameLength > 80) {
      setError("Название канала должно содержать от 1 до 80 символов.");
      return;
    }
    if (Array.from(description).length > 1024 || description.includes("\u0000")) {
      setError("Тема канала не длиннее 1024 символов.");
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      await onCreate({
        name: channelName,
        description: description.length === 0 ? null : description,
        categoryId: category?.id ?? null,
        overrides
      });
      onClose();
    } catch (createError: unknown) {
      if (createError instanceof ApiError && createError.status === 401) {
        onSessionExpired();
        return;
      }
      setError(createErrorMessage(createError));
    } finally {
      setIsSubmitting(false);
    }
  }

  const characterCount = Array.from(description).length;
  const busy = isSubmitting || isLoadingSubjects;

  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy="create-channel-title"
      describedBy="create-channel-location"
      initialFocusRef={nameRef}
      dialogClassName="modal-dialog channel-create-modal"
    >
      <h2 id="create-channel-title" className="settings-section-title">Создать канал</h2>
      <p id="create-channel-location" className="channel-create-location">
        {category
          ? `Канал появится в категории «${category.name}»`
          : "Канал появится в разделе «Без категории»"}
      </p>
      <form className="channel-create-form" onSubmit={(event) => void handleSubmit(event)} aria-busy={busy}>
        <label className="channel-create-field" htmlFor="create-channel-name">
          <span>Название канала</span>
          <input
            ref={nameRef}
            id="create-channel-name"
            className="input"
            type="text"
            required
            maxLength={80}
            value={name}
            placeholder="Например, отдел продаж"
            disabled={busy}
            onChange={(event) => {
              setName(event.currentTarget.value);
              setError(null);
            }}
          />
        </label>

        <label className="channel-create-field" htmlFor="create-channel-description">
          <span>Тема канала</span>
          <textarea
            id="create-channel-description"
            className="textarea"
            maxLength={1024}
            value={description}
            placeholder="О чём этот канал"
            disabled={busy}
            onChange={(event) => {
              setDescription(event.currentTarget.value);
              setError(null);
            }}
          />
          <span className="channel-create-character-count">{characterCount}/1024</span>
        </label>

        <div className="channel-create-privacy">
          <label className="channel-private-toggle" htmlFor="create-channel-private">
            <input
              id="create-channel-private"
              type="checkbox"
              role="switch"
              aria-describedby="create-channel-private-help"
              checked={isPrivate}
              disabled={busy}
              onChange={(event) => setPrivate(event.currentTarget.checked)}
            />
            <span className="channel-private-control" aria-hidden="true" />
            <span>Приватный канал</span>
          </label>
          <p id="create-channel-private-help" className="channel-create-hint">
            Канал виден только тем, у кого есть право «Видеть канал».
          </p>
        </div>

        <div className="channel-create-permissions">
          <p className="channel-create-hint">
            Состояние «Не задано» наследует базовые разрешения роли.
          </p>
          {isLoadingSubjects && <p className="channel-create-hint" role="status" aria-live="polite">Загружаем участников…</p>}
          {!isLoadingSubjects && (
            <ChannelPermissionGrid
              subjects={subjects}
              overrides={overrides}
              disabled={isSubmitting}
              onChange={updateOverrides}
            />
          )}
        </div>

        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="modal-actions channel-create-actions">
          <button type="button" className="btn btn-secondary" disabled={isSubmitting} onClick={onClose}>Отмена</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {isSubmitting ? "Создаём…" : "Создать канал"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
