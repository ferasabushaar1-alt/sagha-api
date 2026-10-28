import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { db } from "../db/client.js";
import {
  creditAccounts,
  orders,
  passwordResets,
  users,
  type User,
  type UserRole,
} from "../db/schema.js";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  unauthorized,
} from "../lib/errors.js";
import { signToken } from "../lib/jwt.js";
import { hashPassword, verifyPassword } from "../lib/passwords.js";
import { isCountryCode, type CountryCode } from "../lib/countries.js";
import { publicUser } from "../lib/serialize.js";
import { sendPasswordResetEmail } from "../lib/mail.js";
import {
  notifyAccountClosed,
  notifyMemberRegistered,
  notifyMemberVerified,
  notifyProfileChanged,
  safeNotify,
} from "./notifications.service.js";

export type RegisterInput = {
  email: string;
  password: string;
  phone?: string;
  role: "workshop" | "retailer";
  fullName: string;
  businessName: string;
  country?: CountryCode;
  city?: string;
  address?: string;
  licenseNumber?: string;
  taxId?: string;
  idDocumentPath?: string;
  licenseDocumentPath?: string;
};

export async function register(input: RegisterInput) {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, input.email.toLowerCase()))
    .limit(1);
  if (existing.length) throw conflict("Email already registered");

  if (input.phone) {
    const phoneHit = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.phone, input.phone))
      .limit(1);
    if (phoneHit.length) throw conflict("Phone already registered");
  }

  const country = input.country ?? "SY";
  if (!isCountryCode(country)) throw badRequest("Invalid country");

  const passwordHash = await hashPassword(input.password);
  const [created] = await db
    .insert(users)
    .values({
      email: input.email.toLowerCase(),
      phone: input.phone ?? null,
      passwordHash,
      role: input.role,
      fullName: input.fullName,
      businessName: input.businessName,
      country,
      city: input.city ?? null,
      address: input.address ?? null,
      licenseNumber: input.licenseNumber ?? null,
      taxId: input.taxId ?? null,
      idDocumentPath: input.idDocumentPath ?? null,
      licenseDocumentPath: input.licenseDocumentPath ?? null,
      verificationStatus: "pending",
    })
    .returning();

  const token = signToken({
    sub: created.id,
    role: created.role as UserRole,
    email: created.email,
    sv: created.sessionVersion,
  });

  await safeNotify(notifyMemberRegistered(created));

  return { user: publicUser(created), token };
}

const RESET_TTL_MS = 30 * 60 * 1000;

function hashResetToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/** Always completes without saying whether the email is on the book. */
export async function requestPasswordReset(email: string) {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);
  if (!user || !user.isActive || !user.passwordHash) return;

  const now = new Date();
  await db
    .update(passwordResets)
    .set({ usedAt: now })
    .where(and(eq(passwordResets.userId, user.id), isNull(passwordResets.usedAt)));

  const token = randomBytes(32).toString("hex");
  await db.insert(passwordResets).values({
    userId: user.id,
    tokenHash: hashResetToken(token),
    expiresAt: new Date(now.getTime() + RESET_TTL_MS),
  });

  try {
    await sendPasswordResetEmail(user.email, token);
  } catch (err) {
    console.error("password reset email failed", err);
  }
}

export async function resetPassword(token: string, password: string) {
  const [row] = await db
    .select()
    .from(passwordResets)
    .where(eq(passwordResets.tokenHash, hashResetToken(token.trim())))
    .limit(1);
  if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) {
    throw badRequest("This reset code is invalid or has expired.");
  }

  const [user] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
  if (!user || !user.isActive) {
    throw badRequest("This reset code is invalid or has expired.");
  }

  const now = new Date();
  await db
    .update(users)
    .set({
      passwordHash: await hashPassword(password),
      sessionVersion: sql`${users.sessionVersion} + 1`,
      updatedAt: now,
    })
    .where(eq(users.id, user.id));
  await db.update(passwordResets).set({ usedAt: now }).where(eq(passwordResets.id, row.id));
}

