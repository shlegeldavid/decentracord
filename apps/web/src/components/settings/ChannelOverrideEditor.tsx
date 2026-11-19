import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  ApiError,
  createCategory,
  createChannel,
  deleteCategory as deleteCategoryRequest,
  getChannel,
  getChannels,
  getChannelSubjects,
  reorderCategories as reorderCategoriesRequest,
  renameCategory as renameCategoryRequest,
  renameChannel,
  updateChannelOverrides,
  type Channel,
  type ChannelCategory,
  type ChannelOverride,
  type ChannelSubject,
  type ChannelSubjects
} from "../../api";
import { CategoryDialog } from "../CategoryDialog";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { PERMISSION_LABELS } from "../../lib/permissions";

interface ChannelOverrideEditorProps {
  csrfToken: string;
  onError: (message: string) => void;
  onSessionExpired: () => void;
}

type OverrideSubject = {
  subject: "everyone" | "role" | "member";
  subjectId: string | null;
  label: string;
};

const permissions = Object.keys(PERMISSION_LABELS) as Array<keyof typeof PERMISSION_LABELS>;

export function requestError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "HIERARCHY") return "Действие недоступно из-за иерархии ролей.";
    if (error.code === "MISSING_PERMISSION") return "Нельзя выдать разрешение, которого нет у вас.";
    if (error.code === "INVALID_REQUEST" || error.status === 400) return "Проверьте введённые значения.";
    if (error.code === "FORBIDDEN" || error.status === 403) return "Недостаточно прав для этого действия.";
    if (error.code === "CHANNEL_ALREADY_EXISTS") return "Канал с таким названием уже существует.";
    if (error.code === "CHANNEL_NOT_FOUND") return "Канал больше недоступен. Обновите список каналов.";
    if (error.code === "CATEGORY_ALREADY_EXISTS") return "Категория с таким названием уже существует.";
    if (error.code === "CATEGORY_NOT_FOUND") return "Категория больше недоступна. Обновите список категорий.";
  }
  return "Не удалось выполнить запрос. Попробуйте ещё раз.";
}

function channelSubjects(value: ChannelSubjects): OverrideSubject[] {
  return [
    { subject: "everyone", subjectId: null, label: "@everyone" },
    ...value.roles.map((role: ChannelSubject) => ({ subject: "role" as const, subjectId: role.id, label: role.name })),
    ...value.members.map((member) => ({ subject: "member" as const, subjectId: member.id, label: member.login }))
  ];
}

function currentEffect(
  overrides: ChannelOverride[],
  subject: OverrideSubject,
  permission: string
): "allow" | "deny" | "unset" {
  return overrides.find((override) =>
    override.subject === subject.subject &&
    override.subjectId === subject.subjectId &&
    override.permission === permission
  )?.effect ?? "unset";
}

function sameOverrideSubject(override: ChannelOverride, subject: OverrideSubject, permission: string): boolean {
  return override.subject === subject.subject &&
    override.subjectId === subject.subjectId &&
    override.permission === permission;
}

