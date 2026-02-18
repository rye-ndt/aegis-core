import { EMAIL_VALIDATION } from "../../helpers/enums/emailValidation.enum";
import { ERROR_CODES } from "../../helpers/enums/errorCodes.enum";
import { PASSWORD_VALIDATION } from "../../helpers/enums/passwordValidation.enum";
import { USER_STATUSES } from "../../helpers/enums/statuses.enum";
import { throwError } from "../../use-cases/interface/shared/error";

export interface IUserInstance {
  email?: string;
  status?: USER_STATUSES;
}

export class UserEntity {
  private readonly email: string;
  private status: USER_STATUSES;

  constructor(instance: IUserInstance) {
    this.email = instance.email ?? "";
    this.status = instance.status ?? USER_STATUSES.NEED_VERIFICATION;

    if (!this.hasValidEmail(this.email)) throwError(ERROR_CODES.INVALID_EMAIL);
  }

  getStatus(): USER_STATUSES {
    return this.status;
  }

  getEmail(): string {
    if (!this.email) throwError(ERROR_CODES.USER_NOT_FOUND);

    return this.email;
  }

  verifyEmail(target: string, input: string): void {
    if (!this.canVerifyEmail()) throwError(ERROR_CODES.USER_ALREADY_VERIFIED);

    if (target !== input) throwError(ERROR_CODES.INVALID_VERIFICATION_CODE);

    this.status = USER_STATUSES.ACTIVE;
  }

  private canVerifyEmail(): boolean {
    return this.status === USER_STATUSES.NEED_VERIFICATION;
  }

  usePassword(plain: string): void {
    if (plain.length < PASSWORD_VALIDATION.MIN_LENGTH)
      throwError(ERROR_CODES.WEAK_PASSWORD);
    const re = (p: string) => new RegExp(p).test(plain);
    if (!re(PASSWORD_VALIDATION.REGEX_LOWERCASE))
      throwError(ERROR_CODES.WEAK_PASSWORD);
    if (!re(PASSWORD_VALIDATION.REGEX_UPPERCASE))
      throwError(ERROR_CODES.WEAK_PASSWORD);
    if (!re(PASSWORD_VALIDATION.REGEX_NUMBER))
      throwError(ERROR_CODES.WEAK_PASSWORD);
    if (!re(PASSWORD_VALIDATION.REGEX_SPECIAL))
      throwError(ERROR_CODES.WEAK_PASSWORD);
  }

  private hasValidEmail(email: string): boolean {
    return new RegExp(EMAIL_VALIDATION.REGEX_PATTERN).test(email);
  }
}
