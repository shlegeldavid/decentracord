import { useEffect, useState, type FormEvent } from "react";
import { ApiError, updateOrganization } from "../../api";
import { OrganizationLogoSettings } from "./OrganizationLogoSettings";
import { ReadRetentionSettings } from "./ReadRetentionSettings";

function OrganizationNameSettings({
  name: initialName,
  logoUrl,
  csrfToken,
  onSaved,
  onSessionExpired
}: {
  name: string;
  logoUrl: string | null;
  csrfToken: string;
  onSaved: (name: string) => void;
  onSessionExpired: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => setName(initialName), [initialName]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorMessage(null);
    setStatusMessage(null);
    setIsSaving(true);
    try {
      const updatedOrganization = await updateOrganization(name, csrfToken, logoUrl);
      setName(updatedOrganization.name);
      onSaved(updatedOrganization.name);
      setStatusMessage("Название сохранено.");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired();
      } else {
        setErrorMessage(error instanceof ApiError && error.status === 400
          ? "Название должно содержать от 1 до 100 символов."
          : "Не удалось сохранить название. Попробуйте ещё раз.");
      }
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="settings-card" aria-label="Название организации">
      <p className="eyebrow">УПРАВЛЕНИЕ</p>
      <p className="settings-copy">Это название увидят участники после входа.</p>
      <form onSubmit={(event) => void handleSubmit(event)} aria-busy={isSaving}>
        <label htmlFor="organization-name">Название организации</label>
        <input
          autoComplete="organization"
          id="organization-name"
          name="organizationName"
          maxLength={100}
          required
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          aria-describedby={errorMessage ? "organization-name-error" : undefined}
        />
        {errorMessage && <p className="form-error" id="organization-name-error" role="alert">{errorMessage}</p>}
        {statusMessage && <p className="form-success" aria-live="polite">{statusMessage}</p>}
        <button type="submit" disabled={isSaving}>
          {isSaving ? "Сохраняем…" : "Сохранить название"}
        </button>
      </form>
    </section>
  );
}

export function OrganizationSettings({
  name,
  logoUrl,
  csrfToken,
  onNameSaved,
  onLogoChanged,
  onSessionExpired
}: {
  name: string;
  logoUrl: string | null;
  csrfToken: string;
  onNameSaved: (name: string) => void;
  onLogoChanged: () => void;
  onSessionExpired: () => void;
}) {
  return (
    <>
      <OrganizationNameSettings
        name={name}
        logoUrl={logoUrl}
        csrfToken={csrfToken}
        onSaved={onNameSaved}
        onSessionExpired={onSessionExpired}
      />
      <OrganizationLogoSettings
        logoUrl={logoUrl}
        csrfToken={csrfToken}
        onChanged={onLogoChanged}
        onSessionExpired={onSessionExpired}
      />
      <ReadRetentionSettings csrfToken={csrfToken} onSessionExpired={onSessionExpired} />
    </>
  );
}
