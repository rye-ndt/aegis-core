export interface IPrivyLoginInput {
  privyToken: string;
  telegramChatId?: string;   // optional — link session during login
}

export interface IAuthUseCase {
  loginWithPrivy(input: IPrivyLoginInput): Promise<{ expiresAtEpoch: number; userId: string }>;
  resolveUserId(privyToken: string): Promise<string | null>;
}
