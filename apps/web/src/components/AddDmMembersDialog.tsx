import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  ApiError,
  addConversationParticipants,
  searchPeople,
  type Conversation,
  type PersonSearchResult
} from "../api";
import { avatarColor, initials } from "../lib/avatar";
import { CloseIcon } from "./icons";
import { Modal } from "./ui/Modal";

interface AddDmMembersDialogProps {
  open: boolean;
  onClose: () => void;
  conversation: Conversation;
  csrfToken: string;
  onAdded: (announcement: string) => void;
  onSessionExpired: () => void;
}

interface SelectedCandidate {
  person: PersonSearchResult;
  // Флажок истории персональный: решение принимает тот, кто добавляет
  //, и по умолчанию история видна.
  showHistory: boolean;
}

type SearchStatus = "idle" | "loading" | "ready" | "error";

const REQUEST_DELAY_MS = 250;
const ADD_MEMBERS_TITLE_ID = "dm-members-add-title";

/**
 * Модалка «Добавить участников»: тот же серверный поиск, что и в «Новой
 * переписке», и флажок «Показать историю» на каждого выбранного.
 */
export function AddDmMembersDialog({
  open,
  onClose,
  conversation,
  csrfToken,
  onAdded,
  onSessionExpired
}: AddDmMembersDialogProps) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [results, setResults] = useState<PersonSearchResult[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [selected, setSelected] = useState<SelectedCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) return;
    setQuery("");
    setStatus("idle");
    setResults([]);
    setTruncated(false);
    setSelected([]);
    setError(null);
    setIsSubmitting(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setStatus("idle");
      setResults([]);
      setTruncated(false);
      return;
    }

    let active = true;
    setStatus("loading");
    const timer = window.setTimeout(() => {
      void searchPeople(trimmed)
        .then((response) => {
          if (!active) return;
          setResults(response.results);
          setTruncated(response.truncated);
          setStatus("ready");
        })
        .catch((searchError: unknown) => {
          if (!active) return;
          if (searchError instanceof ApiError && searchError.status === 401) {
            onSessionExpired();
            return;
          }
          setResults([]);
          setTruncated(false);
          setStatus("error");
        });
    }, REQUEST_DELAY_MS);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [open, query, reloadKey, onSessionExpired]);

  const participantIds = new Set(conversation.participants.map((participant) => participant.id));
  const availableResults = results.filter((person) => !participantIds.has(person.id));

  function toggleSelected(person: PersonSearchResult): void {
    setSelected((current) => current.some((entry) => entry.person.id === person.id)
      ? current.filter((entry) => entry.person.id !== person.id)
      : [...current, { person, showHistory: true }]);
  }

  function setShowHistory(userId: string, showHistory: boolean): void {
    setSelected((current) => current.map((entry) =>
      entry.person.id === userId ? { ...entry, showHistory } : entry
    ));
  }

  function handleResultKeyDown(event: KeyboardEvent<HTMLLIElement>, person: PersonSearchResult): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggleSelected(person);
  }

  async function submit(): Promise<void> {
    if (selected.length === 0 || isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      // Сервер принимает по одному человеку: флажок истории персональный.
      for (const entry of selected) {
        await addConversationParticipants(
          conversation.id,
          { userId: entry.person.id, showHistory: entry.showHistory },
          csrfToken
        );
      }
      onAdded("Участники добавлены.");
      onClose();
    } catch (submitError: unknown) {
      if (submitError instanceof ApiError && submitError.status === 401) {
        onSessionExpired();
        return;
      }
      setError("Не удалось добавить участников. Попробуйте ещё раз.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy={ADD_MEMBERS_TITLE_ID}
      dialogClassName="modal-dialog dm-picker"
      initialFocusRef={searchRef}
    >
      <form
        className="dm-picker"
        aria-busy={isSubmitting}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2 id={ADD_MEMBERS_TITLE_ID}>Добавить участников</h2>
        <input
          ref={searchRef}
          className="input dm-picker-search"
          type="search"
          aria-label="Поиск участников"
          placeholder="Поиск по логину"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <div className="dm-picker-results">
          {status === "loading" && <p className="people-search-state" role="status" aria-live="polite">Ищем участников…</p>}
          {status === "error" && (
            <div className="form-error" role="alert">
              <p>Не удалось выполнить поиск. Попробуйте ещё раз.</p>
              <button type="button" className="btn btn-secondary" onClick={() => setReloadKey((value) => value + 1)}>
                Повторить
              </button>
            </div>
          )}
          {status === "ready" && availableResults.length === 0 && (
            <div className="people-search-state">
              <p>Никого не нашли.</p>
              <p>Попробуйте другой запрос.</p>
            </div>
          )}
          {status === "ready" && availableResults.length > 0 && (
            <ul role="listbox" aria-label="Результаты поиска участников">
              {availableResults.map((person) => {
                const isSelected = selected.some((entry) => entry.person.id === person.id);
                return (
                  <li
                    key={person.id}
                    className="dm-picker-result"
                    role="option"
                    aria-selected={isSelected}
                    tabIndex={0}
                    onClick={() => toggleSelected(person)}
                    onKeyDown={(event) => handleResultKeyDown(event, person)}
                  >
                    <span
                      className="member-avatar dm-row-avatar"
                      ref={(element) => element?.style.setProperty("background", avatarColor(person.login))}
                      aria-hidden="true"
                    >
                      {initials(person.login)}
                    </span>
                    <span className="dm-row-name">{person.login}</span>
                    <span
                      className="presence-dot"
                      data-presence={person.presence}
                      role="img"
                      aria-label={person.presence === "online" ? "В сети" : "Не в сети"}
                      title={person.presence === "online" ? "В сети" : "Не в сети"}
                    />
                  </li>
                );
              })}
            </ul>
          )}
          {status === "ready" && truncated && (
            <p className="people-search-note">Показаны первые 25 — уточните запрос.</p>
          )}
        </div>
        {selected.length > 0 && (
          <ul className="channel-members-list">
            {selected.map((entry) => (
              <li key={entry.person.id} className="dm-history-option">
                <span className="dm-member-name" title={entry.person.login}>{entry.person.login}</span>
                <input
                  id={`dm-history-${entry.person.id}`}
                  type="checkbox"
                  checked={entry.showHistory}
                  onChange={(event) => setShowHistory(entry.person.id, event.currentTarget.checked)}
                />
                <label htmlFor={`dm-history-${entry.person.id}`}>Показать историю</label>
                <button
                  type="button"
                  className="dm-picker-remove"
                  aria-label={`Убрать ${entry.person.login} из выбранных`}
                  onClick={() => toggleSelected(entry.person)}
                >
                  <CloseIcon size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {selected.length > 0 && (
          <p className="people-search-note">
            Снятый флажок скрывает от участника сообщения, отправленные до его добавления.
          </p>
        )}
        {selected.length === 0 && <p className="settings-copy">Выберите хотя бы одного участника.</p>}
        {error !== null && <p className="form-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Отмена</button>
          <button type="submit" className="btn btn-primary" disabled={selected.length === 0 || isSubmitting}>
            {isSubmitting ? "Добавляем…" : "Добавить участников"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
