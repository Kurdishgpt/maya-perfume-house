import { getSupabaseAdmin } from "./supabase";

const iterations = 310_000;
const encoder = new TextEncoder();

type AdminPasswordSettings = {
  password_salt: string | null;
  password_hash: string | null;
  hash_iterations: number;
  session_revision: number;
};

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  try {
    const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function derivePasswordHash(password: string, salt: Uint8Array, rounds: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const saltBuffer = new ArrayBuffer(salt.length);
  new Uint8Array(saltBuffer).set(salt);
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBuffer, iterations: rounds, hash: "SHA-256" },
    key,
    256,
  );
  return new Uint8Array(derived);
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export async function getAdminPasswordSettings(): Promise<AdminPasswordSettings | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("admin_auth_settings")
    .select("password_salt,password_hash,hash_iterations,session_revision")
    .eq("id", 1)
    .maybeSingle();

  if (error) {
    if (error.code === "PGRST205" || error.code === "42P01") return null;
    throw error;
  }
  return data as AdminPasswordSettings | null;
}

export async function getAdminSessionRevision(): Promise<number> {
  return (await getAdminPasswordSettings())?.session_revision ?? 0;
}

async function verifyStoredPassword(password: string, settings: AdminPasswordSettings): Promise<boolean> {
  if (!settings.password_hash || !settings.password_salt) return false;
  const expected = fromBase64Url(settings.password_hash);
  const salt = fromBase64Url(settings.password_salt);
  if (!expected || !salt || !Number.isInteger(settings.hash_iterations)
    || settings.hash_iterations < 10_000 || settings.hash_iterations > 1_000_000) return false;
  const received = await derivePasswordHash(password, salt, settings.hash_iterations);
  return constantTimeEqual(received, expected);
}

async function storeAdminPassword(newPassword: string, sessionRevision: number): Promise<number> {
  const nextRevision = sessionRevision + 1;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePasswordHash(newPassword, salt, iterations);
  const { error } = await getSupabaseAdmin()
    .from("admin_auth_settings")
    .upsert({
      id: 1,
      password_salt: toBase64Url(salt),
      password_hash: toBase64Url(hash),
      hash_iterations: iterations,
      session_revision: nextRevision,
      updated_at: new Date().toISOString(),
    }, { onConflict: "id" });

  if (error) throw error;
  return nextRevision;
}

export async function verifyAdminPassword(
  password: string,
  fallbackVerify: () => boolean,
): Promise<{ valid: boolean; sessionRevision: number }> {
  const settings = await getAdminPasswordSettings();
  if (!settings?.password_hash) {
    return { valid: fallbackVerify(), sessionRevision: settings?.session_revision ?? 0 };
  }
  return {
    valid: await verifyStoredPassword(password, settings),
    sessionRevision: settings.session_revision,
  };
}

export async function changeAdminPassword(
  currentPassword: string,
  newPassword: string,
  fallbackVerify: () => boolean,
): Promise<number | null> {
  const settings = await getAdminPasswordSettings();
  const currentIsValid = settings?.password_hash
    ? await verifyStoredPassword(currentPassword, settings)
    : fallbackVerify();
  if (!currentIsValid) return null;

  return storeAdminPassword(newPassword, settings?.session_revision ?? 0);
}

export async function resetAdminPassword(newPassword: string): Promise<number> {
  const settings = await getAdminPasswordSettings();
  return storeAdminPassword(newPassword, settings?.session_revision ?? 0);
}
