import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  ApiError,
  createChannel,
  getChannel,
  getChannels,
  getChannelSubjects,
  renameChannel,
  updateChannelOverrides,
  type Channel,
  type ChannelCategory,
  type ChannelOverride,
  type ChannelSubject,
  type ChannelSubjects
} from "../../api";
import { ChannelCategorySettings } from "./ChannelCategorySettings";
import { ChannelPermissionGrid, matchesOverride, type OverrideSubject } from "./ChannelPermissionGrid";

interface ChannelOverrideEditorProps {
  csrfToken: string;
  onError: (message: string) => void;
  onSessionExpired: () => void;
}

const permissionErrors = new Map([
  ["HIERARCHY", "Действие недоступно из-за иерархии ролей."],
  ["MISSING_PERMISSION", "Нельзя выдать разрешение, которого нет у вас."]
]);
const channelErrors = new Map([
  ["CHANNEL_ALREADY_EXISTS", "Канал с таким названием уже существует."],
  ["CHANNEL_NOT_FOUND", "Канал больше недоступен. Обновите список каналов."],
  ["CATEGORY_ALREADY_EXISTS", "Категория с таким названием уже существует."],
  ["CATEGORY_NOT_FOUND", "Категория больше недоступна. Обновите список категорий."]
]);

export function requestError(error: unknown): string {
  const fallback = "Не удалось выполнить запрос. Попробуйте ещё раз.";
  if (!(error instanceof ApiError)) return fallback;
  const permissionError = permissionErrors.get(error.code);
  if (permissionError) return permissionError;
  if (error.code === "INVALID_REQUEST" || error.status === 400) return "Проверьте введённые значения.";
  if (error.code === "FORBIDDEN" || error.status === 403) return "Недостаточно прав для этого действия.";
  return channelErrors.get(error.code) ?? fallback;
}

function channelSubjects(value: ChannelSubjects): OverrideSubject[] {
  return [
    { subject: "everyone", subjectId: null, label: "@everyone" },
    ...value.roles.map((role: ChannelSubject) => ({ subject: "role" as const, subjectId: role.id, label: role.name })),
    ...value.members.map((member) => ({ subject: "member" as const, subjectId: member.id, label: member.login }))
  ];
}

