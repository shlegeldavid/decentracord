// Логотип организации принимается только как PNG и хранится прямо в строке
// организации (`organization.logo bytea`). Проверка выполняется без внешних
// зависимостей: сигнатура PNG и заголовок `IHDR` дают и размер файла, и его
// размеры в пикселях. Смещения проверены генерацией реального PNG:
// 0 — сигнатура (8 байт), 8 — длина первого чанка, 12 — тип чанка,
// 16 — ширина, 20 — высота.

export const MAX_LOGO_BYTES = 512 * 1024;
export const MAX_LOGO_EDGE = 512;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_SIGNATURE_LENGTH = 8;
const PNG_IHDR_LENGTH = 13;
const PNG_MINIMUM_LENGTH = 24;

/** Возвращает размеры PNG в пикселях или null, если это не корректный PNG. */
export function readPngSize(buffer: Buffer): { width: number; height: number } | null {
  if (!Buffer.isBuffer(buffer) || buffer.length < PNG_MINIMUM_LENGTH) return null;
  if (!buffer.subarray(0, PNG_SIGNATURE_LENGTH).equals(PNG_SIGNATURE)) return null;
  if (buffer.readUInt32BE(8) !== PNG_IHDR_LENGTH) return null;
  if (buffer.subarray(12, 16).toString("ascii") !== "IHDR") return null;

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width < 1 || height < 1) return null;
  return { width, height };
}
