export interface IRegisterInput {
  email: string;
  password: string;
  username: string;
}

export interface ILoginInput {
  email: string;
  password: string;
}

export interface IAuthUseCase {
  register(input: IRegisterInput): Promise<{ userId: string }>;
  login(input: ILoginInput): Promise<{ token: string; expiresAtEpoch: number; userId: string }>;
  validateToken(token: string): Promise<{ userId: string; expiresAtEpoch: number }>;
}
