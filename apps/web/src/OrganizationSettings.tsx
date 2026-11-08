import { useState } from "react";
import type { FormEvent } from "react";
import { ApiError, updateOrganization } from "./api";

interface OrganizationSettingsProps {
  name: string;
  csrfToken: string;
  onSaved: (name: string) => void;
}

export function OrganizationSettings({ name: initialName, csrfToken, onSaved }: OrganizationSettingsProps) {
  const [name, setName] = useState(initialName);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorMessage(null);
    setStatusMessage(null);
    setIsSaving(true);
    try {
      const organization = await updateOrganization(name, csrfToken);
      setName(organization.name);
      onSaved(organization.name);
      setStatusMessage("Название сохранено.");
    } catch (error) {
      setErrorMessage(
        error instanceof ApiError && error.status === 400
          ? "Название должно содержать от 1 до 100 символов."
          : "Не удалось сохранить название. Попробуйте ещё раз."
      );
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="settings-card" aria-labelledby="organization-settings-title">
      <p className="eyebrow">УПРАВЛЕНИЕ</p>
      <h2 id="organization-settings-title">Название организации</h2>
      <p className="settings-copy">Это название увидят участники после входа.</p>
      <form onSubmit={(event) => void handleSubmit(event)} aria-busy={isSaving}>
        <label htmlFor="organization-name">Название организации</label>
        <input
          autoComplete="organization"
          id="organization-name"
          name="organizationName"
          maxLength={200}
          required
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          aria-describedby={errorMessage ? "organization-name-error" : undefined}
        />
        {errorMessage && <p className="form-error" id="organization-name-error" role="alert">{errorMessage}</p>}
        {statusMessage && <p className="form-success" role="status">{statusMessage}</p>}
        <button type="submit" disabled={isSaving}>
          {isSaving ? "Сохраняем…" : "Сохранить"}
        </button>
      </form>
    </section>
  );
}
