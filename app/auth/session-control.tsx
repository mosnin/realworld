"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useState } from "react";

export function SessionControl() {
  const { signOut } = useAuthActions();
  const [isSigningOut, setIsSigningOut] = useState(false);

  return (
    <button
      className="session-control"
      disabled={isSigningOut}
      onClick={async () => {
        setIsSigningOut(true);
        try {
          await signOut();
        } finally {
          setIsSigningOut(false);
        }
      }}
      type="button"
    >
      {isSigningOut ? "Leaving…" : "Sign out"}
    </button>
  );
}
