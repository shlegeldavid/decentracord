import { useEffect, useRef } from "react";
import type { useConversationActions, useConversationState } from "../hooks/useWorkspaceConversations";
import { AddDmMembersDialog } from "./AddDmMembersDialog";
import { CreateDmDialog } from "./CreateDmDialog";

interface ConversationControlsProps {
  state: ReturnType<typeof useConversationState>;
  actions: ReturnType<typeof useConversationActions>;
  csrfToken: string;
  onSessionExpired: () => void;
}

export function WorkspaceConversationControls({ state, actions, csrfToken, onSessionExpired }: ConversationControlsProps) {
  const { menu, setMenu, selectedConversation, createOpen, setCreateOpen, addMembersOpen, setAddMembersOpen } = state;
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".context-menu") !== null) return;
      setMenu(null);
    };
    document.addEventListener("pointerdown", closeOnOutside);
    return () => document.removeEventListener("pointerdown", closeOnOutside);
  }, [menu, setMenu]);

  function closeMenuAndRestoreFocus(conversationId: string): void {
    setMenu(null);
    window.requestAnimationFrame(() => {
      const id = CSS.escape(conversationId);
      document.querySelector<HTMLElement>(`[data-dm-id="${id}"] .dm-row-select`)?.focus();
    });
  }

  return (
    <>
      {menu && (
        <div
          ref={menuRef}
          className="context-menu"
          role="menu"
          aria-label="Действия с перепиской"
          style={{ left: menu.position.x, top: menu.position.y }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            closeMenuAndRestoreFocus(menu.conversationId);
          }}
        >
          <button
            type="button"
            role="menuitem"
            className="context-menu-item"
            onClick={() => void actions.closeConversationFromMenu(menu.conversationId)}
          >
            <span>Закрыть переписку</span>
          </button>
        </div>
      )}
      <CreateDmDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        csrfToken={csrfToken}
        onCreated={actions.onCreated}
        onSessionExpired={onSessionExpired}
      />
      {selectedConversation?.kind === "group" && (
        <AddDmMembersDialog
          open={addMembersOpen}
          onClose={() => setAddMembersOpen(false)}
          conversation={selectedConversation}
          csrfToken={csrfToken}
          onAdded={actions.onMembersAdded}
          onSessionExpired={onSessionExpired}
        />
      )}
    </>
  );
}
