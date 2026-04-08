/**
 * Resolve the serial-queue key for a Feishu message event.
 *
 * Control commands (`/stop`, `/new`, `/status`, …) are routed to a dedicated
 * `${chatId}:control` queue so they are never blocked behind an active agent run.
 * This mirrors the Telegram channel's `getTelegramSequentialKey` pattern
 * (see `extensions/telegram/src/sequential-key.ts`).
 *
 * Normal messages use the plain `chatId` key (per-chat serial).
 */
export function resolveFeishuDispatchQueueKey<C = unknown>(params: {
  chatId: string;
  messageText: string;
  hasControlCommand: (text: string, cfg?: C) => boolean;
  cfg?: C;
}): string {
  const { chatId, messageText, hasControlCommand, cfg } = params;
  const trimmed = messageText.trim();
  if (trimmed && hasControlCommand(trimmed, cfg)) {
    return `${chatId}:control`;
  }
  return chatId;
}
