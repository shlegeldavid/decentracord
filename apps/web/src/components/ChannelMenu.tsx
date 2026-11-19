import { FolderPlusIcon, GearIcon } from "./icons";
import { SidebarActionMenu } from "./ui/SidebarActionMenu";

interface ChannelMenuProps {
  name: string;
  trigger: HTMLButtonElement | null;
  onMove: () => void;
  canEditProperties: boolean;
  onProperties: () => void;
  onClose: () => void;
}

export function ChannelMenu({ name, trigger, onMove, canEditProperties, onProperties, onClose }: ChannelMenuProps) {
  function openDialog(action: () => void): void {
    trigger?.focus({ preventScroll: true });
    onClose();
    action();
  }

  return (
    <SidebarActionMenu label={`Действия с каналом «${name}»`} trigger={trigger} onClose={onClose}>
      {canEditProperties && (
        <button type="button" role="menuitem" tabIndex={-1} className="context-menu-item" onClick={() => openDialog(onProperties)}>
          <GearIcon />
          <span>Свойства канала…</span>
        </button>
      )}
      <button type="button" role="menuitem" tabIndex={-1} className="context-menu-item" onClick={() => openDialog(onMove)}>
        <FolderPlusIcon />
        <span>Переместить в категорию…</span>
      </button>
    </SidebarActionMenu>
  );
}
