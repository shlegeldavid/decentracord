import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { getChannelMembers, searchPeople, type ChannelMember, type PersonSearchResult } from "../api";
import { avatarColor, initials } from "../lib/avatar";
import { roleColorForTheme, type Theme } from "../lib/roles";
import { PersonCard } from "./PersonCard";

interface ChannelMembersPanelProps {
  channelId: string | null;
  theme: Theme;
}

export function ChannelMembersPanel({ channelId, theme }: ChannelMembersPanelProps) {
  const [members, setMembers] = useState<ChannelMember[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [filter, setFilter] = useState("");
  const filterInput = useRef<HTMLInputElement>(null);
  const [openPerson, setOpenPerson] = useState<PersonSearchResult | null>(null);
  const [personError, setPersonError] = useState<string | null>(null);

  // Карточка участника переиспользует выдачу поиска людей: отдельного
  // маршрута «профиль участника» нет, а поиск по логину всегда находит эту
  // учётную запись. Список панели — единственный источник состава.
  async function openMemberCard(member: ChannelMember): Promise<void> {
    setPersonError(null);
    try {
      const { results } = await searchPeople(member.login);
      const person = results.find((candidate) => candidate.id === member.id) ?? results[0] ?? null;
      if (!person) {
        setPersonError("Не удалось открыть карточку участника.");
        return;
      }
      setOpenPerson(person);
    } catch {
      setPersonError("Не удалось открыть карточку участника.");
    }
  }

  useEffect(() => {
    let active = true;
    setMembers([]);
    setHasError(false);
    setFilter("");

    if (!channelId) {
      setIsLoading(false);
      return () => {
        active = false;
      };
    }

    setIsLoading(true);
    void getChannelMembers(channelId)
      .then((result) => {
        if (active) setMembers(result);
      })
      .catch(() => {
        if (active) setHasError(true);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [channelId, reloadKey]);

  const normalizedFilter = filter.trim().toLocaleLowerCase("ru-RU");
  const filteredMembers = members.filter((member) =>
    member.login.toLocaleLowerCase("ru-RU").includes(normalizedFilter)
  );
  const sortedMembers = filteredMembers
    .map((member) => {
      const roles = [...member.roles].sort((left, right) =>
        right.position - left.position || left.id.localeCompare(right.id, "ru-RU")
      );
      return {
        member,
        role: roles[0] ?? null,
        roleColor: roleColorForTheme(roles.find((role) => role.color !== null)?.color ?? null, theme)
      };
    })
    .sort((left, right) => {
      const leftPosition = left.role?.position ?? Number.NEGATIVE_INFINITY;
      const rightPosition = right.role?.position ?? Number.NEGATIVE_INFINITY;
      return rightPosition - leftPosition ||
        (left.role?.name ?? "").localeCompare(right.role?.name ?? "", "ru-RU") ||
        left.member.login.localeCompare(right.member.login, "ru-RU", { sensitivity: "base" });
    });
  const roleGroups = new Map<string | null, typeof sortedMembers>();
  for (const entry of sortedMembers) {
    const roleId = entry.role?.id ?? null;
    const group = roleGroups.get(roleId);
    if (group) group.push(entry);
    else roleGroups.set(roleId, [entry]);
  }

  function clearFilterOnEscape(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    setFilter("");
    filterInput.current?.blur();
  }

  return (
    <>
      <aside className="settings-card member-panel" aria-labelledby="channel-members-title" aria-busy={isLoading}>
      <header className="members-panel-header">
        <h2 id="channel-members-title">Состав канала</h2>
      </header>
      {channelId === null ? (
        <p className="settings-copy">Выберите канал, чтобы увидеть его участников.</p>
      ) : hasError ? (
        <div className="form-error channel-members-error" role="alert">
          <p>Не удалось загрузить участников канала.</p>
          <button type="button" className="btn btn-primary" onClick={() => setReloadKey((value) => value + 1)}>
            Повторить
          </button>
        </div>
      ) : isLoading ? (
        <p className="settings-copy" aria-live="polite">Загружаем участников…</p>
      ) : members.length === 0 ? (
        <p className="settings-copy">В канале пока нет участников.</p>
      ) : (
        <>
          <input
            ref={filterInput}
            className="members-filter"
            type="search"
            aria-label="Фильтр участников"
            placeholder="Фильтр по имени или логину"
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
            onKeyDown={clearFilterOnEscape}
          />
          {sortedMembers.length === 0 ? (
            <p className="settings-copy">Никого не нашли. Измените запрос.</p>
          ) : (
            <div className="channel-member-groups" aria-live="polite">
              {[...roleGroups].map(([roleId, group]) => {
                const groupLabel = group[0]?.role?.name ?? "Без роли";
                return (
                  <section className="channel-member-group" key={roleId ?? ""} aria-label={groupLabel}>
                    <h3>{groupLabel} — {group.length}</h3>
                    <ul className="channel-members-list" aria-label={groupLabel}>
                      {group.map(({ member, roleColor }) => (
                        <li className="channel-member-item" key={member.id}>
                          <button
                            type="button"
                            className="channel-member-row"
                            data-channel-member-id={member.id}
                            onClick={() => void openMemberCard(member)}
                          >
                            <span
                              className="member-avatar"
                              ref={(element) => element?.style.setProperty("background", avatarColor(member.login))}
                              aria-hidden="true"
                            >
                              {initials(member.login)}
                            </span>
                            <span className="member-info">
                              <span
                                className="member-name"
                                ref={(element) => {
                                  if (!element) return;
                                  if (roleColor) element.style.setProperty("--role-color", roleColor);
                                  else element.style.removeProperty("--role-color");
                                }}
                              >
                                {member.login}
                              </span>
                            </span>
                            <span
                              className="presence-dot"
                              data-presence={member.presence}
                              role="img"
                              aria-label={member.presence === "online" ? "В сети" : "Не в сети"}
                              title={member.presence === "online" ? "В сети" : "Не в сети"}
                            />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          )}
        </>
      )}
      </aside>
      {personError && <p className="form-error" role="alert">{personError}</p>}
      {openPerson && (
        <div className="modal-overlay" role="presentation" onClick={() => setOpenPerson(null)}>
          <div className="modal-dialog member-card-dialog" onClick={(event) => event.stopPropagation()}>
            <PersonCard result={openPerson} onClose={() => setOpenPerson(null)} />
          </div>
        </div>
      )}
    </>
  );
}
