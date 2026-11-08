import * as argon2 from "argon2";

const minimumPasswordLength = 12;
const maximumPasswordLength = 128;

function isValidPassword(password: string): boolean {
  const length = Array.from(password).length;
  return length >= minimumPasswordLength && length <= maximumPasswordLength;
}

export class PasswordService {
  async hash(password: string): Promise<string> {
    if (!isValidPassword(password)) throw new Error("Invalid password length");

    return argon2.hash(password, {
      memoryCost: 19 * 1024,
      parallelism: 1,
      timeCost: 2,
      type: argon2.argon2id
    });
  }

  async verify(password: string, passwordHash: string): Promise<boolean> {
    if (!isValidPassword(password)) return false;

    try {
      return await argon2.verify(passwordHash, password);
    } catch {
      return false;
    }
  }
}
