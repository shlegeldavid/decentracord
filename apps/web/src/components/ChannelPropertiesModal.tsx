import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  ApiError,
  getChannel,
  getChannelSubjects,
  updateChannelOverrides,
  updateChannelProperties,
  type Channel,
  type ChannelCategory,
  type ChannelOverride,
  type ChannelSubject
} from "../api";
import { requestError } from "./settings/ChannelOverrideEditor";
import { ChannelPermissionGrid, type ChannelPermissionSubject } from "./ChannelPermissionGrid";
import { Modal } from "./ui/Modal";

interface ChannelPropertiesModalProps {
  open: boolean;
  channelId: string;
  categories: ChannelCategory[];
  csrfToken: string;
  canManage: boolean;
  onClose: () => void;
  onSessionExpired: () => void;
  onSaved: (channel: Channel) => void;
}

interface LoadedChannel {
  channel: Channel;
  subjects: ChannelPermissionSubject[];
}

function toPermissionSubjects(roles: ChannelSubject[], members: Array<{ id: string; login: string }>): ChannelPermissionSubject[] {
  return [
    { subject: "everyone", subjectId: null, label: "@everyone" },
    ...roles.map((role) => ({ subject: "role" as const, subjectId: role.id, label: role.name })),
    ...members.map((member) => ({ subject: "member" as const, subjectId: member.id, label: member.login }))
  ];
}

export function ChannelPropertiesModal({
  open,
  channelId,
  categories,
  csrfToken,
  canManage,
  onClose,
  onSessionExpired,
  onSaved
}: ChannelPropertiesModalProps) {
  const [loaded, setLoaded] = useState<LoadedChannel | null>(null);
  const [overrides, setOverrides] = useState<ChannelOverride[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"hidden" | "known">("hidden");
  const [categoryId, setCategoryId] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const disabled = !canManage || isSaving;

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoaded(null);
    setOverrides([]);
    setIsLoading(true);
    setError(null);
    setSuccess(null);
    void Promise.all([getChannel(channelId), getChannelSubjects()]).then(([detail, subjects]) => {
      if (!active) return;
      setLoaded({ channel: detail.channel, subjects: toPermissionSubjects(subjects.roles, subjects.members) });
      setOverrides(detail.overrides.map((override) => ({ ...override, effect: override.effect })));
      setName(detail.channel.name);
      setDescription(detail.channel.description ?? "");
      setVisibility(detail.channel.visibility);
      setCategoryId(detail.channel.categoryId ?? "");
    }).catch((loadError: unknown) => {
      if (!active) return;
      if (loadError instanceof ApiError && loadError.status === 401) {
        onSessionExpired();
        return;
      }
      setError(requestError(loadError));
    }).finally(() => {
      if (active) setIsLoading(false);
    });
    return () => { active = false; };
  }, [channelId, onSessionExpired, open]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canManage || isSaving || !loaded) return;
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const updated = await updateChannelProperties(channelId, {
        name,
        description: description.length === 0 ? null : description,
        visibility,
        categoryId: categoryId === "" ? null : categoryId
      }, csrfToken);
      await updateChannelOverrides(channelId, overrides.filter((override) => override.effect !== "unset"), csrfToken);
      onSaved(updated);
      setLoaded((current) => current ? { ...current, channel: updated } : current);
      setSuccess("Свойства канала сохранены.");
    } catch (saveError) {
      if (saveError instanceof ApiError && saveError.status === 401) {
        onSessionExpired();
        return;
      }
      setError(requestError(saveError));
    } finally {
      setIsSaving(false);
    }
  }

  const characterCount = Array.from(description).length;

  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy="channel-properties-title"
      dialogClassName="modal-dialog channel-properties-modal"
    >
      <h2 id="channel-properties-title" className="settings-section-title" tabIndex={-1}>Свойства канала</h2>
      {isLoading && <p className="settings-copy">Загружаем свойства канала…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {!isLoading && loaded && (
        <form onSubmit={(event) => void handleSubmit(event)} aria-busy={isSaving}>
          {!canManage && (
            <p className="settings-copy">
              Просмотр свойств канала. Изменять их может участник с правом «Управлять каналами».
            </p>
          )}
          <div className="channel-properties-grid">
            <label htmlFor="channel-properties-name">Название канала</label>
            <input
              id="channel-properties-name"
              className="input"
              type="text"
              required
              maxLength={80}
              value={name}
              disabled={disabled}
              onChange={(event) => setName(event.currentTarget.value)}
            />

            <label htmlFor="channel-properties-description">Описание канала</label>
            <div className="channel-description-field">
              <textarea
                id="channel-properties-description"
                className="textarea"
                maxLength={1024}
                value={description}
                disabled={disabled}
                onChange={(event) => setDescription(event.currentTarget.value)}
              />
              <span className={`channel-character-counter${characterCount > 921 ? " is-danger" : ""}`}>
                {characterCount}/1024
              </span>
            </div>

            <span id="channel-properties-visibility-label">Режим видимости</span>
            <fieldset className="channel-visibility-options" aria-labelledby="channel-properties-visibility-label" disabled={disabled}>
              <label className="channel-visibility-option">
                <input
                  type="radio"
                  name="channel-visibility"
                  value="hidden"
                  checked={visibility === "hidden"}
                  onChange={() => setVisibility("hidden")}
                />
                <span>
                  <strong>Скрыт от участников без права чтения</strong>
                  <small>Канал не виден тем, у кого нет права «Видеть канал».</small>
                </span>
              </label>
              <label className="channel-visibility-option">
                <input
                  type="radio"
                  name="channel-visibility"
                  value="known"
                  checked={visibility === "known"}
                  onChange={() => setVisibility("known")}
                />
                <span>
                  <strong>Известен всем, но закрыт</strong>
                  <small>Название канала видно всем участникам организации, но войти и читать его могут только участники с правом «Видеть канал». Описание остаётся скрытым от тех, у кого этого права нет.</small>
                </span>
              </label>
            </fieldset>

            <label htmlFor="channel-properties-category">Категория</label>
            <select
              id="channel-properties-category"
              className="select"
              value={categoryId}
              disabled={disabled}
              onChange={(event) => setCategoryId(event.currentTarget.value)}
            >
              <option value="">Без категории</option>
              {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
            </select>

            <ChannelPermissionGrid
              subjects={loaded.subjects}
              overrides={overrides}
              disabled={disabled}
              onChange={setOverrides}
            />
          </div>
          {success && <p className="form-success" aria-live="polite">{success}</p>}
          <div className="modal-actions">
            <button type="button" className="btn-secondary" disabled={isSaving} onClick={onClose}>
              {canManage ? "Отмена" : "Закрыть"}
            </button>
            {canManage && (
              <button type="submit" className="btn-primary" disabled={isSaving}>
                {isSaving ? "Сохраняем…" : "Сохранить свойства канала"}
              </button>
            )}
          </div>
        </form>
      )}
      {!isLoading && !loaded && !error && <p className="settings-copy">Не удалось загрузить свойства канала.</p>}
    </Modal>
  );
}
