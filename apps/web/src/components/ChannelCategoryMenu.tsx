import { ChevronIcon, EditIcon, TrashIcon } from "./icons";
import { SidebarActionMenu } from "./ui/SidebarActionMenu";

export interface ChannelCategoryMenuProps {
  name: string;
  trigger: HTMLButtonElement | null;
  expanded: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onToggle: () => void;
  onRename: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onClose: () => void;
}

export function ChannelCategoryMenu({
  name,
  trigger,
  expanded,
  canMoveUp,
  canMoveDown,
  onToggle,
  onRename,
  onDelete,
  onMoveUp,
  onMoveDown,
  onClose
}: ChannelCategoryMenuProps) {
  function selectAction(action: () => void): void {
    trigger?.focus({ preventScroll: true });
    onClose();
    action();
  }

  function moveCategory(action: () => void): void {
    selectAction(action);
    window.requestAnimationFrame(() => {
      if (document.activeElement === document.body) trigger?.focus({ preventScroll: true });
    });
  }

  return (
    <SidebarActionMenu label={`Действия с категорией «${name}»`} trigger={trigger} onClose={onClose}>
      <button type="button" role="menuitem" tabIndex={-1} className="context-menu-item" onClick={() => selectAction(onRename)}>
        <EditIcon />
        <span>Переименовать…</span>
      </button>
      <button type="button" role="menuitem" tabIndex={-1} className="context-menu-item" onClick={() => selectAction(onToggle)}>
        <ChevronIcon className={expanded ? "menu-chevron-up" : ""} />
        <span>{expanded ? "Свернуть" : "Развернуть"}</span>
      </button>
      <div role="separator" className="context-menu-separator" />
      <button type="button" role="menuitem" tabIndex={-1} className="context-menu-item" onClick={() => moveCategory(onMoveUp)} disabled={!canMoveUp}>
        <ChevronIcon className="menu-chevron-up" />
        <span>Переместить выше</span>
      </button>
      <button type="button" role="menuitem" tabIndex={-1} className="context-menu-item" onClick={() => moveCategory(onMoveDown)} disabled={!canMoveDown}>
        <ChevronIcon />
        <span>Переместить ниже</span>
      </button>
      <div role="separator" className="context-menu-separator" />
      <button type="button" role="menuitem" tabIndex={-1} className="context-menu-item context-menu-item-danger" onClick={() => selectAction(onDelete)}>
        <TrashIcon />
        <span>Удалить…</span>
      </button>
    </SidebarActionMenu>
  );
}
