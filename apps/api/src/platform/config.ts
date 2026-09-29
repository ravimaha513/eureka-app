import { z } from "zod";

const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().url(),
    SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
    AUTH_MODE: z.enum(["google", "dev"]).default("google"),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_HOSTED_DOMAIN: z.string().optional(),
    PUBLIC_BASE_URL: z.string().url().default("http://localhost:5173"),
    SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(60),
    SESSION_ABSOLUTE_HOURS: z.coerce.number().int().positive().default(12),
  })
  .superRefine((c, ctx) => {
    // Design A6.1: the development identity provider can never run in production.
    if (c.NODE_ENV === "production" && c.AUTH_MODE === "dev") {
      ctx.addIssue({ code: "custom", message: "AUTH_MODE=dev is not allowed in production" });
    }
    if (c.AUTH_MODE === "google" && (!c.GOOGLE_CLIENT_ID || !c.GOOGLE_CLIENT_SECRET || !c.GOOGLE_HOSTED_DOMAIN)) {
      ctx.addIssue({ code: "custom", message: "Google OIDC settings are required when AUTH_MODE=google" });
    }
  });

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  return parsed.data;
}

export const CONFIG = Symbol("CONFIG");
