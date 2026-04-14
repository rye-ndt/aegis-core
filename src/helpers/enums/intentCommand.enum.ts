export enum INTENT_COMMAND {
  MONEY   = "/money",
  BUY     = "/buy",
  SELL    = "/sell",
  CONVERT = "/convert",
  TOPUP   = "/topup",
  DCA     = "/dca",
}

/**
 * Returns the INTENT_COMMAND if the raw message text starts with one
 * of the recognised slash commands, otherwise null.
 */
export function parseIntentCommand(text: string): INTENT_COMMAND | null {
  const lower = text.trim().toLowerCase();
  for (const cmd of Object.values(INTENT_COMMAND)) {
    if (lower === cmd || lower.startsWith(`${cmd} `) || lower.startsWith(`${cmd}\n`)) {
      return cmd as INTENT_COMMAND;
    }
  }
  return null;
}
