"use client";

import { Authenticated, AuthLoading, Unauthenticated } from "convex/react";
import type { ReactNode } from "react";

import { hasConvexAuthConfiguration } from "./convex-client-provider";
import { PrivateAlphaSignIn } from "./private-alpha-sign-in";

function AuthNotConfigured() {
  return (
    <main id="main-content" tabIndex={-1}>
      <section aria-labelledby="auth-configuration-title" className="foundation">
        <p className="wordmark">Realworld</p>
        <h1 id="auth-configuration-title">The Mission World is preparing its secure entry.</h1>
        <p>
          Authentication is not configured for this environment yet. Set the public Convex deployment
          URL and complete the Convex Auth environment setup before inviting collaborators.
        </p>
      </section>
    </main>
  );
}

export function MissionAccessGate({ children }: Readonly<{ children: ReactNode }>) {
  if (!hasConvexAuthConfiguration()) {
    return <AuthNotConfigured />;
  }

  return (
    <>
      <AuthLoading>
        <main id="main-content" tabIndex={-1}>
          <section aria-live="polite" className="foundation">
            Restoring your Mission World session…
          </section>
        </main>
      </AuthLoading>
      <Unauthenticated>
        <PrivateAlphaSignIn />
      </Unauthenticated>
      <Authenticated>{children}</Authenticated>
    </>
  );
}
