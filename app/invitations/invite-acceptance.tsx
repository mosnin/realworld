"use client";

import { Authenticated, AuthLoading, Unauthenticated, useMutation } from "convex/react";
import Link from "next/link";
import { useRef, useState } from "react";

import { PrivateAlphaSignIn } from "@/app/auth/private-alpha-sign-in";
import { api } from "@/convex/_generated/api";
import { CallsignSetupGate } from "@/app/profiles/callsign-controls";

export function InviteAcceptance({ token }: Readonly<{ token: string }>) {
  return (
    <>
      <AuthLoading><main id="main-content"><p>Restoring your secure session…</p></main></AuthLoading>
      <Unauthenticated>
        <>
          <p>Sign in or create a private-alpha account, then return to this invitation link.</p>
          <PrivateAlphaSignIn />
        </>
      </Unauthenticated>
      <Authenticated><CallsignSetupGate purpose="Choose your callsign before you accept this Mission invitation."><AcceptInvitation token={token} /></CallsignSetupGate></Authenticated>
    </>
  );
}

function AcceptInvitation({ token }: Readonly<{ token: string }>) {
  const acceptInvite = useMutation(api.invites.acceptInvite);
  const idempotencyKey = useRef<string | null>(null);
  const [state, setState] = useState<"ready" | "joining" | "joined" | "unavailable">("ready");

  async function join() {
    idempotencyKey.current ??= crypto.randomUUID();
    setState("joining");
    try {
      await acceptInvite({ inviteToken: token, idempotencyKey: idempotencyKey.current, correlationId: `invite-accept-${crypto.randomUUID()}` });
      setState("joined");
    } catch {
      setState("unavailable");
    }
  }

  return (
    <main id="main-content" tabIndex={-1}>
      <section aria-labelledby="accept-invite-title" className="foundation">
        <p className="wordmark">Realworld</p>
        <h1 id="accept-invite-title">You have a Mission invitation.</h1>
        {state === "joined" ? <p aria-live="polite">You joined the Mission. <Link href="/">Enter the Mission World</Link>.</p> : null}
        {state === "unavailable" ? <p role="alert">This invitation is unavailable, expired, revoked, or already used.</p> : null}
        {state === "ready" || state === "joining" ? <button disabled={state === "joining"} onClick={() => void join()} type="button">{state === "joining" ? "Joining…" : "Join Mission"}</button> : null}
      </section>
    </main>
  );
}
