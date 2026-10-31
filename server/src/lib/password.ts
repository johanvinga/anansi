import bcrypt from "bcryptjs";

/** bcrypt cost factor required by NFR-01 (≥ 12). */
const BCRYPT_COST = 12;

export function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_COST);
}

export function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}

let dummyHash: Promise<string> | undefined;

/**
 * Runs a comparison even when the account does not exist, so response time
 * does not reveal whether an email is registered (FR-AUTH-07).
 */
export async function verifyAgainstDummyHash(plaintext: string): Promise<false> {
  dummyHash ??= hashPassword("dummy-password-for-timing-only");
  await verifyPassword(plaintext, await dummyHash);
  return false;
}
