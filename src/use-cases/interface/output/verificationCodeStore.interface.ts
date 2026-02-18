export interface IVerificationCode {
  code: string;
  createdAtEpoch: number;
}

export interface IVerificationCodeStore {
  set(
    key: string,
    verificationCode: IVerificationCode,
    ttlSeconds: number,
  ): Promise<void>;

  get(key: string): Promise<IVerificationCode>;
}
