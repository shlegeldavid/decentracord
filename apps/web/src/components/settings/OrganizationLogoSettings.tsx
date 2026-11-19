import { useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { ApiError, deleteOrganizationLogo, uploadOrganizationLogo } from "../../api";
import { LogoMark, UploadIcon } from "../icons";
import { ConfirmDialog } from "../ui/ConfirmDialog";

interface OrganizationLogoSettingsProps {
  logoUrl: string | null;
  csrfToken: string;
  onChanged: () => void;
  onSessionExpired: () => void;
}

export function OrganizationLogoSettings({
  logoUrl,
  csrfToken,
  onChanged,
  onSessionExpired
}: OrganizationLogoSettingsProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [deleteErrorMessage, setDeleteErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  async function uploadLogo(file: File): Promise<void> {
    setErrorMessage(null);
    setStatusMessage(null);
    setIsUploading(true);
    try {
      await uploadOrganizationLogo(file, csrfToken);
      setStatusMessage("Логотип загружен.");
      onChanged();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired();
      } else if (error instanceof ApiError && error.code === "INVALID_LOGO") {
        setErrorMessage("Логотип должен быть не больше 512×512 пикселей.");
      } else {
        setErrorMessage("Не удалось загрузить логотип. Попробуйте ещё раз.");
      }
    } finally {
      setIsUploading(false);
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const input = event.currentTarget;
    const file = input.files?.[0] ?? null;
    // Значение сбрасывается, чтобы выбор того же файла снова запускал загрузку.
    input.value = "";
    if (!file) return;
    if (file.type !== "image/png") {
      setErrorMessage("Логотип должен быть в формате PNG.");
      setStatusMessage(null);
      return;
    }
    void uploadLogo(file);
  }

  async function handleDelete(): Promise<void> {
    setDeleteErrorMessage(null);
    setIsDeleting(true);
    try {
      await deleteOrganizationLogo(csrfToken);
      setIsDeleteDialogOpen(false);
      setErrorMessage(null);
      setStatusMessage("Логотип удалён.");
      onChanged();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setIsDeleteDialogOpen(false);
        onSessionExpired();
      } else {
        setDeleteErrorMessage("Не удалось удалить логотип. Попробуйте ещё раз.");
      }
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <section className="settings-card organization-logo-block" aria-label="Логотип организации">
      <p className="eyebrow">ЛОГОТИП</p>
      <p className="settings-copy">Логотип показывается в шапке рабочего места после входа. Формат — PNG, до 512×512 пикселей.</p>

      <div className="organization-logo-tile">
        {logoUrl
          ? <img className="organization-logo-preview" src={logoUrl} alt="Логотип организации" />
          : <LogoMark size={40} />}
      </div>
      {!logoUrl && <p className="organization-logo-caption">Логотип не загружен.</p>}

      <label className="visually-hidden" htmlFor="organization-logo-file">Файл логотипа</label>
      <input
        accept="image/png"
        className="visually-hidden"
        disabled={isUploading}
        id="organization-logo-file"
        onChange={handleFileChange}
        ref={fileInputRef}
        type="file"
      />

      {errorMessage && <p className="form-error" role="alert">{errorMessage}</p>}
      {statusMessage && <p className="form-success" aria-live="polite">{statusMessage}</p>}

      <div className="organization-logo-actions">
        <button
          className="btn btn-primary"
          disabled={isUploading}
          onClick={() => fileInputRef.current?.click()}
          type="button"
        >
          <UploadIcon />
          {isUploading ? "Загружаем…" : "Загрузить логотип"}
        </button>
        <button
          className="btn btn-danger"
          disabled={!logoUrl || isUploading || isDeleting}
          onClick={() => {
            setDeleteErrorMessage(null);
            setIsDeleteDialogOpen(true);
          }}
          type="button"
        >
          Удалить логотип
        </button>
      </div>

      <ConfirmDialog
        busy={isDeleting}
        confirmCheckboxLabel="Подтверждаю удаление логотипа организации"
        confirmLabel="Удалить логотип"
        description="После удаления в шапке снова появится значок приложения. Название организации не изменится."
        onCancel={() => setIsDeleteDialogOpen(false)}
        onConfirm={() => void handleDelete()}
        open={isDeleteDialogOpen}
        title="Удалить логотип организации"
        {...(deleteErrorMessage ? { errorMessage: deleteErrorMessage } : {})}
      />
    </section>
  );
}
