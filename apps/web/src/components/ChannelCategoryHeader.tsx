import type { HTMLAttributes, MouseEvent, ReactNode } from "react";
import { ChevronIcon, GripIcon, PlusIcon } from "./icons";

type DragHandleProps = Pick<HTMLAttributes<HTMLSpanElement>, "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel">;

export interface ChannelCategoryHeaderProps {
  name: string;
  isSection?: boolean;
  expanded?: boolean;
  unreadCount?: number;
  onToggle?: () => void;
  onCreateChannel?: () => void;
  isMenuOpen?: boolean;
  onOpenMenu?: (event: MouseEvent<HTMLButtonElement>) => void;
  dragHandle?: ReactNode;
  dragHandleProps?: DragHandleProps;
}

export function ChannelCategoryHeader({
  name,
  isSection = false,
  expanded,
  unreadCount,
  onToggle,
  onCreateChannel,
  isMenuOpen = false,
  onOpenMenu,
  dragHandle,
  dragHandleProps
}: ChannelCategoryHeaderProps) {
  const hasActions = !isSection && (onCreateChannel !== undefined || onOpenMenu !== undefined);
  const isExpanded = expanded ?? true;
  const toggleLabel = isSection
    ? `${isExpanded ? "Свернуть" : "Развернуть"} раздел «Без категории»`
    : `${isExpanded ? "Свернуть" : "Развернуть"} категорию «${name}»`;
  const unreadLabel = isSection
    ? `${unreadCount ?? 0} непрочитанных в разделе «Без категории»`
    : `${unreadCount ?? 0} непрочитанных в категории «${name}»`;

  return (
    <div className="channel-category-header">
      <button
        type="button"
        className={`icon-btn icon-btn-24 channel-category-toggle${isExpanded ? "" : " is-collapsed"}`}
        aria-expanded={isExpanded}
        aria-label={toggleLabel}
        onClick={onToggle}
      >
        <ChevronIcon />
      </button>
      <span className={`channel-category-name${isSection ? " channel-category-name--section" : ""}`}>
        {name}
      </span>
      {!isExpanded && (unreadCount ?? 0) > 0 && (
        <span className="channel-category-badge" role="img" aria-label={unreadLabel}>
          {unreadCount}
        </span>
      )}
      {hasActions && (
        <div className="channel-category-actions">
          {onCreateChannel && (
            <button type="button" className="icon-btn icon-btn-24" title="Создать канал" aria-label={`Создать канал в категории «${name}»`} onClick={onCreateChannel}>
              <PlusIcon />
            </button>
          )}
          {onOpenMenu && (
            <button
              type="button"
              className="icon-btn icon-btn-24 sidebar-menu-trigger"
              title="Действия с категорией"
              aria-label={`Действия с категорией «${name}»`}
              aria-haspopup="menu"
              aria-expanded={isMenuOpen}
              onClick={onOpenMenu}
            >
              <span aria-hidden="true">…</span>
            </button>
          )}
        </div>
      )}
      {!isSection && dragHandle !== undefined && (
        <span className="channel-category-drag" aria-hidden="true" tabIndex={-1} {...dragHandleProps}>
          {dragHandle ?? <GripIcon size={16} />}
        </span>
      )}
    </div>
  );
}
