import type { ReactNode } from "react";
import { GearIcon, LogoMark, MenuIcon, MoonIcon, PeopleIcon, SunIcon } from "./icons";
import type { Theme } from "../lib/roles";
import type { RealtimeStatus } from "../realtime";

interface AppHeaderProps {
  organizationName: string;
  logoUrl: string | null;
  realtimeStatus: RealtimeStatus;
  theme: Theme;
  onToggleTheme: () => void;
  onReconnect: () => void;
  onOpenSettings: () => void;
  onOpenChannels?: () => void;
  onOpenMembers?: () => void;
  peopleSearch?: ReactNode;
}

const CONNECTION_COPY: Record<RealtimeStatus, string> = {
  connected: "подключено",
  connecting: "подключаемся…",
  disconnected: "нет связи"
};

export function AppHeader({
  organizationName,
  logoUrl,
  realtimeStatus,
  theme,
  onToggleTheme,
  onReconnect,
  onOpenSettings,
  onOpenChannels,
  onOpenMembers,
  peopleSearch
}: AppHeaderProps) {
  return (
    <header className="app-header">
      {onOpenChannels && (
        <button
          type="button"
          className="icon-btn mobile-header-action"
          aria-label="Список каналов"
          onClick={onOpenChannels}
        >
          <MenuIcon />
        </button>
      )}
      <div className="app-header-brand" title={organizationName}>
        {logoUrl
          ? <img className="app-header-logo" src={logoUrl} alt="" />
          : <LogoMark size={24} className="brand-mark" />}
        <h1 className="brand-name">{organizationName}</h1>
        {peopleSearch}
      </div>
      <div className="app-header-actions">
        <div
          className={`connection-status connection-status-${realtimeStatus}`}
          role="status"
          aria-live="polite"
          aria-label={`Защищённое подключение: ${CONNECTION_COPY[realtimeStatus]}`}
          title={realtimeStatus === "connected" ? "Соединение установлено" : undefined}
        >
          <span className="presence-dot" data-status={realtimeStatus} aria-hidden="true" />
          {/* Подключённое состояние — норма: пользователю показываем только точку,
              текст остаётся в разметке для скринридера и проверок. */}
          <span className={realtimeStatus === "connected" ? "visually-hidden" : undefined}>
            {realtimeStatus === "connected"
              ? `Защищённое подключение: ${CONNECTION_COPY.connected}`
              : CONNECTION_COPY[realtimeStatus]}
          </span>
        </div>
        {realtimeStatus === "disconnected" && (
          <button type="button" className="reconnect-btn" onClick={onReconnect}>
            Переподключиться
          </button>
        )}
        <button
          type="button"
          className="icon-btn"
          aria-label="Переключить тему"
          onClick={onToggleTheme}
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
        <button type="button" className="icon-btn" aria-label="Настройки" onClick={onOpenSettings}>
          <GearIcon />
        </button>
      </div>
      {onOpenMembers && (
        <button
          type="button"
          className="icon-btn mobile-header-action"
          aria-label="Состав канала"
          onClick={onOpenMembers}
        >
          <PeopleIcon />
        </button>
      )}
    </header>
  );
}
