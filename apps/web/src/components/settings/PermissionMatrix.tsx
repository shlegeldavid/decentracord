import { useId, useState } from "react";
import { PERMISSION_LABELS, PERMISSION_STATES } from "../../lib/permissions";
import type { Role } from "../../api";

type Permission = keyof typeof PERMISSION_LABELS;

interface PermissionMatrixProps {
  roles: Role[];
  isLoading?: boolean;
  onChange: (roleId: string, permissions: string[]) => void;
  busyRoleId: string | null;
}

const permissions = Object.keys(PERMISSION_LABELS) as Permission[];

export function PermissionMatrix({ roles, isLoading = false, onChange, busyRoleId }: PermissionMatrixProps) {
  const roleLabelId = useId();
  const [roleId, setRoleId] = useState("");
  const role = roles.find((candidate) => candidate.id === roleId) ?? roles[0];

  return (
    <section className="permission-matrix" aria-label="Базовые права ролей">
      <h3 className="settings-subsection-title">Базовые права ролей</h3>
      {isLoading ? (
        <p className="loading-copy" aria-live="polite">Загружаем права ролей…</p>
      ) : !role ? (
        <p className="settings-copy">Ролей пока нет.</p>
      ) : (
        <>
          <label className="permission-editor-subject">
            <span id={roleLabelId}>Роль</span>
            <select aria-labelledby={roleLabelId} value={role.id} onChange={(event) => setRoleId(event.currentTarget.value)}>
              {roles.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
              ))}
            </select>
          </label>
          {!role.editable && <p className="settings-copy">Эта роль доступна только для чтения.</p>}
          <div className="permission-editor-list">
            {permissions.map((permission) => {
              const granted = role.permissions.includes(permission);
              return (
                <label className="permission-editor-row" key={permission}>
                  <span>{PERMISSION_LABELS[permission]}</span>
                  <select
                    className="permission-cell-value"
                    aria-label={`Разрешение ${permission} для ${role.name}`}
                    data-state={granted ? "allowed" : "not-granted"}
                    disabled={!role.editable || busyRoleId !== null}
                    value={granted ? "granted" : "missing"}
                    onChange={(event) => {
                      const nextPermissions = event.currentTarget.value === "granted"
                        ? [...new Set([...role.permissions, permission])]
                        : role.permissions.filter((item) => item !== permission);
                      onChange(role.id, nextPermissions);
                    }}
                  >
                    <option value="granted">{PERMISSION_STATES[0]}</option>
                    <option value="missing">{PERMISSION_STATES[1]}</option>
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
