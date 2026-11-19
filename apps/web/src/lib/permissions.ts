export const PERMISSION_LABELS = {
  ADMINISTRATOR: "Администратор",
  MANAGE_ROLES: "Управлять ролями",
  MANAGE_CHANNELS: "Управлять каналами",
  MANAGE_MESSAGES: "Управлять сообщениями",
  VIEW_CHANNEL: "Видеть канал",
  SEND_MESSAGES: "Отправлять сообщения"
} as const;

export const PERMISSION_STATES = ["Разрешено", "Не выдано"] as const;
