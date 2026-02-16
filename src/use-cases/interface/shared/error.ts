export class IError extends Error {
  code: string;

  constructor(message: string, code: string = "UNKNOWN_ERROR") {
    super(message);
    this.name = "IError";
    this.code = code;
  }

  getCode(): string {
    return this.code;
  }
}

