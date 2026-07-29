"use client";

import { FormEvent, useState } from "react";
import { useMutation, useQuery } from "convex/react";

import { api } from "@/convex/_generated/api";

function callsignErrorMessage(cause: unknown) {
  const message = cause instanceof Error ? cause.message : "";
  if (message.includes("2 to 40 visible")) return "Use a callsign with 2 to 40 visible characters.";
  if (message.includes("24 hours")) return "You can change your callsign once every 24 hours.";
  if (message.includes("reserved")) return "That callsign is reserved. Choose another one.";
  if (message.includes("email")) return "Use a callsign, not an email address.";
  if (message.includes("unsupported") || message.includes("unattached")) return "That callsign contains characters we cannot use.";
  return "Your callsign could not be saved. Please try again.";
}

function CallsignForm({
  initialValue = "",
  onComplete,
  title,
  description,
}: Readonly<{
  initialValue?: string;
  onComplete?: () => void;
  title: string;
  description: string;
}>) {
  const setMine = useMutation(api.profiles.setMine);
  const [displayName, setDisplayName] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setError(null);
    setSaving(true);
    try {
      await setMine({ displayName, idempotencyKey: crypto.randomUUID() });
      onComplete?.();
    } catch (cause) {
      setError(callsignErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="callsign-form" onSubmit={(event) => void submit(event)}>
      <p className="eyebrow">Your identity</p>
      {title === "" ? null : <h1 id="callsign-title">{title}</h1>}
      <p>{description}</p>
      <label htmlFor="callsign-input">Callsign</label>
      <input
        autoComplete="nickname"
        aria-describedby="callsign-hint"
        id="callsign-input"
        maxLength={80}
        minLength={2}
        onChange={(event) => setDisplayName(event.target.value)}
        required
        value={displayName}
      />
      <p className="callsign-form__hint" id="callsign-hint">2–40 visible characters. This is separate from your sign-in identity.</p>
      {error === null ? null : <p role="alert">{error}</p>}
      <button className="create-button" disabled={saving} type="submit">
        {saving ? "Saving callsign…" : "Save callsign"}
      </button>
    </form>
  );
}

/** Blocks product entry until the signed-in person explicitly chooses a callsign. */
export function CallsignSetupGate({
  children,
  purpose = "Before you can create or join a Mission, choose the callsign collaborators will see.",
}: Readonly<{ children?: React.ReactNode; purpose?: string }>) {
  const profile = useQuery(api.profiles.getMine, {});
  if (profile === undefined) {
    return <main id="main-content" tabIndex={-1}><section className="foundation" aria-live="polite">Loading your profile…</section></main>;
  }
  if (profile === null) {
    return <main id="main-content" tabIndex={-1}><section aria-labelledby="callsign-title" className="foundation"><CallsignForm description={purpose} title="Choose your callsign" /></section></main>;
  }
  return <>{children ?? null}</>;
}

/** Non-modal profile editing inside the established personal-preferences surface. */
export function CallsignSettings() {
  const profile = useQuery(api.profiles.getMine, {});
  if (profile === undefined || profile === null) return null;
  return (
    <section aria-labelledby="callsign-settings-title" className="callsign-settings">
      <h3 id="callsign-settings-title">Callsign</h3>
      <CallsignForm
        description="This is the name collaborators will recognize. You can change it once every 24 hours."
        initialValue={profile.displayName}
        title=""
      />
    </section>
  );
}
