import { useCallback } from "react";
import { avatarColor, initials } from "../lib/avatar";

interface UserCardProps {
  login: string;
  roleNames: string[];
  isOnline: boolean;
  onLogout: () => void;
  isLoggingOut: boolean;
  collapsed?: boolean;
}

export function UserCard({ login, roleNames, isOnline, onLogout, isLoggingOut, collapsed = false }: UserCardProps) {
  const setAvatarElement = useCallback((element: HTMLDivElement | null) => {
    element?.style.setProperty("background", avatarColor(login));
  }, [login]);

  return (
    <section className={`user-card${collapsed ? " user-card-collapsed" : ""}`} aria-label="Текущий пользователь">
      <div className="user-card-avatar" ref={setAvatarElement} aria-hidden="true">
        {initials(login)}
      </div>
      <div className="user-card-details">
        <div className="user-card-name" title={login}>{login}</div>
        <div className="user-card-role" title={roleNames[0] ?? "Участник"}>{roleNames[0] ?? "Участник"}</div>
        <div className="user-card-presence">
          <span className="presence-dot" data-presence={isOnline ? "online" : "offline"} aria-hidden="true" />
          <span>{isOnline ? "в сети" : "не в сети"}</span>
        </div>
      </div>
      <button type="button" className="user-card-logout" onClick={onLogout} disabled={isLoggingOut}>
        {isLoggingOut ? "Выходим…" : "Выйти"}
      </button>
    </section>
  );
}
