import { useState } from "react";
import type { ChannelOverride, OverrideEffect } from "../api";
import { PERMISSION_LABELS } from "../lib/permissions";

export interface ChannelPermissionSubject {
  subject: "everyone" | "role" | "member";
  subjectId: string | null;
  label: string;
}

interface ChannelPermissionGridProps {
  subjects: ChannelPermissionSubject[];
  overrides: ChannelOverride[];
  disabled?: boolean;
  onChange: (overrides: ChannelOverride[]) => void;
}

const permissions = ["VIEW_CHANNEL", "SEND_MESSAGES", "MANAGE_MESSAGES"] as const;
const states: Array<{ value: OverrideEffect; label: string }> = [
  { value: "unset", label: "Не задано" },
  { value: "allow", label: "Разрешить" },
  { value: "deny", label: "Запретить" }
];

function subjectKey(subject: ChannelPermissionSubject): string {
  return subject.subject === "everyone" ? "everyone" : `${subject.subject}:${subject.subjectId}`;
}

function getEffect(
  overrides: ChannelOverride[],
  subject: ChannelPermissionSubject,
  permission: string
): OverrideEffect {
  return overrides.find((override) =>
    override.subject === subject.subject &&
    override.subjectId === subject.subjectId &&
    override.permission === permission
  )?.effect ?? "unset";
}

export function ChannelPermissionGrid({ subjects, overrides, disabled = false, onChange }: ChannelPermissionGridProps) {
  const [subjectId, setSubjectId] = useState("everyone");
  const selectedSubject = subjects.find((subject) => subjectKey(subject) === subjectId) ?? subjects[0];

  function update(subject: ChannelPermissionSubject, permission: typeof permissions[number], effect: OverrideEffect): void {
    const next = overrides.filter((override) => !(
      override.subject === subject.subject &&
      override.subjectId === subject.subjectId &&
      override.permission === permission
    ));
    if (effect !== "unset") {
      next.push({
        subject: subject.subject,
        subjectId: subject.subjectId,
        permission,
        effect
      });
    }
    onChange(next);
  }

  return (
    <section className="channel-permission-section" aria-label="Права доступа">
      <h3>Права доступа</h3>
      {selectedSubject && (
        <>
          <label className="permission-editor-subject">
            Роль или участник
            <select value={subjectKey(selectedSubject)} onChange={(event) => setSubjectId(event.currentTarget.value)}>
              {subjects.filter((subject) => subject.subject === "everyone").map((subject) => (
                <option key={subjectKey(subject)} value={subjectKey(subject)}>{subject.label}</option>
              ))}
              <optgroup label="Роли">
                {subjects.filter((subject) => subject.subject === "role").map((subject) => (
                  <option key={subjectKey(subject)} value={subjectKey(subject)}>{subject.label}</option>
                ))}
              </optgroup>
              <optgroup label="Участники">
                {subjects.filter((subject) => subject.subject === "member").map((subject) => (
                  <option key={subjectKey(subject)} value={subjectKey(subject)}>{subject.label}</option>
                ))}
              </optgroup>
            </select>
          </label>
          <div className="permission-editor-list">
            {permissions.map((permission) => {
              const effect = getEffect(overrides, selectedSubject, permission);
              return (
                <label className="permission-editor-row" key={permission}>
                  <span>{PERMISSION_LABELS[permission]}</span>
                  <select
                    className="override-cell"
                    data-state={effect}
                    aria-label={`${selectedSubject.label}: ${PERMISSION_LABELS[permission]}`}
                    value={effect}
                    disabled={disabled}
                    onChange={(event) => update(selectedSubject, permission, event.currentTarget.value as OverrideEffect)}
                  >
                    {states.map((state) => <option key={state.value} value={state.value}>{state.label}</option>)}
                  </select>
                </label>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
