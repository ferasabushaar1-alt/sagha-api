/**
 * Seed admin user for local SQLite.
 *   npm run seed:admin
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { initDatabase } from "../db/init.js";
import { users } from "../db/schema.js";
import { hashPassword } from "../lib/passwords.js";

async function main() {
  await initDatabase();

  const email = (process.env.ADMIN_EMAIL ?? "admin@sagha.local").toLowerCase();
  const password = process.env.ADMIN_PASSWORD ?? "ChangeMeNow1!";
  const fullName = process.env.ADMIN_NAME ?? "Sagha Admin";

  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing) {
    console.log("Admin already exists:", existing.id, existing.email);
    process.exit(0);
  }

  const passwordHash = await hashPassword(password);
  const [created] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      role: "admin",
      fullName,
      verificationStatus: "verified",
      verifiedAt: new Date(),
      businessName: null,
    })
    .returning();

  console.log("Admin created:", created.id, created.email);
  console.log("Login with:", email, "/", password);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
