import { Router, type IRouter } from "express";
import {
  ChangeAdminPasswordBody,
  ChangeAdminPasswordResponse,
  GetAdminPasscodeStatusResponse,
  RecoverAdminPasscodeBody,
  RecoverAdminPasscodeResponse,
  ResetAdminPasswordFromSessionBody,
  ResetAdminPasswordFromSessionResponse,
  UnlockAdminPasscodeBody,
  UnlockAdminPasscodeResponse,
} from "@workspace/api-zod";
import { changeAdminPassword, resetAdminPassword, verifyAdminPassword } from "../lib/adminPassword";
import {
  clearAdminPasscodeCookie,
  isAdminRecoveryConfigured,
  isAdminPasscodeUnlocked,
  requireAdmin,
  setAdminPasscodeCookie,
  verifyAdminPasscode,
  verifyAdminRecoveryKey,
} from "../middlewares/requireAdmin";

const router: IRouter = Router();
const maxAttempts = 5;
const attemptWindowMs = 15 * 60 * 1000;
const failedAttempts = new Map<string, { count: number; startedAt: number }>();
const failedRecoveryAttempts = new Map<string, { count: number; startedAt: number }>();

router.use("/admin/passcode", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
router.use("/admin/change-password", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

router.get("/admin/passcode", async (req, res): Promise<void> => {
  if (!process.env.SESSION_SECRET) {
    req.log.error("Admin session signing is not configured");
    res.status(503).json({ error: "Admin access is not configured." });
    return;
  }

  try {
    res.json(GetAdminPasscodeStatusResponse.parse({
      unlocked: await isAdminPasscodeUnlocked(req),
    }));
  } catch (error) {
    req.log.error({ err: error }, "Could not read administrator session status");
    res.status(503).json({ error: "Admin access could not be checked." });
  }
});

router.post("/admin/passcode", async (req, res): Promise<void> => {
  const parsed = UnlockAdminPasscodeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter the admin passphrase." });
    return;
  }
  if (!process.env.SESSION_SECRET) {
    req.log.error("Admin session signing is not configured");
    res.status(503).json({ error: "Admin access is not configured." });
    return;
  }

  const clientIp = req.ip || "unknown";
  const now = Date.now();
  const current = failedAttempts.get(clientIp);
  if (current && now - current.startedAt < attemptWindowMs && current.count >= maxAttempts) {
    res.status(429).json({ error: "Too many attempts. Wait 15 minutes and try again." });
    return;
  }
  const attempts =
    current && now - current.startedAt < attemptWindowMs
      ? current
      : { count: 0, startedAt: now };

  let verification: Awaited<ReturnType<typeof verifyAdminPassword>>;
  try {
    verification = await verifyAdminPassword(
      parsed.data.passcode,
      () => verifyAdminPasscode(parsed.data.passcode),
    );
  } catch (error) {
    req.log.error({ err: error }, "Could not verify administrator passcode");
    res.status(503).json({ error: "Admin access could not be checked." });
    return;
  }

  if (!verification.valid) {
    attempts.count += 1;
    failedAttempts.set(clientIp, attempts);
    res.status(403).json({ error: "That passphrase was not accepted." });
    return;
  }

  failedAttempts.delete(clientIp);
  if (!setAdminPasscodeCookie(res, verification.sessionRevision)) {
    res.status(503).json({ error: "Admin access is not configured." });
    return;
  }
  res.json(UnlockAdminPasscodeResponse.parse({ unlocked: true }));
});

router.post("/admin/change-password", requireAdmin, async (req, res): Promise<void> => {
  const parsed = ChangeAdminPasswordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a new password with at least 12 characters." });
    return;
  }
  if (parsed.data.current_passcode === parsed.data.new_passcode) {
    res.status(400).json({ error: "Choose a password different from the current one." });
    return;
  }

  try {
    const revision = await changeAdminPassword(
      parsed.data.current_passcode,
      parsed.data.new_passcode,
      () => verifyAdminPasscode(parsed.data.current_passcode),
    );
    if (revision === null) {
      res.status(403).json({ error: "The current administrator password was not accepted." });
      return;
    }
    if (!setAdminPasscodeCookie(res, revision)) {
      res.status(503).json({ error: "Admin access is not configured." });
      return;
    }
    res.json(ChangeAdminPasswordResponse.parse({ updated: true }));
  } catch (error) {
    req.log.error({ err: error }, "Could not change administrator password");
    res.status(503).json({ error: "Password changes are unavailable until the administrator security migration is applied." });
  }
});

router.post("/admin/change-password/session", requireAdmin, async (req, res): Promise<void> => {
  const parsed = ResetAdminPasswordFromSessionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a new password with at least 12 characters." });
    return;
  }

  try {
    const revision = await resetAdminPassword(parsed.data.new_passcode);
    if (!setAdminPasscodeCookie(res, revision)) {
      res.status(503).json({ error: "Admin access is not configured." });
      return;
    }
    res.json(ResetAdminPasswordFromSessionResponse.parse({ updated: true }));
  } catch (error) {
    req.log.error({ err: error }, "Could not reset administrator password from session");
    res.status(503).json({ error: "Password reset is temporarily unavailable." });
  }
});

router.post("/admin/passcode/recover", async (req, res): Promise<void> => {
  const parsed = RecoverAdminPasscodeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter the recovery key and a new password of at least 12 characters." });
    return;
  }
  const recoveryKeyConfigured = isAdminRecoveryConfigured();
  const sessionSigningConfigured = Boolean(process.env.SESSION_SECRET);
  if (!recoveryKeyConfigured || !sessionSigningConfigured) {
    req.log.warn({
      recovery_key_present: Boolean(process.env.ADMIN_PASSWORD_RECOVERY_KEY),
      recovery_key_length_valid: recoveryKeyConfigured,
      session_signing_configured: sessionSigningConfigured,
    }, "Administrator recovery configuration is incomplete");
    res.status(503).json({ error: "Administrator recovery is not configured." });
    return;
  }

  const clientIp = req.ip || "unknown";
  const now = Date.now();
  const current = failedRecoveryAttempts.get(clientIp);
  if (current && now - current.startedAt < attemptWindowMs && current.count >= maxAttempts) {
    res.status(429).json({ error: "Too many recovery attempts. Wait 15 minutes and try again." });
    return;
  }
  const attempts =
    current && now - current.startedAt < attemptWindowMs
      ? current
      : { count: 0, startedAt: now };

  if (!verifyAdminRecoveryKey(parsed.data.recovery_key)) {
    attempts.count += 1;
    failedRecoveryAttempts.set(clientIp, attempts);
    res.status(403).json({ error: "The recovery key was not accepted." });
    return;
  }

  try {
    const revision = await resetAdminPassword(parsed.data.new_passcode);
    failedRecoveryAttempts.delete(clientIp);
    if (!setAdminPasscodeCookie(res, revision)) {
      res.status(503).json({ error: "Admin access is not configured." });
      return;
    }
    res.json(RecoverAdminPasscodeResponse.parse({ recovered: true }));
  } catch (error) {
    req.log.error({ err: error }, "Could not recover administrator password");
    res.status(503).json({ error: "Password recovery is temporarily unavailable." });
  }
});

router.delete("/admin/passcode", (_req, res): void => {
  clearAdminPasscodeCookie(res);
  res.sendStatus(204);
});

export default router;
