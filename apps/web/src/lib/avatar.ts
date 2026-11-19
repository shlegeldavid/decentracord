/**
 * Плоская палитра дефолтных аватаров.
 *
 * Цвет выбирается детерминированно из логина (хеш, см. `avatarIndex`), поэтому
 * у одного и того же человека аватар всегда одинаковый. Заливка — сплошная:
 * градиент выбивался из плоского интерфейса. Все цвета подобраны так, чтобы
 * белые инициалы проходили AA: минимальный контраст 5.10:1 (`#0E7C6B`).
 */
const AVATAR_COLOURS = [
  "#3B5BDB", // синий
  "#5B5BD6", // индиго
  "#7048E8", // фиолет
  "#0E7C6B", // бирюза
  "#0B7285", // циан
  "#1163A8" // лазурь
] as const;

export function avatarIndex(login: string): number {
  let hash = 0;
  for (let index = 0; index < login.length; index += 1) {
    hash = (hash * 31 + login.charCodeAt(index)) >>> 0;
  }
  return hash % AVATAR_COLOURS.length;
}

export function avatarColor(login: string): string {
  return AVATAR_COLOURS[avatarIndex(login)] ?? AVATAR_COLOURS[0]!;
}

export function initials(login: string): string {
  const firstCharacter = Array.from(login.trim())[0];
  return firstCharacter ? firstCharacter.toLocaleUpperCase("ru-RU") : "";
}
