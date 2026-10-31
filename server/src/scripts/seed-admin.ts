import "dotenv/config";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config.js";
import { createDatabase } from "../db.js";
import { AppError } from "../errors.js";
import { parseInput, emailSchema, passwordSchema } from "../lib/validation.js";
import { createUser } from "../services/user.service.js";

/**
 * Creates the first admin account (FR-AUTH-08).
 * Usage: npm run seed:admin -- <email> <password>
 * The password may also be supplied via SEED_ADMIN_PASSWORD to keep it out of shell history.
 */
async function main(): Promise<void> {
  const [rawEmail, rawPassword] = process.argv.slice(2);
  const email = parseInput(emailSchema, rawEmail ?? "");
  const password = parseInput(passwordSchema, rawPassword ?? process.env.SEED_ADMIN_PASSWORD ?? "");

  const config = loadConfig();
  const db = createDatabase(config.databaseUrl);
  try {
    const user = await createUser(
      db,
      {
        requestId: `seed-${randomUUID()}`,
        ipAddress: null,
        actor: { userId: null, email: "system:seed-admin" },
      },
      { email, role: "admin", password, displayName: "Administrator" },
    );
    console.log(`Created admin account ${user.email} (id: ${user.id}).`);
  } catch (error) {
    if (error instanceof AppError) {
      console.error(`${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    await db.$disconnect();
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof AppError) {
    console.error(error.details.map((d) => d.message).join(" ") || error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
