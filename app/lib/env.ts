import { z } from "zod";

const publicEnvironmentSchema = z.enum(["development", "test", "preview", "production"]);

export type PublicAppEnvironment = z.infer<typeof publicEnvironmentSchema>;

/**
 * Validates only safe, non-secret configuration needed by the application shell.
 * Feature-specific server credentials are validated at their trusted integration
 * boundary so an unused provider cannot prevent the shell from starting.
 */
export function getPublicAppEnvironment(): PublicAppEnvironment {
  return publicEnvironmentSchema.catch("development").parse(process.env.NEXT_PUBLIC_APP_ENV);
}
