import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getAdminSessionRevision } from "../lib/adminPassword";

const passcodeCookieName = "maya_admin_unlock";
const passcodeCookieMaxAge = 30 * 60;

function signPasscodeUnlock(expiresAt: number, revision: number, secret: string): string {
  return createHmac("sha256", secret).update(`${expiresAt}.${revision}`).digest("base64url");
}

function readCookie(req: Request): string | undefined {
  return req.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${passcodeCookieName}=`))
    ?.slice(passcodeCookieName.length + 1);
}

export async function isAdminPasscodeUnlocked(req: Request): Promise<boolean> {
  const secret = process.env.SESSION_SECRET;
  const token = readCookie(req);
  if (!secret || !token) return false;

  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [expiresText, revisionText, signature] = parts;
  const expiresAt = Number(expiresText);
  const revision = Number(revisionText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()
    || !Number.isSafeInteger(revision) || revision < 0) return false;
  if (!/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;

  const expected = Buffer.from(signPasscodeUnlock(expiresAt, revision, secret), "base64url");
  const received = Buffer.from(signature, "base64url");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return false;
  return revision === await getAdminSessionRevision();
}

export function setAdminPasscodeCookie(res: Response, revision = 0): boolean {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return false;

  const expiresAt = Date.now() + passcodeCookieMaxAge * 1000;
  const signature = signPasscodeUnlock(expiresAt, revision, secret);
  const cookieParts = [
    `${passcodeCookieName}=${expiresAt}.${revision}.${signature}`,
    "Path=/api",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${passcodeCookieMaxAge}`,
  ];
  if (process.env.NODE_ENV === "production") cookieParts.push("Secure");
  res.setHeader("Set-Cookie", cookieParts.join("; "));
  return true;
}

export function clearAdminPasscodeCookie(res: Response): void {
  const cookieParts = [
    `${passcodeCookieName}=`,
    "Path=/api",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ];
  if (process.env.NODE_ENV === "production") cookieParts.push("Secure");
  res.setHeader("Set-Cookie", cookieParts.join("; "));
}

export function verifyAdminPasscode(received: string): boolean {
  const adminPasscode = process.env.ADMIN_PANEL_PASSWORD;
  if (!adminPasscode) return false;
  const receivedDigest = createHash("sha256").update(received).digest();
  const expectedDigest = createHash("sha256").update(adminPasscode).digest();
  return timingSafeEqual(receivedDigest, expectedDigest);
}

export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (await isAdminPasscodeUnlocked(req)) {
      next();
      return;
    }
    res.status(401).json({ error: "Unlock the admin panel before changing the catalog." });
  } catch (error) {
    req.log.error({ err: error }, "Could not verify administrator session");
    res.status(503).json({ error: "Administrator access could not be checked." });
    return;
  }
}
