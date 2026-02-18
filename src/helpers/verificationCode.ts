import crypto from "crypto";
import { VERIFICATION_CODE_LENGTH } from "./enums/verificationCode.enum";

/**
 * Generate a numeric verification code of VERIFICATION_CODE_LENGTH.DIGITS digits.
 */
export function generateVerificationCode(): string {
  const min = 10 ** (VERIFICATION_CODE_LENGTH.DIGITS - 1);
  const max = 10 ** VERIFICATION_CODE_LENGTH.DIGITS - 1;
  const code = crypto.randomInt(min, max + 1);
  return String(code);
}
