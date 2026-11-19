import { useEffect, useLayoutEffect, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";

interface SidebarActionMenuProps {
  label: string;
  trigger: HTMLButtonElement | null;
  onClose: () => void;
  children: ReactNode;
}

const itemSelector = "[role='menuitem']:not(:disabled)";

function positionMenu(menu: HTMLElement, anchor: DOMRect): void {
  const { width, height } = menu.getBoundingClientRect();
  const gutter = 8;
  const gap = 4;
  const below = window.innerHeight - anchor.bottom - gutter;
  const above = anchor.top - gutter;
  const left = Math.max(gutter, Math.min(anchor.right - width, window.innerWidth - width - gutter));
  const preferredTop = height + gap > below && above > below ? anchor.top - height - gap : anchor.bottom + gap;
  const top = Math.max(gutter, Math.min(preferredTop, window.innerHeight - height - gutter));

  menu.style.setProperty("left", `${left}px`);
  menu.style.setProperty("top", `${top}px`);
}

export function SidebarActionMenu({ label, trigger, onClose, children }: SidebarActionMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu || !trigger) return;

    positionMenu(menu, trigger.getBoundingClientRect());
    menu.querySelector<HTMLButtonElement>(itemSelector)?.focus({ preventScroll: true });
  }, [trigger]);

  useEffect(() => {
    function dismissOutside(event: Event): void {
      if (!(event.target instanceof Node)) return;
      if (menuRef.current?.contains(event.target) || trigger?.contains(event.target)) return;
      onClose();
    }

    function syncPosition(event: Event): void {
      const menu = menuRef.current;
      if (!menu || !trigger) return;
      const scroller = event.target;
      if (event.type === "scroll" && (!(scroller instanceof Node) || !scroller.contains(trigger))) return;

      const anchor = trigger.getBoundingClientRect();
      const scrollBounds = event.type === "scroll" && scroller instanceof Element ? scroller.getBoundingClientRect() : null;
      const visibleTop = Math.max(0, scrollBounds?.top ?? 0);
      const visibleBottom = Math.min(window.innerHeight, scrollBounds?.bottom ?? window.innerHeight);
      if (anchor.bottom <= visibleTop || anchor.top >= visibleBottom || anchor.width === 0) {
        if (menu.contains(document.activeElement)) trigger.focus({ preventScroll: true });
        onClose();
        return;
      }
      positionMenu(menu, anchor);
    }

    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("focusin", dismissOutside);
    document.addEventListener("scroll", syncPosition, true);
    window.addEventListener("resize", syncPosition);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("focusin", dismissOutside);
      document.removeEventListener("scroll", syncPosition, true);
      window.removeEventListener("resize", syncPosition);
    };
  }, [onClose, trigger]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
      trigger?.focus({ preventScroll: true });
      onClose();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;

    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(itemSelector));
    if (items.length === 0) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const offset = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
      : (currentIndex + offset + items.length) % items.length;
    items[nextIndex]?.focus();
  }

  return (
    <div
      ref={menuRef}
      className="context-menu sidebar-action-menu"
      role="menu"
      aria-label={label}
      onKeyDown={handleKeyDown}
    >
      {children}
    </div>
  );
}
