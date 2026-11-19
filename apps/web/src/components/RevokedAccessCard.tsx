import { LockIcon } from "./icons";

interface RevokedAccessCardProps {
  reason: string;
  onBack: () => void;
}

export function RevokedAccessCard({ reason, onBack }: RevokedAccessCardProps) {
  return (
    <section className="revoked-access-card" aria-labelledby="revoked-access-title">
      <LockIcon size={32} className="revoked-access-icon" />
      <h3 id="revoked-access-title">Доступ к каналу отозван</h3>
      <p className="revoked-access-reason" role="alert">{reason || "Доступ к каналу отозван"}</p>
      <p>История канала остаётся на экране, но новые сообщения вы не получите.</p>
      <button type="button" onClick={onBack}>К списку каналов</button>
    </section>
  );
}
