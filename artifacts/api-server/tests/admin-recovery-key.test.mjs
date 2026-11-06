import assert from "node:assert/strict";
import test from "node:test";
import { isAdminRecoveryKeyConfigured, verifyAdminRecoveryKey } from "../src/lib/adminRecoveryKey.mjs";

test("recovery requires a server key of at least 32 bytes", () => {
  assert.equal(isAdminRecoveryKeyConfigured(undefined), false);
  assert.equal(isAdminRecoveryKeyConfigured("short-key"), false);
  assert.equal(isAdminRecoveryKeyConfigured("x".repeat(32)), true);
});

test("recovery key comparison accepts only an exact match", () => {
  const configured = "test-recovery-key-".repeat(3);
  assert.equal(verifyAdminRecoveryKey(configured, configured), true);
  assert.equal(verifyAdminRecoveryKey(`${configured}x`, configured), false);
  assert.equal(verifyAdminRecoveryKey(configured, undefined), false);
});