export function ChannelOverrideEditor({ csrfToken, onError, onSessionExpired }: ChannelOverrideEditorProps) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [categories, setCategories] = useState<ChannelCategory[]>([]);
  const [subjects, setSubjects] = useState<OverrideSubject[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null);
  const [overrides, setOverrides] = useState<ChannelOverride[]>([]);
  const [hasPendingOverrides, setHasPendingOverrides] = useState(false);
  const [newChannelName, setNewChannelName] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingChannel, setIsLoadingChannel] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [isUpdatingOverrides, setIsUpdatingOverrides] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const handleRequestError = useCallback((error: unknown, report = false): string => {
    const message = requestError(error);
    if (error instanceof ApiError && error.status === 401) onSessionExpired();
    else if (report) onError(message);
    return message;
  }, [onError, onSessionExpired]);

  useEffect(() => {
    let active = true;
    void Promise.all([getChannels(), getChannelSubjects()]).then(([channelData, subjectData]) => {
      if (!active) return;
      setChannels(channelData.channels);
      setCategories(channelData.categories);
      setSubjects(channelSubjects(subjectData));
      setSelectedChannelId(channelData.channels[0]?.id ?? null);
    }).catch((error: unknown) => {
      if (!active) return;
      handleRequestError(error, true);
    }).finally(() => {
      if (active) setIsLoading(false);
    });
    return () => {
      active = false;
    };
  }, [handleRequestError]);

  useEffect(() => {
    setIsLoadingChannel(Boolean(selectedChannelId));
    setSelectedChannel(null);
    setOverrides([]);
    setHasPendingOverrides(false);
    if (!selectedChannelId) return;
    let active = true;
    void getChannel(selectedChannelId).then((detail) => {
      if (!active) return;
      setSelectedChannel(detail.channel);
      setOverrides(detail.overrides);
      setRenameValue(detail.channel.name);
    }).catch((error: unknown) => {
      if (!active) return;
      handleRequestError(error, true);
    }).finally(() => {
      if (active) setIsLoadingChannel(false);
    });
    return () => {
      active = false;
    };
  }, [handleRequestError, selectedChannelId]);

  async function refreshChannels(): Promise<Channel[]> {
    const { channels: items, categories: categoryItems } = await getChannels();
    setChannels(items);
    setCategories(categoryItems);
    return items;
  }

  function handleCategoryDeleted(categoryId: string): void {
    setChannels((current) => current.map((channel) => channel.categoryId === categoryId
      ? { ...channel, categoryId: null }
      : channel));
    setSelectedChannel((current) => current?.categoryId === categoryId
      ? { ...current, categoryId: null }
      : current);
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setStatusMessage(null);
    setIsCreating(true);
    try {
      const created = await createChannel(newChannelName, csrfToken);
      const items = await refreshChannels();
      setSelectedChannelId(items.some((item) => item.id === created.id) ? created.id : null);
      setNewChannelName("");
      setStatusMessage(`Канал «${created.name}» создан.`);
    } catch (error) {
      handleRequestError(error, true);
    } finally {
      setIsCreating(false);
    }
  }

  async function handleRename(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!selectedChannel) return;
    setStatusMessage(null);
    setIsRenaming(true);
    try {
      const updated = await renameChannel(selectedChannel.id, renameValue, csrfToken);
      setSelectedChannel(updated);
      setRenameValue(updated.name);
      setChannels((current) => current.map((channel) => channel.id === updated.id ? updated : channel));
      setEditingName(false);
      setStatusMessage(`Название канала изменено на «${updated.name}».`);
    } catch (error) {
      handleRequestError(error, true);
    } finally {
      setIsRenaming(false);
    }
  }

  function handleOverrideChange(
    subject: OverrideSubject,
    permission: string,
    effect: "allow" | "deny" | "unset"
  ): void {
    if (!selectedChannel) return;
    setStatusMessage(null);
    const nextOverrides = overrides.filter((override) => !matchesOverride(override, subject, permission));
    nextOverrides.push({ subject: subject.subject, subjectId: subject.subjectId, permission, effect });
    setOverrides(nextOverrides);
    setHasPendingOverrides(true);
  }

  async function handleSaveOverrides(): Promise<void> {
    if (!selectedChannel || !hasPendingOverrides) return;
    setIsUpdatingOverrides(true);
    try {
      await updateChannelOverrides(selectedChannel.id, overrides, csrfToken);
      const detail = await getChannel(selectedChannel.id);
      setSelectedChannel(detail.channel);
      setOverrides(detail.overrides);
      setHasPendingOverrides(false);
      setChannels((current) => current.map((channel) => channel.id === detail.channel.id ? detail.channel : channel));
      setStatusMessage("Переопределения доступа сохранены.");
    } catch (error) {
      handleRequestError(error, true);
    } finally {
      setIsUpdatingOverrides(false);
    }
  }

  return (
    <section className="settings-card channel-settings" aria-label="Управление каналами">
      <p className="eyebrow">УПРАВЛЕНИЕ</p>
      <p className="settings-copy">Создавайте каналы, меняйте их названия и настраивайте доступ для участников.</p>
      {statusMessage && <p className="form-success" aria-live="polite">{statusMessage}</p>}

      <ChannelCategorySettings
        categories={categories}
        channels={channels}
        setCategories={setCategories}
        csrfToken={csrfToken}
        isLoading={isLoading}
        onDeleteCategory={handleCategoryDeleted}
        onRequestError={handleRequestError}
        onError={onError}
      />

      <form onSubmit={(event) => void handleCreate(event)} aria-busy={isCreating} data-channel-create-form>
        <label htmlFor="new-channel-name">Название канала</label>
        <input
          autoComplete="off"
          id="new-channel-name"
          maxLength={80}
          required
          value={newChannelName}
          onChange={(event) => setNewChannelName(event.currentTarget.value)}
        />
        <button type="submit" disabled={isCreating}>{isCreating ? "Создаём…" : "Создать канал"}</button>
      </form>

      <div className="channel-list" data-scope="channels-page" aria-live="polite" aria-busy={isLoading}>
        <h3>Список каналов</h3>
        {isLoading ? (
          <p className="loading-copy" aria-live="polite">Загружаем каналы…</p>
        ) : channels.length === 0 ? (
          <p className="settings-copy">Доступных каналов пока нет.</p>
        ) : (
          <ul>
            {channels.map((channel) => (
              <li key={channel.id} data-channel-id={channel.id}>
                <button
                  type="button"
                  className="channel-list-select"
                  aria-current={selectedChannelId === channel.id ? "true" : undefined}
                  disabled={isUpdatingOverrides}
                  onClick={() => {
                    setStatusMessage(null);
                    setSelectedChannelId(channel.id);
                  }}
                >
                  <span>{channel.name}</span>
                  {channel.canView && !channel.canSend && <span className="channel-state channel-state-readonly">Только для чтения</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selectedChannelId && (
        <div className="channel-details" aria-live="polite" aria-busy={isLoadingChannel || isRenaming || isUpdatingOverrides}>
          {isLoadingChannel ? (
            <p className="loading-copy" aria-live="polite">Загружаем настройки канала…</p>
          ) : selectedChannel ? (
            <>
              <div className="channel-heading">
                {editingName ? (
                  <form onSubmit={(event) => void handleRename(event)} aria-busy={isRenaming}>
                    <label htmlFor={`rename-channel-${selectedChannel.id}`}>Название канала</label>
                    <input
                      autoComplete="off"
                      id={`rename-channel-${selectedChannel.id}`}
                      maxLength={80}
                      required
                      value={renameValue}
                      onChange={(event) => setRenameValue(event.currentTarget.value)}
                    />
                    <div className="channel-actions">
                      <button type="submit" disabled={isRenaming}>{isRenaming ? "Сохраняем…" : "Сохранить название канала"}</button>
                      <button type="button" disabled={isRenaming} onClick={() => {
                        setRenameValue(selectedChannel.name);
                        setEditingName(false);
                      }}>Отмена</button>
                    </div>
                  </form>
                ) : (
                  <>
                    <div>
                      <h3>{selectedChannel.name}</h3>
                      {selectedChannel.canView && !selectedChannel.canSend && (
                        <span className="channel-state channel-state-readonly">Только для чтения</span>
                      )}
                    </div>
                    <button type="button" onClick={() => {
                      setRenameValue(selectedChannel.name);
                      setEditingName(true);
                    }}>Переименовать</button>
                  </>
                )}
              </div>

              {selectedChannel.ownerEditable ? (
                <ChannelPermissionGrid
                  channelId={selectedChannel.id}
                  subjects={subjects}
                  overrides={overrides}
                  isUpdatingOverrides={isUpdatingOverrides}
                  hasPendingOverrides={hasPendingOverrides}
                  onChange={handleOverrideChange}
                  onSave={handleSaveOverrides}
                />
              ) : (
                <p className="settings-copy">Переопределения доступа не отображаются для этого канала.</p>
              )}
            </>
          ) : null}
        </div>
      )}

    </section>
  );
}
