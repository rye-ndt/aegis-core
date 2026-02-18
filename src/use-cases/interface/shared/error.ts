import {
  ERROR_CODES,
  ERROR_CODES_MAP,
} from "../../../helpers/enums/errorCodes.enum";

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

export const throwError = (code: ERROR_CODES): never => {
  throw new IError(ERROR_CODES_MAP[code], code);
};
