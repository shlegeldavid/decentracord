import type { Conversation } from "../api";
import { ChevronIcon, PlusIcon } from "./icons";
import { DmRow } from "./DmRow";

interface DmSectionHeaderProps {
  collapsed: boolean;
  unreadTotal: number;
  onToggleCollapsed: () => void;
  onCreate: () => void;
}

/**
 * Заголовок раздела «Личные сообщения»: шеврон, надпись, счётчик непрочитанных
 * в свёрнутом состоянии и кнопка «Начать переписку», видимая всегда.
 */
export function DmSectionHeader({ collapsed, unreadTotal, onToggleCollapsed, onCreate }: DmSectionHeaderProps) {
  return (
    <div className="dm-section-header">
      <button
        type="button"
        className="icon-btn icon-btn-24 dm-section-toggle"
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Развернуть личные сообщения" : "Свернуть личные сообщения"}
        onClick={onToggleCollapsed}
      >
        <ChevronIcon />
      </button>
      <span className="dm-section-title">Личные сообщения</span>
      {collapsed && unreadTotal > 0 && (
        <span className="channel-category-badge" aria-hidden="true">{unreadTotal}</span>
      )}
      <button
        type="button"
        className="icon-btn icon-btn-24 dm-section-add"
        aria-label="Начать переписку"
        onClick={onCreate}
      >
        <PlusIcon />
      </button>
    </div>
  );
}

interface DmSectionProps {
  conversations: Conversation[];
  selectedConversationId: string | null;
  currentUserId: string;
  // Карта набора: ключ — переписка, значение — логины печатающих.
  typingByConversation: Map<string, { logins: string[] }>;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onCreate: () => void;
  onSelect: (conversationId: string) => void;
  onCloseRequest: (conversationId: string, position: { x: number; y: number }) => void;
  status: "loading" | "ready" | "error";
  onRetry: () => void;
}

/**
 * Раздел «Личные сообщения» в сайдбаре над списком каналов.
 *
 * Раздел не знает о загрузке данных: состояние списка приходит готовым, поэтому
 * App.tsx остаётся единственным местом, где живут переписки.
 */
export function DmSection({
  conversations,
  selectedConversationId,
  currentUserId,
  typingByConversation,
  collapsed,
  onToggleCollapsed,
  onCreate,
  onSelect,
  onCloseRequest,
  status,
  onRetry
}: DmSectionProps) {
  const unreadTotal = conversations.reduce((total, conversation) => total + conversation.unreadCount, 0);

  return (
    <section className="dm-section" aria-label="Личные сообщения">
      <DmSectionHeader
        collapsed={collapsed}
        unreadTotal={unreadTotal}
        onToggleCollapsed={onToggleCollapsed}
        onCreate={onCreate}
      />
      {!collapsed && status === "loading" && (
        <p className="loading-copy">Загружаем переписки…</p>
      )}
      {!collapsed && status === "error" && (
        <div className="form-error" role="alert">
          Не удалось загрузить переписки.
          <button type="button" className="btn btn-secondary" onClick={onRetry}>Повторить</button>
        </div>
      )}
      {!collapsed && status !== "loading" && status !== "error" && (
        <ul className="dm-list">
          {conversations.length === 0 && (
            <li className="sidebar-empty-state">
              <strong>Пока нет переписок</strong>
              <p>Начните переписку — нажмите «+» в заголовке раздела.</p>
            </li>
          )}
          {conversations.map((conversation) => (
            <DmRow
              key={conversation.id}
              conversation={conversation}
              currentUserId={currentUserId}
              isSelected={conversation.id === selectedConversationId}
              isTyping={typingByConversation.has(conversation.id)}
              typingCount={typingByConversation.get(conversation.id)?.logins.length ?? 0}
              onSelect={onSelect}
              onCloseRequest={onCloseRequest}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
