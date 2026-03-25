export class GmailNotConnectedError extends Error {
  constructor(userId: string) {
    super(`Gmail not connected for user ${userId}`);
    this.name = "GmailNotConnectedError";
  }
}
