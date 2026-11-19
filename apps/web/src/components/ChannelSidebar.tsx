import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { MouseEvent } from "react";
import type { AuthUser, Channel, ChannelCategory } from "../api";
import { FolderPlusIcon, GripIcon, LockIcon, MenuIcon, PlusIcon } from "./icons";
import { ChannelDescriptionTooltip } from "./ChannelDescriptionTooltip";
import { CategoryDialog } from "./CategoryDialog";
import { ChannelCategoryHeader } from "./ChannelCategoryHeader";
import { UserCard } from "./UserCard";
import { useDragReorder, type ReorderDropTarget, type ReorderItem } from "./useDragReorder";

interface ChannelSidebarProps {
  channels: Channel[];
  categories: ChannelCategory[];
  dmSection: ReactNode;
  canManageChannels: boolean;
  onCreateChannel: (categoryId: string | null) => void;
  onCreateCategory: (name: string) => Promise<void>;
  onCategoryError: (message: string) => void;
  onReorderItem: (item: ReorderItem, target: ReorderDropTarget) => void;
  dragAnnouncement: string;
  openCategoryMenuId: string | null;
  onOpenCategoryMenu: (categoryId: string, trigger: HTMLButtonElement) => void;
  openChannelMenuId: string | null;
  onOpenChannelMenu: (channelId: string, trigger: HTMLButtonElement) => void;
  selectedChannelId: string | null;
  unreadCounts: Record<string, number>;
  collapsedCategoryIds: ReadonlySet<string>;
  uncategorizedCollapsed: boolean;
  onToggleCategoryCollapsed: (categoryId: string) => void;
  onToggleUncategorizedCollapsed: () => void;
  onSelect: (channelId: string) => void;
  onAccessDenied: (channelId: string) => void;
  sidebarWidth: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSidebarWidthChange: (width: number) => void;
  onSidebarWidthCommit: (width: number) => void;
  user: AuthUser;
  isOnline: boolean;
  onLogout: () => void;
  isLoggingOut: boolean;
  isOverlayOpen?: boolean;
  onCloseOverlay?: () => void;
  dialogRef?: (element: HTMLElement | null) => void;
}

const MIN_WIDTH = 200;
const MAX_WIDTH = 360;
const WIDTH_STEP = 8;

function clampWidth(width: number): number {
  const snapped = Math.round(width / WIDTH_STEP) * WIDTH_STEP;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, snapped));
}

function ChannelHashIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m7 3-2 14M15 3l-2 14M3 7h14M2 13h14" />
    </svg>
  );
}

