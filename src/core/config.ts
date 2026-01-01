import dotenv from "dotenv";

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: optionalNumber("PORT", 3000),
  logLevel: process.env.LOG_LEVEL || "info",
  databaseUrl: requireEnv("DATABASE_URL"),
  toastSandboxBaseUrl: process.env.TOAST_SANDBOX_BASE_URL || "https://api-sandbox.toasttab.com",
  toastProdBaseUrl: process.env.TOAST_PROD_BASE_URL || "https://api.toasttab.com",
  toastMock: process.env.TOAST_MOCK === "true",
  toastTimeoutMs: optionalNumber("TOAST_TIMEOUT_MS", 10000),
  cloverClientId: process.env.CLOVER_CLIENT_ID || "",
  cloverClientSecret: process.env.CLOVER_CLIENT_SECRET || "",
  cloverRedirectUri: process.env.CLOVER_REDIRECT_URI || "",
  cloverEnvironment: process.env.CLOVER_ENVIRONMENT || "sandbox",
  cloverSandboxBaseUrl: process.env.CLOVER_SANDBOX_BASE_URL || "https://sandbox.dev.clover.com",
  cloverProdBaseUrl: process.env.CLOVER_PROD_BASE_URL || "https://api.clover.com",
  cloverMock: process.env.CLOVER_MOCK === "true",
  cloverTimeoutMs: optionalNumber("CLOVER_TIMEOUT_MS", 10000),
  vapiApiKey: process.env.VAPI_API_KEY || "",
  vapiAssistantId: process.env.VAPI_ASSISTANT_ID || "",
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || "",
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || "",
  twilioFromNumber: process.env.TWILIO_FROM_NUMBER || "",
};
