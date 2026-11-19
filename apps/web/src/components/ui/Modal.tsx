import { useEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  label?: string;
  labelledBy?: string;
  describedBy?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  dialogClassName?: string;
}

type ModalLayer = {
  id: symbol;
  overlay: HTMLDivElement | null;
};

const modalLayers: ModalLayer[] = [];
let appShellBeforeModal: { element: HTMLElement; inert: boolean } | null = null;

function updateModalLayers(): void {
  const appShell = document.querySelector<HTMLElement>(".app-shell");
  if (modalLayers.length > 0) {
    if (appShell && appShellBeforeModal === null) {
      appShellBeforeModal = { element: appShell, inert: appShell.inert };
    }
    if (appShell) appShell.inert = true;
    const topLayer = modalLayers[modalLayers.length - 1];
    for (const layer of modalLayers) {
      if (layer.overlay) layer.overlay.inert = layer !== topLayer;
    }
    return;
  }

  for (const layer of modalLayers) {
    if (layer.overlay) layer.overlay.inert = false;
  }
  if (appShellBeforeModal) {
    if (appShellBeforeModal.element.isConnected) {
      appShellBeforeModal.element.inert = appShellBeforeModal.inert;
    }
    appShellBeforeModal = null;
  }
}

export function Modal({
  open,
  onClose,
  children,
  label,
  labelledBy,
  describedBy,
  initialFocusRef,
  dialogClassName = "modal-dialog"
}: ModalProps) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  const idRef = useRef(Symbol("modal"));
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open || typeof document === "undefined") return;

    const id = idRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const layer = { id, overlay: overlayRef.current };
    modalLayers.push(layer);
    updateModalLayers();

    const focusFrame = window.requestAnimationFrame(() => {
      const labelledHeading = labelledBy ? document.getElementById(labelledBy) : null;
      const focusTarget = initialFocusRef?.current ?? labelledHeading ?? dialogRef.current;
      focusTarget?.focus({ preventScroll: true });
    });
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || modalLayers[modalLayers.length - 1]?.id !== id) return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener("keydown", handleEscape);

    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleEscape);
      const index = modalLayers.findIndex((entry) => entry.id === id);
      const wasTopLayer = index === modalLayers.length - 1;
      if (index !== -1) modalLayers.splice(index, 1);
      updateModalLayers();

      if (!wasTopLayer) return;
      const nextLayer = modalLayers[modalLayers.length - 1];
      if (nextLayer) {
        if (previousFocus?.isConnected && nextLayer.overlay?.contains(previousFocus)) {
          window.requestAnimationFrame(() => previousFocus.focus({ preventScroll: true }));
        } else {
          const nextDialog = nextLayer.overlay?.querySelector<HTMLElement>("[role='dialog']");
          window.requestAnimationFrame(() => nextDialog?.focus({ preventScroll: true }));
        }
        return;
      }
      if (previousFocus?.isConnected) {
        window.requestAnimationFrame(() => previousFocus.focus({ preventScroll: true }));
      }
    };
  }, [initialFocusRef, labelledBy, open]);

  if (open === false || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="modal-overlay"
      ref={overlayRef}
      onClick={(event) => {
        if (event.target === event.currentTarget) onCloseRef.current();
      }}
    >
      <div
        ref={dialogRef}
        className={dialogClassName}
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy ? undefined : label ?? "Диалог"}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}
