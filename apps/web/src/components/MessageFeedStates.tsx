interface FeedLoadingStateProps {
  message?: string;
}

interface FeedErrorStateProps {
  onRetry: () => void;
}

interface FeedEmptyStateProps {
  heading?: string;
  body?: string;
}

/**
 * Пустое состояние ленты. По умолчанию — канальные строки; переписка передаёт
 * свои заголовок и пояснение по типу переписки.
 */
export function FeedEmptyState({
  heading = "Это начало канала — напишите первое",
  body = "Отправьте первое сообщение — его увидят все участники этого канала."
}: FeedEmptyStateProps) {
  return (
    <div className="feed-state feed-empty-state">
      <h3>{heading}</h3>
      <p>{body}</p>
    </div>
  );
}

export function FeedLoadingState({ message = "Загружаем историю сообщений…" }: FeedLoadingStateProps) {
  return (
    <p className="feed-state feed-loading-state" aria-live="polite">
      <span className="feed-loading-spinner" aria-hidden="true" />
      {message}
    </p>
  );
}

export function FeedErrorState({ onRetry }: FeedErrorStateProps) {
  return (
    <div className="feed-state feed-error-state" role="alert">
      <h3>Не удалось загрузить историю сообщений</h3>
      <p>Проверьте соединение и нажмите «Повторить».</p>
      <button type="button" className="btn btn-primary" onClick={onRetry}>Повторить</button>
    </div>
  );
}