function channelCountLabel(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  const word = last === 1 && lastTwo !== 11
    ? "канал"
    : last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)
      ? "канала"
      : "каналов";
  return `${count} ${word}`;
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
  const [categoryDialogMode, setCategoryDialogMode] = useState<"create" | "rename" | null>(null);
  const [categoryDialogTarget, setCategoryDialogTarget] = useState<ChannelCategory | null>(null);
  const [categoryDeleteTarget, setCategoryDeleteTarget] = useState<ChannelCategory | null>(null);
  const [categoryDeleteError, setCategoryDeleteError] = useState<string | undefined>(undefined);
  const [categoryOrderError, setCategoryOrderError] = useState<string | null>(null);
  const [isDeletingCategory, setIsDeletingCategory] = useState(false);
  const [isReorderingCategories, setIsReorderingCategories] = useState(false);

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
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else onError(requestError(error));
    }).finally(() => {
      if (active) setIsLoading(false);
    });
    return () => {
      active = false;
    };
  }, [onError, onSessionExpired]);

  useEffect(() => {
    if (!selectedChannelId) {
      setSelectedChannel(null);
      setOverrides([]);
      setHasPendingOverrides(false);
      setIsLoadingChannel(false);
      return;
    }
    let active = true;
    setIsLoadingChannel(true);
    setSelectedChannel(null);
    setOverrides([]);
    setHasPendingOverrides(false);
    void getChannel(selectedChannelId).then((detail) => {
      if (!active) return;
      setSelectedChannel(detail.channel);
      setOverrides(detail.overrides);
      setRenameValue(detail.channel.name);
    }).catch((error: unknown) => {
      if (!active) return;
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else onError(requestError(error));
    }).finally(() => {
      if (active) setIsLoadingChannel(false);
    });
    return () => {
      active = false;
    };
  }, [onError, onSessionExpired, selectedChannelId]);

  async function refreshChannels(): Promise<Channel[]> {
    const { channels: items, categories: categoryItems } = await getChannels();
    setChannels(items);
    setCategories(categoryItems);
    return items;
  }

  function closeCategoryDialog(): void {
    setCategoryDialogMode(null);
    setCategoryDialogTarget(null);
  }

  async function handleCategoryDialogSubmit(name: string): Promise<void> {
    if (!categoryDialogMode) return;
    try {
      if (categoryDialogMode === "create") {
        const created = await createCategory(name, csrfToken);
        setCategories((current) => [...current, created].sort((left, right) => left.position - right.position));
      } else if (categoryDialogTarget) {
        const updated = await renameCategoryRequest(categoryDialogTarget.id, name, csrfToken);
        setCategories((current) => current.map((category) => category.id === updated.id ? updated : category));
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      throw new Error(requestError(error));
    }
  }

  async function handleReorderCategory(categoryId: string, direction: -1 | 1): Promise<void> {
    if (isReorderingCategories) return;
    const current = categories;
    const index = current.findIndex((category) => category.id === categoryId);
    const destination = index + direction;
    if (index < 0 || destination < 0 || destination >= current.length) return;

    const next = [...current];
    [next[index], next[destination]] = [next[destination]!, next[index]!];
    setCategories(next);
    setCategoryOrderError(null);
    setIsReorderingCategories(true);
    try {
      await reorderCategoriesRequest(next.map((category) => category.id), csrfToken);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      setCategories(current);
      setCategoryOrderError("Не удалось сохранить порядок. Попробуйте ещё раз.");
    } finally {
      setIsReorderingCategories(false);
    }
  }

  async function handleDeleteCategory(): Promise<void> {
    const target = categoryDeleteTarget;
    if (!target) return;
    setCategoryDeleteError(undefined);
    setIsDeletingCategory(true);
    try {
      await deleteCategoryRequest(target.id, csrfToken);
      setCategories((current) => current.filter((category) => category.id !== target.id));
      setChannels((current) => current.map((channel) => channel.categoryId === target.id
        ? { ...channel, categoryId: null }
        : channel));
      setSelectedChannel((current) => current?.categoryId === target.id
        ? { ...current, categoryId: null }
        : current);
      setCategoryDeleteTarget(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      setCategoryDeleteError("Не удалось удалить категорию. Попробуйте ещё раз.");
    } finally {
      setIsDeletingCategory(false);
    }
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
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else onError(requestError(error));
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
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else onError(requestError(error));
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
    const nextOverrides: ChannelOverride[] = overrides
      .filter((override) => !sameOverrideSubject(override, subject, permission))
      .map((override) => ({ ...override, effect: override.effect }));
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
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else onError(requestError(error));
    } finally {
      setIsUpdatingOverrides(false);
    }
  }

  return (
    <section className="settings-card channel-settings" aria-label="Управление каналами">
      <p className="eyebrow">УПРАВЛЕНИЕ</p>
      <p className="settings-copy">Создавайте каналы, меняйте их названия и настраивайте доступ для участников.</p>
      {statusMessage && <p className="form-success" aria-live="polite">{statusMessage}</p>}

      <section className="settings-category-section" aria-label="Категории" aria-busy={isLoading || isReorderingCategories}>
        <h3>Категории</h3>
        <button
          type="button"
          className="btn-primary settings-category-create"
          onClick={() => {
            setCategoryDialogTarget(null);
            setCategoryDialogMode("create");
          }}
        >
          Создать категорию
        </button>
        {categoryOrderError && <p className="channel-dialog-error" role="alert">{categoryOrderError}</p>}
        {isLoading ? (
          <p className="loading-copy" aria-live="polite">Загружаем категории…</p>
        ) : categories.length === 0 ? (
          <p className="settings-category-empty">Категорий пока нет.</p>
        ) : (
          <div className="settings-category-list">
            {categories.map((category, index) => (
              <div className="settings-category-row" data-category-id={category.id} key={category.id}>
                <span className="settings-category-count">
                  {channelCountLabel(channels.filter((channel) => channel.categoryId === category.id).length)}
                </span>
                <span className="channel-category-name">{category.name}</span>
                <span aria-hidden="true" />
                <div className="settings-category-order">
                  <button
                    type="button"
                    disabled={isReorderingCategories || index === 0}
                    onClick={() => void handleReorderCategory(category.id, -1)}
                  >
                    Выше
                  </button>
                  <button
                    type="button"
                    disabled={isReorderingCategories || index === categories.length - 1}
                    onClick={() => void handleReorderCategory(category.id, 1)}
                  >
                    Ниже
                  </button>
                </div>
                <button
                  type="button"
                  disabled={isReorderingCategories}
                  onClick={() => {
                    setCategoryDialogTarget(category);
                    setCategoryDialogMode("rename");
                  }}
                >
                  Переименовать
                </button>
                <button
                  type="button"
                  className="button-danger"
                  disabled={isDeletingCategory || isReorderingCategories}
                  onClick={() => {
                    setCategoryDeleteError(undefined);
                    setCategoryDeleteTarget(category);
                  }}
                >
                  Удалить
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

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
                <div className="override-grid" aria-busy={isUpdatingOverrides}>
                  <h3>Переопределения доступа</h3>
                  <p className="settings-copy">Состояние «Не задано» наследует базовые разрешения роли.</p>
                  {subjects.map((subject) => (
                    <section className="override-subject" key={`${subject.subject}:${subject.subjectId ?? "everyone"}`}>
                      <h4>{subject.label}</h4>
                      {permissions.map((permission) => {
                        const id = `override-${selectedChannel.id}-${subject.subject}-${subject.subjectId ?? "everyone"}-${permission}`;
                        const administratorPermission = permission === "ADMINISTRATOR";
                        const effect = currentEffect(overrides, subject, permission);
                        return (
                          <div className="override-row" key={permission}>
                            <label htmlFor={id}>{PERMISSION_LABELS[permission]}</label>
                            <select
                              className="override-cell"
                              id={id}
                              aria-label={`${permission} для ${subject.label}`}
                              data-state={effect}
                              disabled={administratorPermission || isUpdatingOverrides}
                              value={administratorPermission ? "unset" : effect}
                              onChange={(event) => void handleOverrideChange(
                                subject,
                                permission,
                                event.currentTarget.value as "allow" | "deny" | "unset"
                              )}
                            >
                              <option value="unset">Не задано</option>
                              <option value="allow">Разрешить</option>
                              <option value="deny">Запретить</option>
                            </select>
                            {administratorPermission && (
                              <p className="override-note">Выдаётся только владельцем установки в базовых правах роли.</p>
                            )}
                          </div>
                        );
                      })}
                    </section>
                  ))}
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={isUpdatingOverrides || !hasPendingOverrides}
                    onClick={() => void handleSaveOverrides()}
                  >
                    {isUpdatingOverrides ? "Сохраняем…" : "Сохранить переопределения"}
                  </button>
                </div>
              ) : (
                <p className="settings-copy">Переопределения доступа не отображаются для этого канала.</p>
              )}
            </>
          ) : null}
        </div>
      )}

      <CategoryDialog
        open={categoryDialogMode !== null}
        onClose={closeCategoryDialog}
        mode={categoryDialogMode ?? "create"}
        {...(categoryDialogTarget ? { initialName: categoryDialogTarget.name } : {})}
        onSubmit={handleCategoryDialogSubmit}
        onError={onError}
      />
      <ConfirmDialog
        open={categoryDeleteTarget !== null}
        title={`Удалить категорию «${categoryDeleteTarget?.name ?? ""}»`}
        description="Каналы этой категории перейдут в раздел «Без категории». Переписка не пропадёт."
        confirmCheckboxLabel="Подтверждаю удаление категории и перенос её каналов в «Без категории»"
        confirmLabel="Удалить"
        onConfirm={handleDeleteCategory}
        onCancel={() => {
          if (isDeletingCategory) return;
          setCategoryDeleteTarget(null);
          setCategoryDeleteError(undefined);
        }}
        busy={isDeletingCategory}
        {...(categoryDeleteError ? { errorMessage: categoryDeleteError } : {})}
      />
    </section>
  );
}
