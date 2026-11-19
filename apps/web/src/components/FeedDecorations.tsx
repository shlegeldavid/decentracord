interface DayDividerProps {
  label: string;
}

interface JumpToLatestBarProps {
  onJump: () => void;
}

interface NewMessagesDividerProps {
  onJump: () => void;
}

export function DayDivider({ label }: DayDividerProps) {
  return <div className="day-divider">{label}</div>;
}

export function NewMessagesDivider({ onJump }: NewMessagesDividerProps) {
  return (
    <div className="unread-divider">
      <button type="button" aria-label="Новые сообщения: к первому непрочитанному" onClick={onJump}>
        Новые сообщения
      </button>
    </div>
  );
}

export function JumpToLatestBar({ onJump }: JumpToLatestBarProps) {
  return (
    <button type="button" className="jump-bar" onClick={onJump}>
      К последним сообщениям
    </button>
  );
}
