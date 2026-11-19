import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

export type ReorderItemKind = "channel" | "category";

export interface ReorderItem {
  kind: ReorderItemKind;
  id: string;
}

export type ReorderDropTarget =
  | { type: "category"; categoryId: string | null }
  | { type: "channel"; categoryId: string | null; channelId: string; position: "before" | "after" };

interface ActiveDrag extends ReorderItem {
  pointerId: number;
  handle: HTMLElement;
  list: HTMLElement;
  clientX: number;
  clientY: number;
}

const UNCATEGORIZED_ID = "__uncategorized__";

function sameTarget(left: ReorderDropTarget | null, right: ReorderDropTarget | null): boolean {
  if (left === right) return true;
  if (!left || !right || left.type !== right.type || left.categoryId !== right.categoryId) return false;
  if (left.type === "category" || right.type === "category") return left.type === right.type;
  return left.channelId === right.channelId && left.position === right.position;
}

export function useDragReorder(onDrop: (item: ReorderItem, target: ReorderDropTarget) => void) {
  const activeDrag = useRef<ActiveDrag | null>(null);
  const dropTargetRef = useRef<ReorderDropTarget | null>(null);
  const autoScrollTimer = useRef<number | null>(null);
  const [draggingItem, setDraggingItem] = useState<ReorderItem | null>(null);
  const [dropTarget, setDropTarget] = useState<ReorderDropTarget | null>(null);

  const updateTarget = useCallback((target: ReorderDropTarget | null) => {
    if (sameTarget(dropTargetRef.current, target)) return;
    dropTargetRef.current = target;
    setDropTarget(target);
  }, []);

  const findTarget = useCallback((active: ActiveDrag, clientX: number, clientY: number): ReorderDropTarget | null => {
    const hit = document.elementFromPoint(clientX, clientY);
    const categoryElement = hit?.closest<HTMLElement>(".channel-category[data-category-id]");
    if (!categoryElement || !active.list.contains(categoryElement)) return null;

    const categoryId = categoryElement.dataset.categoryId;
    if (!categoryId) return null;
    if (active.kind === "category") {
      return categoryId === UNCATEGORIZED_ID || categoryId === active.id
        ? null
        : { type: "category", categoryId };
    }

    const channelElement = hit?.closest<HTMLElement>("[data-channel-id]");
    if (channelElement && categoryElement.contains(channelElement)) {
      const channelId = channelElement.dataset.channelId;
      if (!channelId || channelId === active.id) return null;
      const bounds = channelElement.getBoundingClientRect();
      return {
        type: "channel",
        categoryId: categoryId === UNCATEGORIZED_ID ? null : categoryId,
        channelId,
        position: clientY < bounds.top + bounds.height / 2 ? "before" : "after"
      };
    }

    return {
      type: "category",
      categoryId: categoryId === UNCATEGORIZED_ID ? null : categoryId
    };
  }, []);

  const stopAutoScroll = useCallback(() => {
    if (autoScrollTimer.current === null) return;
    window.clearInterval(autoScrollTimer.current);
    autoScrollTimer.current = null;
  }, []);

  const releasePointer = useCallback((active: ActiveDrag) => {
    try {
      if (active.handle.hasPointerCapture(active.pointerId)) active.handle.releasePointerCapture(active.pointerId);
    } catch {
      // The browser may already have released the pointer after cancellation.
    }
  }, []);

  const cancelDrag = useCallback(() => {
    const active = activeDrag.current;
    if (active) releasePointer(active);
    activeDrag.current = null;
    stopAutoScroll();
    dropTargetRef.current = null;
    setDraggingItem(null);
    setDropTarget(null);
  }, [releasePointer, stopAutoScroll]);

  const onHandlePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>, kind: ReorderItemKind, id: string) => {
    if (activeDrag.current || (event.pointerType === "mouse" && event.button !== 0)) return;
    const list = event.currentTarget.closest<HTMLElement>(".channel-list");
    if (!list) return;

    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      return;
    }

    const active: ActiveDrag = {
      kind,
      id,
      pointerId: event.pointerId,
      handle: event.currentTarget,
      list,
      clientX: event.clientX,
      clientY: event.clientY
    };
    activeDrag.current = active;
    setDraggingItem({ kind, id });
    updateTarget(findTarget(active, event.clientX, event.clientY));

    autoScrollTimer.current = window.setInterval(() => {
      const current = activeDrag.current;
      if (!current) return;
      const bounds = current.list.getBoundingClientRect();
      let direction = 0;
      if (current.clientY >= bounds.top && current.clientY < bounds.top + 48 && current.list.scrollTop > 0) {
        direction = -1;
      } else if (
        current.clientY <= bounds.bottom && current.clientY > bounds.bottom - 48 &&
        current.list.scrollTop < current.list.scrollHeight - current.list.clientHeight
      ) {
        direction = 1;
      }
      if (direction === 0) return;
      current.list.scrollTop += direction * 8;
      updateTarget(findTarget(current, current.clientX, current.clientY));
    }, 100);
  }, [findTarget, updateTarget]);

  const onHandlePointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const active = activeDrag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    active.clientX = event.clientX;
    active.clientY = event.clientY;
    updateTarget(findTarget(active, event.clientX, event.clientY));
  }, [findTarget, updateTarget]);

  const onHandlePointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const active = activeDrag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    active.clientX = event.clientX;
    active.clientY = event.clientY;
    const target = findTarget(active, event.clientX, event.clientY);
    releasePointer(active);
    activeDrag.current = null;
    stopAutoScroll();
    dropTargetRef.current = null;
    setDraggingItem(null);
    setDropTarget(null);
    if (target) onDrop({ kind: active.kind, id: active.id }, target);
  }, [findTarget, onDrop, releasePointer, stopAutoScroll]);

  const onHandlePointerCancel = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (activeDrag.current?.pointerId === event.pointerId) cancelDrag();
  }, [cancelDrag]);

  useEffect(() => {
    if (!draggingItem) return undefined;
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancelDrag();
    };
    window.addEventListener("keydown", cancelOnEscape);
    return () => window.removeEventListener("keydown", cancelOnEscape);
  }, [cancelDrag, draggingItem]);

  useEffect(() => () => cancelDrag(), [cancelDrag]);

  return {
    draggingItem,
    dropTarget,
    getHandleProps: (kind: ReorderItemKind, id: string) => ({
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => onHandlePointerDown(event, kind, id),
      onPointerMove: onHandlePointerMove,
      onPointerUp: onHandlePointerUp,
      onPointerCancel: onHandlePointerCancel
    })
  };
}
