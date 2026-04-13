export interface ITelegramHandleResolver {
  /**
   * Resolves a public Telegram username to a numeric user ID string.
   * Throws TelegramHandleNotFoundError if the username does not exist or is private.
   */
  resolveHandle(username: string): Promise<string>;
}

export class TelegramHandleNotFoundError extends Error {
  constructor(handle: string, cause?: string) {
    super(`Could not resolve Telegram handle @${handle}${cause ? `: ${cause}` : ""}`);
    this.name = "TelegramHandleNotFoundError";
  }
}