export async function login(email: string, password: string) {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);

  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    throw unauthorized("Invalid email or password");
  }
  if (!user.isActive) throw forbidden("Account is deactivated");

  const token = signToken({
    sub: user.id,
    role: user.role as UserRole,
    email: user.email,
    sv: user.sessionVersion,
  });

  return { user: publicUser(user), token };
}

export async function updateVerificationDocs(
  user: User,
  docs: {
    licenseNumber?: string;
    taxId?: string;
    idDocumentPath?: string;
    licenseDocumentPath?: string;
    country?: CountryCode;
    city?: string;
    address?: string;
    phone?: string;
  },
) {
  if (user.role === "admin") {
    throw badRequest("Admins do not submit verification documents");
  }

  if (docs.country !== undefined && !isCountryCode(docs.country)) {
    throw badRequest("Invalid country");
  }

  const nextPhone =
    docs.phone !== undefined ? docs.phone.trim() || null : user.phone;
  if (nextPhone && nextPhone !== user.phone) {
    const phoneHit = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.phone, nextPhone))
      .limit(1);
    if (phoneHit.length && phoneHit[0].id !== user.id) {
      throw conflict("Phone already registered");
    }
  }

  const nextCity = docs.city !== undefined ? docs.city.trim() || null : user.city;
  const nextAddress =
    docs.address !== undefined ? docs.address.trim() || null : user.address;
  const nextCountry = docs.country ?? user.country;
  const changed: string[] = [];
  if (nextPhone !== (user.phone ?? null)) changed.push("phone");
  if ((nextCity ?? null) !== (user.city ?? null)) changed.push("city");
  if ((nextAddress ?? null) !== (user.address ?? null)) changed.push("address");
  if (nextCountry !== user.country) changed.push("country");

  const [updated] = await db
    .update(users)
    .set({
      licenseNumber: docs.licenseNumber ?? user.licenseNumber,
      taxId: docs.taxId ?? user.taxId,
      idDocumentPath: docs.idDocumentPath ?? user.idDocumentPath,
      licenseDocumentPath: docs.licenseDocumentPath ?? user.licenseDocumentPath,
      country: nextCountry,
      city: nextCity,
      address: nextAddress,
      phone: nextPhone,
      verificationStatus:
        user.verificationStatus === "rejected" ? "pending" : user.verificationStatus,
      rejectionReason:
        user.verificationStatus === "rejected" ? null : user.rejectionReason,
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id))
    .returning();

  if (changed.length) await safeNotify(notifyProfileChanged(updated, changed));

  return publicUser(updated);
}

export async function listPendingVerifications() {
  const rows = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.verificationStatus, "pending"),
        ne(users.role, "admin"),
      ),
    )
    .orderBy(desc(users.createdAt));

  return rows.map(publicUser);
}

export async function verifyUser(
  admin: User,
  targetId: string,
  notes?: string,
) {
  const [target] = await db
    .select()
    .from(users)
    .where(eq(users.id, targetId))
    .limit(1);
  if (!target) throw notFound("User not found");
  if (target.role === "admin") throw badRequest("Cannot verify an admin");

  const [updated] = await db
    .update(users)
    .set({
      verificationStatus: "verified",
      verifiedAt: new Date(),
      verifiedBy: admin.id,
      verificationNotes: notes ?? null,
      rejectionReason: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, targetId))
    .returning();

  if (updated) await safeNotify(notifyMemberVerified(updated));

  return publicUser(updated);
}

