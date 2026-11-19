import { Fragment, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { ApiError, searchPeople, type PersonSearchResult } from "../api";
import { avatarColor, initials } from "../lib/avatar";
import { SearchIcon } from "./icons";
import { PersonCard } from "./PersonCard";

interface PeopleSearchProps {
  onSessionExpired: () => void;
  onStartConversation?: (person: PersonSearchResult) => Promise<void>;
  currentUserId?: string;
}

type SearchStatus = "idle" | "loading" | "ready" | "error";

const REQUEST_DELAY_MS = 250;
const RESULTS_LIST_ID = "people-search-results";
const TRUNCATION_NOTICE = "Показаны первые 25 — уточните запрос.";

/**
 * Поле поиска людей в шапке рабочего места.
 *
 * Поле — комбобокс: фокус всегда остаётся в поле, выбранный результат
 * отмечается через `aria-activedescendant`. Запрос уходит на сервер через
 * 250 мс после последнего ввода; пустое поле запрос не отправляет.
 */
export function PeopleSearch({ onSessionExpired, onStartConversation, currentUserId }: PeopleSearchProps) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [results, setResults] = useState<PersonSearchResult[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const isOpen = status !== "idle";

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setStatus("idle");
      setResults([]);
      setTruncated(false);
      setActiveIndex(-1);
      setExpandedId(null);
      return;
    }

    let active = true;
    setStatus("loading");
    setActiveIndex(-1);
    setExpandedId(null);
    const timer = window.setTimeout(() => {
      void searchPeople(trimmed)
        .then((response) => {
          if (!active) return;
          setResults(response.results);
          setTruncated(response.truncated);
          setStatus("ready");
        })
        .catch((error: unknown) => {
          if (!active) return;
          if (error instanceof ApiError && error.status === 401) {
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
  }, [query, reloadKey, onSessionExpired]);

  function optionId(index: number): string {
    return `people-search-option-${index}`;
  }

  function toggleExpanded(resultId: string): void {
    setExpandedId((current) => (current === resultId ? null : resultId));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (results.length === 0) return;
      setActiveIndex(0);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (results.length === 0) return;
      setActiveIndex(results.length - 1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const selected = results[activeIndex];
      if (!selected) return;
      toggleExpanded(selected.id);
      return;
    }
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (isOpen) {
      setStatus("idle");
      setResults([]);
      setTruncated(false);
      setActiveIndex(-1);
      setExpandedId(null);
      return;
    }
    setQuery("");
    inputRef.current?.blur();
  }

  function keepFocusInField(event: MouseEvent<HTMLElement>): void {
    event.preventDefault();
  }

  return (
    <div className="app-header-search">
      <SearchIcon size={16} className="app-header-search-icon" />
      <input
        ref={inputRef}
        className="app-header-search-input"
        type="search"
        role="combobox"
        aria-label="Поиск людей"
        placeholder="Поиск людей"
        aria-expanded={isOpen}
        aria-controls="people-search-results"
        aria-autocomplete="list"
        aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
      />
      <ul
        id={RESULTS_LIST_ID}
        role="listbox"
        className="people-search-results"
        aria-label="Результаты поиска людей"
        hidden={!isOpen}
      >
        {status === "loading" && (
          <li className="people-search-state" role="status" aria-live="polite">Ищем участников…</li>
        )}
        {status === "error" && (
          <li className="people-search-state" role="alert">
            <p>Не удалось выполнить поиск. Попробуйте ещё раз.</p>
            <button
              type="button"
              onMouseDown={keepFocusInField}
              onClick={() => setReloadKey((value) => value + 1)}
            >
              Повторить
            </button>
          </li>
        )}
        {status === "ready" && results.length === 0 && (
          <li className="people-search-state">
            <p>Никого не нашли.</p>
            <p>Попробуйте другой запрос.</p>
          </li>
        )}
        {status === "ready" && results.map((result, index) => (
          <Fragment key={result.id}>
            <li
              id={optionId(index)}
              role="option"
              aria-selected={index === activeIndex}
              className="people-search-result"
              onMouseDown={keepFocusInField}
              onClick={() => {
                setActiveIndex(index);
                toggleExpanded(result.id);
              }}
            >
              <span
                className="member-avatar"
                ref={(element) => element?.style.setProperty("background", avatarColor(result.login))}
                aria-hidden="true"
              >
                {initials(result.login)}
              </span>
              <span className="people-search-result-login">{result.login}</span>
              <span
                className="presence-dot"
                data-presence={result.presence}
                role="img"
                aria-label={result.presence === "online" ? "В сети" : "Не в сети"}
                title={result.presence === "online" ? "В сети" : "Не в сети"}
              />
            </li>
            {expandedId === result.id && (
              <li className="people-search-expanded">
                <PersonCard
                  result={result}
                  onClose={() => setExpandedId(null)}
                  {...(onStartConversation ? { onStartConversation } : {})}
                  {...(currentUserId ? { currentUserId } : {})}
                />
              </li>
            )}
          </Fragment>
        ))}
        {status === "ready" && truncated && (
          <li className="people-search-note">{TRUNCATION_NOTICE}</li>
        )}
      </ul>
    </div>
  );
}
