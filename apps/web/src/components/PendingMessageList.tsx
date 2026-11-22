import { MessageMarkdown } from "../markdown/MessageMarkdown";
import type { PendingMessage } from "../lib/messageOutbox";
import { ClockIcon } from "./icons";

export type { PendingMessage } from "../lib/messageOutbox";

function PendingMessageStatus({ message, onRetry }: { message: PendingMessage; onRetry: (id: string) => void }) {
  switch (message.state) {
    case "sending":
      return <span className="message-clock" aria-label="Отправляется"><ClockIcon size={16} /></span>;
    case "failed":
      return (
        <>
          <span className="message-error">Не отправлено</span>
          <button type="button" className="message-action" onClick={() => onRetry(message.clientRequestId)}>
            Повторить
          </button>
        </>
      );
    case "queued":
      return <span className="message-queued">В очереди</span>;
    case "rejected":
      return <span className="message-error">Отправка отклонена: {message.reason || "Отправка отклонена."}</span>;
  }
}

export function PendingMessageList({
  messages,
  onRetry
}: {
  messages: PendingMessage[];
  onRetry: (id: string) => void;
}) {
  if (messages.length === 0) return null;
  return (
    <div className="message-pending-list" aria-live="polite">
      {messages.map((message) => (
        <article
          className={`message-row message-pending ${message.state}`}
          data-client-request-id={message.clientRequestId}
          key={message.clientRequestId}
        >
          <span className="message-avatar-spacer" aria-hidden="true" />
          <div className="message-content">
            <header className="message-header">
              <span className="message-author">Вы</span>
            </header>
            <MessageMarkdown content={message.content} mentions={[]} />
            <div className="message-meta">
              <PendingMessageStatus message={message} onRetry={onRetry} />
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}