export async function rejectUser(
  admin: User,
  targetId: string,
  reason: string,
) {
  const [target] = await db
    .select()
    .from(users)
    .where(eq(users.id, targetId))
    .limit(1);
  if (!target) throw notFound("User not found");
  if (target.role === "admin") throw badRequest("Cannot reject an admin");

  const [updated] = await db
    .update(users)
    .set({
      verificationStatus: "rejected",
      rejectionReason: reason,
      verifiedAt: null,
      verifiedBy: admin.id,
      updatedAt: new Date(),
    })
    .where(eq(users.id, targetId))
    .returning();

  return publicUser(updated);
}

/**
 * Closes the signed-in house. Credentials and contact files are removed,
 * every session is revoked, and the row stays so orders and the ledger
 * can still be reconstructed.
 */
export async function deleteOwnAccount(user: User, password: string) {
  if (user.role === "admin") {
    throw forbidden("An administrator account is closed by another administrator.");
  }
  const [row] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
  if (!row || !row.isActive) throw unauthorized("Invalid session");
  if (!(await verifyPassword(password, row.passwordHash))) {
    throw badRequest("Password does not match this house.");
  }

  const houseName = row.businessName || row.fullName;
  await db
    .update(users)
    .set({
      email: `closed.${row.id}@accounts.invalid`,
      phone: null,
      passwordHash: null,
      authUserId: null,
      fullName: "Closed house",
      businessName: null,
      city: null,
      address: null,
      licenseNumber: null,
      taxId: null,
      idDocumentPath: null,
      licenseDocumentPath: null,
      avatarPath: null,
      verificationNotes: null,
      rejectionReason: null,
      isActive: false,
      sessionVersion: sql`${users.sessionVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, row.id));

  await safeNotify(notifyAccountClosed(row, houseName));
}

/** Invalidates every Bearer token and cookie session for this user. */
export async function revokeSessions(userId: string) {
  await db
    .update(users)
    .set({
      sessionVersion: sql`${users.sessionVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
}

export async function suspendUser(admin: User, targetId: string, reason?: string) {
  const [target] = await db
    .select()
    .from(users)
    .where(eq(users.id, targetId))
    .limit(1);
  if (!target) throw notFound("User not found");

  const [updated] = await db
    .update(users)
    .set({
      verificationStatus: "suspended",
      verificationNotes: reason ?? target.verificationNotes,
      verifiedBy: admin.id,
      isActive: false,
      sessionVersion: sql`${users.sessionVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, targetId))
    .returning();

  return publicUser(updated);
}

export async function getMemberCard(viewer: User, targetId: string) {
  const target = await getUserById(targetId);
  const self = viewer.id === target.id;
  const admin = viewer.role === "admin";
  let counterparty = false;
  if (!self && !admin) {
    const [trade] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(
        or(
          and(eq(orders.retailerId, viewer.id), eq(orders.workshopId, target.id)),
          and(eq(orders.retailerId, target.id), eq(orders.workshopId, viewer.id)),
        ),
      )
      .limit(1);
    const [credit] = await db
      .select({ id: creditAccounts.id })
      .from(creditAccounts)
      .where(
        or(
          and(
            eq(creditAccounts.retailerId, viewer.id),
            eq(creditAccounts.workshopId, target.id),
          ),
          and(
            eq(creditAccounts.retailerId, target.id),
            eq(creditAccounts.workshopId, viewer.id),
          ),
        ),
      )
      .limit(1);
    counterparty = Boolean(trade || credit);
  }
  const revealContact = self || admin || counterparty;
  return {
    id: target.id,
    role: target.role,
    fullName: target.fullName,
    businessName: target.businessName,
    country: target.country,
    city: target.city,
    address: revealContact ? target.address : null,
    phone: revealContact ? target.phone : null,
    verificationStatus: target.verificationStatus,
  };
}

export async function getUserById(id: string) {
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!user) throw notFound("User not found");
  return publicUser(user);
}

export async function updateAvatar(user: User, avatarPath: string) {
  const [updated] = await db
    .update(users)
    .set({ avatarPath, updatedAt: new Date() })
    .where(eq(users.id, user.id))
    .returning();

  return publicUser(updated);
}
