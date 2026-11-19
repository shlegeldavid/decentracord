import { useEffect, useRef } from "react";
import { LockIcon } from "./icons";

interface DmHiddenCardProps {
  onBack: () => void;
}

/**
 * Карточка «Переписка скрыта».
 *
 * Переписка на двоих исчезает из списка, когда собеседника отключили. История и
 * доступ к ней у активного участника сохраняются, поэтому карточка объясняет
 * причину и не убирает уже загруженные сообщения. Классы взяты у карточки
 * отозванного доступа: новых стилей фаза не вводит.
 */
export function DmHiddenCard({ onBack }: DmHiddenCardProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);

  // Фокус переводится на заголовок: карточка появляется без действия участника.
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  return (
    <section className="revoked-access-card" aria-labelledby="dm-hidden-title">
      <LockIcon size={32} className="revoked-access-icon" />
      <h3 id="dm-hidden-title" ref={titleRef} tabIndex={-1}>Переписка скрыта</h3>
      <p className="revoked-access-reason" role="alert">Один из участников отключён.</p>
      <p>История сохранится и вернётся, когда участника снова включат.</p>
      <button type="button" className="btn btn-secondary" onClick={onBack}>К списку переписок</button>
    </section>
  );
}
