import { execSync } from "node:child_process";
import { TEST_DATABASE_URL } from "./helpers.js";

/** Applies all Prisma migrations to the test database before the suite runs. */
export default function setup(): void {
  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
}
