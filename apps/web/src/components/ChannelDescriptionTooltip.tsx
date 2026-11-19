import { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FocusEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent, ReactElement } from "react";

interface TooltipTriggerProps {
  "aria-describedby"?: string;
  onMouseEnter?: (event: MouseEvent<HTMLButtonElement>) => void;
  onMouseLeave?: (event: MouseEvent<HTMLButtonElement>) => void;
  onFocus?: (event: FocusEvent<HTMLButtonElement>) => void;
  onBlur?: (event: FocusEvent<HTMLButtonElement>) => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}

interface ChannelDescriptionTooltipProps {
  description: string | null;
  canView: boolean;
  children: ReactElement<TooltipTriggerProps>;
}

export function ChannelDescriptionTooltip({ description, canView, children }: ChannelDescriptionTooltipProps) {
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const [visible, setVisible] = useState(false);
  const generatedId = useId();
  const tooltipId = `channel-tooltip-${generatedId.replace(/[^a-zA-Z0-9_-]/gu, "")}`;
  const enabled = canView && typeof description === "string" && description.length > 0;

  function clearTimer(): void {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }

  function showAfterDelay(trigger: HTMLButtonElement): void {
    clearTimer();
    triggerRef.current = trigger;
    timerRef.current = window.setTimeout(() => setVisible(true), 400);
  }

  function hide(): void {
    clearTimer();
    setVisible(false);
  }

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    const trigger = triggerRef.current;
    if (!enabled || !visible || !tooltip || !trigger) return;
    const bounds = trigger.getBoundingClientRect();
    const tooltipBounds = tooltip.getBoundingClientRect();
    const left = Math.max(8, Math.min(bounds.right + 8, window.innerWidth - tooltipBounds.width - 8));
    const top = Math.max(8, Math.min(bounds.top, window.innerHeight - tooltipBounds.height - 8));
    tooltip.style.setProperty("left", `${left}px`);
    tooltip.style.setProperty("top", `${top}px`);
  }, [enabled, visible]);

  useEffect(() => {
    if (!visible) return;
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [visible]);

  useEffect(() => () => clearTimer(), []);

  const original = children.props;
  const describedBy = [original["aria-describedby"], enabled ? tooltipId : undefined]
    .filter((value): value is string => Boolean(value))
    .join(" ") || undefined;
  const trigger = cloneElement(children, {
    ...(describedBy ? { "aria-describedby": describedBy } : {}),
    onMouseEnter: (event) => {
      original.onMouseEnter?.(event);
      if (enabled) showAfterDelay(event.currentTarget);
    },
    onMouseLeave: (event) => {
      original.onMouseLeave?.(event);
      hide();
    },
    onFocus: (event) => {
      original.onFocus?.(event);
      if (enabled) showAfterDelay(event.currentTarget);
    },
    onBlur: (event) => {
      original.onBlur?.(event);
      hide();
    },
    onKeyDown: (event) => {
      original.onKeyDown?.(event);
      if (event.key === "Escape") hide();
    }
  });

  return (
    <>
      {trigger}
      {enabled && typeof document !== "undefined" && createPortal(
        <div ref={tooltipRef} id={tooltipId} className="channel-tooltip" role="tooltip" hidden={!visible}>
          {description}
        </div>,
        document.body
      )}
    </>
  );
}
