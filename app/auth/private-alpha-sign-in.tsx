"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { FormEvent, useState } from "react";

export function PrivateAlphaSignIn() {
  const { signIn } = useAuthActions();
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      await signIn("password", { email, password, flow: mode });
    } catch {
      setError("We could not complete that request. Check the details and try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main id="main-content" tabIndex={-1}>
      <section aria-labelledby="sign-in-title" className="foundation">
        <p className="wordmark" aria-label="Realworld">
          Realworld
        </p>
        <p>Private alpha</p>
        <h1 id="sign-in-title">Enter the Mission World.</h1>
        <p>
          Sign in to work in private Missions. Passkeys are the intended production method; this
          temporary private-alpha flow uses email and password while that provider is qualified.
        </p>
        <form onSubmit={handleSubmit}>
          <label>
            Email
            <input
              autoComplete="email"
              disabled={isSubmitting}
              onChange={(event) => setEmail(event.target.value)}
              required
              type="email"
              value={email}
            />
          </label>
          <label>
            Password
            <input
              autoComplete={mode === "signUp" ? "new-password" : "current-password"}
              disabled={isSubmitting}
              minLength={8}
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </label>
          {error === null ? null : <p role="alert">{error}</p>}
          <button disabled={isSubmitting} type="submit">
            {isSubmitting ? "Connecting…" : mode === "signIn" ? "Sign in" : "Create private-alpha account"}
          </button>
        </form>
        <button
          onClick={() => {
            setError(null);
            setMode((current) => (current === "signIn" ? "signUp" : "signIn"));
          }}
          type="button"
        >
          {mode === "signIn" ? "Need an invitation? Create an account" : "Already have an account? Sign in"}
        </button>
      </section>
    </main>
  );
}
