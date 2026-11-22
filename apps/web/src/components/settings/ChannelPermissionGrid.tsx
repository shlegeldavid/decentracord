import type { ChannelOverride } from "../../api";
import { PERMISSION_LABELS } from "../../lib/permissions";

export type OverrideSubject = Pick<ChannelOverride, "subject" | "subjectId"> & { label: string };

const permissions = Object.keys(PERMISSION_LABELS) as Array<keyof typeof PERMISSION_LABELS>;

export function matchesOverride(override: ChannelOverride, subject: OverrideSubject, permission: string): boolean {
  return override.subject === subject.subject &&
    override.subjectId === subject.subjectId &&
    override.permission === permission;
}

interface ChannelPermissionGridProps {
  channelId: string;
  subjects: OverrideSubject[];
  overrides: ChannelOverride[];
  isUpdatingOverrides: boolean;
  hasPendingOverrides: boolean;
  onChange: (subject: OverrideSubject, permission: string, effect: ChannelOverride["effect"]) => void;
  onSave: () => Promise<void>;
}

export function ChannelPermissionGrid({
  channelId,
  subjects,
  overrides,
  isUpdatingOverrides,
  hasPendingOverrides,
  onChange,
  onSave
}: ChannelPermissionGridProps) {
  return (
    <div className="override-grid" aria-busy={isUpdatingOverrides}>
      <h3>Переопределения доступа</h3>
      <p className="settings-copy">Состояние «Не задано» наследует базовые разрешения роли.</p>
      {subjects.map((subject) => (
        <section className="override-subject" key={`${subject.subject}:${subject.subjectId ?? "everyone"}`}>
          <h4>{subject.label}</h4>
          {permissions.map((permission) => {
            const id = `override-${channelId}-${subject.subject}-${subject.subjectId ?? "everyone"}-${permission}`;
            const administratorPermission = permission === "ADMINISTRATOR";
            const effect = overrides.find((item) => matchesOverride(item, subject, permission))?.effect ?? "unset";
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
                  onChange={(event) => void onChange(
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
        onClick={() => void onSave()}
      >
        {isUpdatingOverrides ? "Сохраняем…" : "Сохранить переопределения"}
      </button>
    </div>
  );
}
