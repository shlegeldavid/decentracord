import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { ApiError, getReadRetention, updateReadRetention } from "../../api";

interface ReadRetentionSettingsProps {
  csrfToken: string;
  onSessionExpired: () => void;
}

const defaultDays = 90;
const minimumDays = 1;
const maximumDays = 3650;

function parseDays(value: string): number | null {
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < minimumDays || parsed > maximumDays) return null;
  return parsed;
}

export function ReadRetentionSettings({ csrfToken, onSessionExpired }: ReadRetentionSettingsProps) {
  const [keepForever, setKeepForever] = useState(true);
  const [days, setDays] = useState(String(defaultDays));
  const [storedDays, setStoredDays] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getReadRetention().then((retention) => {
      if (!active) return;
      setKeepForever(retention.keepForever);
      setStoredDays(retention.days);
      if (retention.days !== null) setDays(String(retention.days));
    }).catch((error: unknown) => {
      if (!active) return;
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
    }).finally(() => {
      if (active) setIsLoading(false);
    });
    return () => {
      active = false;
    };
  }, [onSessionExpired]);

  const daysValue = parseDays(days);
  const isDaysRangeValid = daysValue !== null;

  function selectMode(nextKeepForever: boolean): void {
    setErrorMessage(null);
    setStatusMessage(null);
    setKeepForever(nextKeepForever);
    // При переходе к варианту со сроком показываем осмысленное значение:
    // сохранённый срок, если он был, иначе 90 дней.
    if (!nextKeepForever) setDays(storedDays === null ? String(defaultDays) : String(storedDays));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (isSaving) return;
    setErrorMessage(null);
    setStatusMessage(null);
    const payload = keepForever
      ? { keepForever: true, days: null }
      : { keepForever: false, days: daysValue };
    if (!keepForever && daysValue === null) {
      setErrorMessage("Не удалось сохранить срок хранения прочтений. Попробуйте ещё раз.");
      return;
    }
    setIsSaving(true);
    try {
      const updated = await updateReadRetention(payload, csrfToken);
      setKeepForever(updated.keepForever);
      setStoredDays(updated.days);
      if (updated.days !== null) setDays(String(updated.days));
      setStatusMessage("Срок хранения прочтений сохранён.");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired();
      } else {
        setErrorMessage("Не удалось сохранить срок хранения прочтений. Попробуйте ещё раз.");
      }
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="settings-card read-retention-block" aria-label="Хранение прочтений">
      <p className="eyebrow">ПРОЧТЕНИЯ</p>
      <p className="settings-copy">Сколько хранить историю прочтений сообщений. По умолчанию — бессрочно.</p>
      <form onSubmit={(event) => void handleSubmit(event)} aria-busy={isSaving}>
        <div className="read-retention-options">
          <div className="read-retention-option">
            <input
              checked={keepForever}
              id="read-retention-forever"
              name="read-retention-mode"
              onChange={() => selectMode(true)}
              type="radio"
              value="forever"
            />
            <label htmlFor="read-retention-forever">Хранить бессрочно</label>
            <p>История прочтений не удаляется.</p>
          </div>
          <div className="read-retention-option">
            <input
              checked={!keepForever}
              id="read-retention-days-mode"
              name="read-retention-mode"
              onChange={() => selectMode(false)}
              type="radio"
              value="days"
            />
            <label htmlFor="read-retention-days-mode">Хранить заданное число дней</label>
            <p>Записи прочтений старше указанного срока удаляются.</p>
          </div>
        </div>

        {keepForever === false && (
          <div className="read-retention-days">
            <label htmlFor="read-retention-days">Срок хранения, дней</label>
            <input
              className="input"
              disabled={isSaving}
              id="read-retention-days"
              max={maximumDays}
              min={minimumDays}
              onChange={(event) => setDays(event.currentTarget.value)}
              step={1}
              type="number"
              value={days}
            />
          </div>
        )}

        {errorMessage && <p className="form-error" role="alert">{errorMessage}</p>}
        {statusMessage && <p className="form-success" aria-live="polite">{statusMessage}</p>}
        <button
          className="btn btn-primary"
          disabled={isSaving || isLoading || (keepForever === false && !isDaysRangeValid)}
          type="submit"
        >
          {isSaving ? "Сохраняем…" : "Сохранить срок хранения"}
        </button>
      </form>
    </section>
  );
}
