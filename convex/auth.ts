import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";

/**
 * Private-alpha authentication only. The currently supported Convex Auth
 * package does not provide a Passkey/WebAuthn provider, so this deliberately
 * uses a bounded email/password flow until the final passkey provider is
 * selected and qualified.
 */
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Password],
  session: {
    inactiveDurationMs: 7 * 24 * 60 * 60 * 1000,
    totalDurationMs: 30 * 24 * 60 * 60 * 1000,
  },
});
