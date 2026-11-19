import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  ApiError,
  createConversation,
  searchPeople,
  type Conversation,
  type PersonSearchResult
} from "../api";
import { avatarColor, initials } from "../lib/avatar";
import { CloseIcon } from "./icons";
import { Modal } from "./ui/Modal";

interface CreateDmDialogProps {
  open: boolean;
  onClose: () => void;
  csrfToken: string;
  onCreated: (conversation: Conversation) => void;
  onSessionExpired: () => void;
}

type SearchStatus = "idle" | "loading" | "ready" | "error";

const REQUEST_DELAY_MS = 250;
const NEW_CONVERSATION_TITLE_ID = "dm-create-title";

/**
 * Модалка «Новая переписка»: поиск участников тем же серверным поиском, что и
 * в шапке, множественный выбор и создание пары или группы.
 */
export function CreateDmDialog({ open, onClose, csrfToken, onCreated, onSessionExpired }: CreateDmDialogProps) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [results, setResults] = useState<PersonSearchResult[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [selected, setSelected] = useState<PersonSearchResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setStatus("idle");
      setResults([]);
      setTruncated(false);
      setSelected([]);
      setError(null);
      setIsSubmitting(false);
    }
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

  function toggleSelected(person: PersonSearchResult): void {
    setSelected((current) => current.some((entry) => entry.id === person.id)
      ? current.filter((entry) => entry.id !== person.id)
      : [...current, person]);
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
      const conversation = await createConversation(selected.map((person) => person.id), csrfToken);
      onCreated(conversation);
      onClose();
    } catch (submitError: unknown) {
      if (submitError instanceof ApiError && submitError.status === 401) {
        onSessionExpired();
        return;
      }
      if (submitError instanceof ApiError && submitError.code === "SELF_CONVERSATION") {
        setError("Нельзя начать переписку с самим собой.");
      } else {
        setError("Не удалось начать переписку. Попробуйте ещё раз.");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy={NEW_CONVERSATION_TITLE_ID}
      dialogClassName="modal-dialog dm-picker"
      initialFocusRef={searchRef}
    >
      <h2 id={NEW_CONVERSATION_TITLE_ID}>Новая переписка</h2>
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
        {status === "ready" && results.length === 0 && (
          <div className="people-search-state">
            <p>Никого не нашли.</p>
            <p>Попробуйте другой запрос.</p>
          </div>
        )}
        {status === "ready" && results.length > 0 && (
          <ul role="listbox" aria-label="Результаты поиска участников">
            {results.map((person) => {
              const isSelected = selected.some((entry) => entry.id === person.id);
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
        <ul className="dm-picker-selected">
          {selected.map((person) => (
            <li key={person.id} className="chip dm-picker-chip">
              <span>{person.login}</span>
              <button
                type="button"
                className="dm-picker-remove"
                aria-label={`Убрать ${person.login} из выбранных`}
                onClick={() => toggleSelected(person)}
              >
                <CloseIcon size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected.length === 0 && <p className="settings-copy">Выберите хотя бы одного участника.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>Отмена</button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={selected.length === 0 || isSubmitting}
          onClick={() => void submit()}
        >
          {isSubmitting ? "Создаём…" : "Начать переписку"}
        </button>
      </div>
    </Modal>
  );
}
