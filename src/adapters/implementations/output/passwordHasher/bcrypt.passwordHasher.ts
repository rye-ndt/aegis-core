import bcrypt from "bcrypt";
import { BCRYPT_CONFIG } from "../../../../helpers/enums/passwordHasher.enum";
import type { IPasswordHasher } from "../../../../use-cases/interface/output/passwordHasher.interface";

export class BcryptPasswordHasher implements IPasswordHasher {
  async hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, BCRYPT_CONFIG.SALT_ROUNDS);
  }

  async compare(plain: string, hashed: string): Promise<boolean> {
    return bcrypt.compare(plain, hashed);
  }
}