export function ChannelSidebar({
  channels,
  categories,
  dmSection,
  canManageChannels,
  onCreateChannel,
  onCreateCategory,
  onCategoryError,
  onReorderItem,
  dragAnnouncement,
  openCategoryMenuId,
  onOpenCategoryMenu,
  openChannelMenuId,
  onOpenChannelMenu,
  selectedChannelId,
  unreadCounts,
  collapsedCategoryIds,
  uncategorizedCollapsed,
  onToggleCategoryCollapsed,
  onToggleUncategorizedCollapsed,
  onSelect,
  onAccessDenied,
  sidebarWidth,
  collapsed,
  onToggleCollapsed,
  onSidebarWidthChange,
  onSidebarWidthCommit,
  user,
  isOnline,
  onLogout,
  isLoggingOut,
  isOverlayOpen = false,
  onCloseOverlay,
  dialogRef
}: ChannelSidebarProps) {
  const resizeOrigin = useRef<{ x: number; width: number } | null>(null);
  const currentWidth = useRef(sidebarWidth);
  const [isCategoryDialogOpen, setIsCategoryDialogOpen] = useState(false);
  const dragReorder = useDragReorder(onReorderItem);
  currentWidth.current = sidebarWidth;

  const handleResizePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (collapsed) return;
    resizeOrigin.current = { x: event.clientX, width: currentWidth.current };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleResizePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const origin = resizeOrigin.current;
    if (!origin) return;
    const nextWidth = clampWidth(origin.width + Math.round((event.clientX - origin.x) / WIDTH_STEP) * WIDTH_STEP);
    currentWidth.current = nextWidth;
    onSidebarWidthChange(nextWidth);
  };

  const commitResize = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizeOrigin.current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    resizeOrigin.current = null;
    onSidebarWidthCommit(currentWidth.current);
  };

  const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const nextWidth = clampWidth(currentWidth.current + direction * WIDTH_STEP);
    currentWidth.current = nextWidth;
    onSidebarWidthChange(nextWidth);
    onSidebarWidthCommit(nextWidth);
  };

  const moveChannelFocus = (event: KeyboardEvent<HTMLButtonElement>) => {
    let offset: -1 | 0 | 1 | "first" | "last" | null = null;
    if (event.key === "ArrowDown") offset = 1;
    if (event.key === "ArrowUp") offset = -1;
    if (event.key === "Home") offset = "first";
    if (event.key === "End") offset = "last";
    if (offset === null) return;

    event.preventDefault();
    const list = event.currentTarget.closest(".channel-list");
    const buttons = [...list?.querySelectorAll<HTMLButtonElement>(".channel-list-select") ?? []];
    const visible = buttons.filter((button) => button.getClientRects().length > 0);
    const current = visible.indexOf(event.currentTarget);
    if (current < 0 || visible.length === 0) return;

    const targetIndex = offset === "first"
      ? 0
      : offset === "last"
        ? visible.length - 1
        : Math.min(visible.length - 1, Math.max(0, current + offset));
    visible[targetIndex]?.focus();
  };

  function renderChannel(channel: Channel) {
    const unreadCount = channel.canView ? unreadCounts[channel.id] ?? 0 : 0;
    const descriptionId = `channel-description-${channel.id}`;
    const isDragging = dragReorder.draggingItem?.kind === "channel" && dragReorder.draggingItem.id === channel.id;
    const indicator = dragReorder.dropTarget?.type === "channel" && dragReorder.dropTarget.channelId === channel.id
      ? dragReorder.dropTarget.position
      : null;
    const description = [
      ...(!channel.canView ? ["Нет доступа к этому каналу"] : []),
      ...(channel.canView && unreadCount > 0 ? [`${unreadCount} непрочитанных`] : []),
      ...(channel.canView && !channel.canSend ? ["Только для чтения"] : [])
    ].join(", ");

    return (
      <li
        className={`channel-list-item${isDragging ? " channel-dragging" : ""}${indicator ? ` channel-drop-indicator channel-drop-indicator-${indicator}` : ""}`}
        key={channel.id}
        data-channel-id={channel.id}
      >
        <ChannelDescriptionTooltip description={channel.description} canView={channel.canView}>
          <button
            type="button"
            className={`channel-list-select${!channel.canView ? " channel-list-select-locked" : ""}`}
            aria-current={channel.canView && selectedChannelId === channel.id ? "true" : undefined}
            aria-label={collapsed ? channel.name : undefined}
            aria-describedby={description ? descriptionId : undefined}
            onClick={() => {
              if (!channel.canView) {
                onAccessDenied(channel.id);
                if (isOverlayOpen) onCloseOverlay?.();
                return;
              }
              onSelect(channel.id);
              if (isOverlayOpen) onCloseOverlay?.();
            }}
            onKeyDown={moveChannelFocus}
          >
            <span className="channel-item-icon">{channel.canView ? <ChannelHashIcon /> : <LockIcon />}</span>
            <span className="channel-item-name">{channel.name}</span>
            {channel.canView && unreadCount > 0 && (
              <span className="unread-badge" data-unread-count={unreadCount} aria-hidden="true">
                {unreadCount}
              </span>
            )}
            {channel.canView && !channel.canSend && (
              <span className="channel-state channel-state-readonly" aria-hidden="true">Только для чтения</span>
            )}
          </button>
        </ChannelDescriptionTooltip>
        {canManageChannels && (
          <span
            className="channel-drag-handle"
            aria-hidden="true"
            tabIndex={-1}
            {...dragReorder.getHandleProps("channel", channel.id)}
          >
            <GripIcon size={16} />
          </span>
        )}
        {canManageChannels && (
          <button
            type="button"
            className="icon-btn icon-btn-24 channel-actions-trigger sidebar-menu-trigger"
            aria-label={`Действия с каналом «${channel.name}»`}
            title="Действия с каналом"
            aria-haspopup="menu"
            aria-expanded={openChannelMenuId === channel.id}
            onClick={(event) => onOpenChannelMenu(channel.id, event.currentTarget)}
          >
            <span aria-hidden="true">…</span>
          </button>
        )}
        {description && <span className="visually-hidden" id={descriptionId}>{description}</span>}
      </li>
    );
  }

  const uncategorizedChannels = channels.filter((channel) => channel.categoryId === null);
  const uncategorizedUnreadCount = uncategorizedChannels.reduce(
    (total, channel) => total + (channel.canView ? unreadCounts[channel.id] ?? channel.unreadCount ?? 0 : 0),
    0
  );

  return (
    <>
      <aside
        ref={dialogRef}
        className={`settings-card channel-sidebar${collapsed ? " sidebar-collapsed" : ""}${isOverlayOpen ? " drawer drawer-left is-open" : ""}`}
        aria-labelledby="workspace-channels-title"
        {...(isOverlayOpen ? { role: "dialog", "aria-modal": true, "aria-label": "Список каналов", tabIndex: -1 } : {})}
        {...(onCloseOverlay ? { "data-overlay-panel": "channels" } : {})}
      >
        <div className="channel-sidebar-header">
          <h2 id="workspace-channels-title" className="channel-sidebar-title">Каналы</h2>
          {canManageChannels && !collapsed && (
            <div className="channel-sidebar-header-actions">
              <button
                type="button"
                className="icon-btn icon-btn-24"
                aria-label="Создать канал"
                onClick={() => onCreateChannel(null)}
              >
                <PlusIcon />
              </button>
              <button
                type="button"
                className="icon-btn icon-btn-24"
                aria-label="Создать категорию"
                onClick={() => setIsCategoryDialogOpen(true)}
              >
                <FolderPlusIcon />
              </button>
            </div>
          )}
          <button
            type="button"
            className="icon-btn channel-sidebar-collapse"
            aria-label={collapsed ? "Развернуть список каналов" : "Свернуть список каналов"}
            aria-expanded={!collapsed}
            onClick={onToggleCollapsed}
          >
            <span aria-hidden="true" className={collapsed ? "collapse-chevron is-collapsed" : "collapse-chevron"}>‹</span>
          </button>
        </div>
        <div className="channel-sidebar-scroll">
          {dmSection}
          <ul className="channel-list" data-scope="workspace" aria-live="polite">
          <li className={`channel-category${dragReorder.dropTarget?.type === "category" && dragReorder.dropTarget.categoryId === null ? " channel-drop-target" : ""}`} data-category-id="__uncategorized__">
            <ChannelCategoryHeader
              name="Без категории"
              isSection
              expanded={!uncategorizedCollapsed}
              unreadCount={uncategorizedUnreadCount}
              onToggle={onToggleUncategorizedCollapsed}
            />
            {!uncategorizedCollapsed && (
              <ul className="channel-category-list">{uncategorizedChannels.map(renderChannel)}</ul>
            )}
          </li>
          {channels.length === 0 && (
            <li className="sidebar-empty-state">
              <strong>Пока нет доступных каналов</strong>
              <p>{canManageChannels
                ? "Создайте первый канал — нажмите «+» в заголовке списка."
                : "Обратитесь к администратору, чтобы получить доступ к каналу."}</p>
            </li>
          )}
          {categories.map((category) => {
            const expanded = !collapsedCategoryIds.has(category.id);
            const isDragging = dragReorder.draggingItem?.kind === "category" && dragReorder.draggingItem.id === category.id;
            const isDropTarget = dragReorder.dropTarget?.type === "category" && dragReorder.dropTarget.categoryId === category.id;
            const categoryChannels = channels.filter((channel) => channel.categoryId === category.id);
            const categoryUnreadCount = categoryChannels.reduce(
              (total, channel) => total + (channel.canView ? unreadCounts[channel.id] ?? channel.unreadCount ?? 0 : 0),
              0
            );
            return (
              <li className={`channel-category${isDragging ? " channel-dragging" : ""}${isDropTarget ? " channel-drop-target" : ""}`} data-category-id={category.id} key={category.id}>
                <ChannelCategoryHeader
                  name={category.name}
                  expanded={expanded}
                  unreadCount={categoryUnreadCount}
                  onToggle={() => onToggleCategoryCollapsed(category.id)}
                  {...(canManageChannels
                    ? {
                        dragHandle: <GripIcon size={16} />,
                        dragHandleProps: dragReorder.getHandleProps("category", category.id)
                      }
                    : {})}
                  {...(canManageChannels
                    ? {
                        onCreateChannel: () => onCreateChannel(category.id),
                        isMenuOpen: openCategoryMenuId === category.id,
                        onOpenMenu: (event: MouseEvent<HTMLButtonElement>) => onOpenCategoryMenu(category.id, event.currentTarget)
                      }
                    : {})}
                />
                {expanded && (
                  <ul className="channel-category-list">{categoryChannels.map(renderChannel)}</ul>
                )}
              </li>
            );
          })}
        </ul>
        </div>
        <UserCard
          login={user.login}
          roleNames={user.roleNames}
          isOnline={isOnline}
          onLogout={onLogout}
          isLoggingOut={isLoggingOut}
          collapsed={collapsed}
        />
        {!collapsed && (
          <div
            className="sidebar-resize-handle"
            role="separator"
            aria-label="Изменить ширину списка каналов"
            aria-orientation="vertical"
            aria-valuemin={MIN_WIDTH}
            aria-valuemax={MAX_WIDTH}
            aria-valuenow={sidebarWidth}
            tabIndex={0}
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={commitResize}
            onPointerCancel={commitResize}
            onKeyDown={handleResizeKeyDown}
          />
        )}
        <div className="visually-hidden" role="status" aria-live="polite">{dragAnnouncement}</div>
        <MenuIcon className="channel-sidebar-collapsed-mark" />
      </aside>
      <CategoryDialog
        open={isCategoryDialogOpen}
        onClose={() => setIsCategoryDialogOpen(false)}
        mode="create"
        onSubmit={onCreateCategory}
        onError={onCategoryError}
      />
    </>
  );
}
