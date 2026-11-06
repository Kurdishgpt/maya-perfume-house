import { createHash, timingSafeEqual } from "node:crypto";

export function isAdminRecoveryKeyConfigured(configured) {
  return typeof configured === "string" && Buffer.byteLength(configured, "utf8") >= 32;
}

export function verifyAdminRecoveryKey(received, configured) {
  if (!isAdminRecoveryKeyConfigured(configured)) return false;
  const receivedDigest = createHash("sha256").update(received).digest();
  const expectedDigest = createHash("sha256").update(configured).digest();
  return timingSafeEqual(receivedDigest, expectedDigest);
}
