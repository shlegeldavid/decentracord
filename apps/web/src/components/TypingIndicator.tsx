interface TypingIndicatorProps {
  // `null` — никто не печатает; строка остаётся пустой, но место зарезервировано
  // (`min-height`), чтобы появление индикатора не сдвигало композер.
  label: string | null;
}

/**
 * Строка набора над композером переписки.
 *
 * Текст приходит готовым: имя одного печатающего или «Печатают…» без имён.
 * Строка не фокусируется и не имеет переходов — она объявляется один раз
 * как `role="status"`; исчезновение намеренно не объявляется.
 */
export function TypingIndicator({ label }: TypingIndicatorProps) {
  return (
    <p className="typing-indicator" role="status" aria-live="polite" aria-atomic="true">
      {label ?? ""}
    </p>
  );
}
