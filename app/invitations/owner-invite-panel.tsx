"use client";

import { useMutation, useQuery } from "convex/react";
import { FormEvent, useMemo, useState } from "react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

const inviteRoles = ["builder", "reviewer", "contributor", "observer"] as const;
type InviteRole = (typeof inviteRoles)[number];

function createInviteToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function correlationId() {
  return `invite-ui-${crypto.randomUUID()}`;
}

/** Owner-only issuing controls. Raw invite tokens only exist in component memory. */
export function OwnerInvitePanel({ missionId }: Readonly<{ missionId: Id<"missions"> }>) {
  const context = useQuery(api.invites.inviteManagerContext, { missionId });
  const createInvite = useMutation(api.invites.createInvite);
  const revokeInvite = useMutation(api.invites.revokeInvite);
  const activeInvites = useQuery(
    api.invites.listActiveInvites,
    context?.role === "owner" && context.canIssue ? { missionId } : "skip",
  );
  const [role, setRole] = useState<InviteRole>("contributor");
  const [roomIds, setRoomIds] = useState<Id<"rooms">[]>([]);
  const [expiry, setExpiry] = useState<"day" | "week">("week");
  const [maxUses, setMaxUses] = useState(1);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [revokingInviteIds, setRevokingInviteIds] = useState<ReadonlySet<Id<"invites">>>(() => new Set());

  const hasRooms = useMemo(() => (context?.rooms.length ?? 0) > 0, [context?.rooms.length]);

  if (context === undefined) {
    return <section aria-live="polite">Loading invitation controls…</section>;
  }

  if (!context.canIssue) {
    return <section aria-label="Invitation permissions">Only the Mission owner can create invitations.</section>;
  }

  function toggleRoom(roomId: Id<"rooms">) {
    setRoomIds((current) => (current.includes(roomId) ? current.filter((id) => id !== roomId) : [...current, roomId]));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hasRooms || roomIds.length === 0) {
      setFeedback("Choose at least one active room for this invitation.");
      return;
    }
    setFeedback(null);
    setInviteUrl(null);
    setIsSubmitting(true);
    const token = createInviteToken();
    try {
      await createInvite({
        missionId,
        role,
        roomIds,
        expiresAt: Date.now() + (expiry === "day" ? 24 : 7) * 60 * 60 * 1000,
        maxUses,
        inviteToken: token,
        idempotencyKey: crypto.randomUUID(),
        correlationId: correlationId(),
      });
      setInviteUrl(`${window.location.origin}/invite/${token}`);
      setFeedback("Invitation created. Copy the link now; it is not stored in the Mission World.");
    } catch {
      setFeedback("The invitation could not be created. Check your access and try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function revoke(inviteId: Id<"invites">) {
    if (revokingInviteIds.has(inviteId)) return;
    setFeedback(null);
    setRevokingInviteIds((current) => new Set(current).add(inviteId));
    try {
      await revokeInvite({
        inviteId,
        idempotencyKey: crypto.randomUUID(),
        correlationId: correlationId(),
      });
      setFeedback("Invitation revoked.");
    } catch {
      setFeedback("The invitation could not be revoked. Check your access and try again.");
    } finally {
      setRevokingInviteIds((current) => {
        const next = new Set(current);
        next.delete(inviteId);
        return next;
      });
    }
  }

  return (
    <section aria-labelledby="invite-panel-title">
      <h2 id="invite-panel-title">Invite collaborators</h2>
      <p>Invitees can only receive a scoped working role, never owner or steward access.</p>
      <form onSubmit={handleSubmit}>
        <label>
          Role
          <select disabled={isSubmitting} onChange={(event) => setRole(event.target.value as InviteRole)} value={role}>
            {inviteRoles.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <fieldset disabled={isSubmitting || !hasRooms}>
          <legend>Rooms they can enter</legend>
          {context.rooms.map((room) => (
            <label key={room._id}>
              <input checked={roomIds.includes(room._id)} onChange={() => toggleRoom(room._id)} type="checkbox" />
              {room.title} ({room.kind})
            </label>
          ))}
        </fieldset>
        <label>
          Expires
          <select disabled={isSubmitting} onChange={(event) => setExpiry(event.target.value as "day" | "week")} value={expiry}>
            <option value="day">In 24 hours</option>
            <option value="week">In 7 days</option>
          </select>
        </label>
        <label>
          Maximum uses
          <input disabled={isSubmitting} max={100} min={1} onChange={(event) => setMaxUses(Number(event.target.value))} type="number" value={maxUses} />
        </label>
        <button disabled={isSubmitting || !hasRooms} type="submit">{isSubmitting ? "Creating…" : "Create invitation"}</button>
      </form>
      {feedback === null ? null : <p aria-live="polite">{feedback}</p>}
      {inviteUrl === null ? null : (
        <div>
          <label>
            Invitation link
            <input aria-label="Invitation link" readOnly value={inviteUrl} />
          </label>
          <button onClick={() => void navigator.clipboard.writeText(inviteUrl)} type="button">Copy link</button>
        </div>
      )}
      <section aria-labelledby="active-invitations-title">
        <h3 id="active-invitations-title">Active invitations</h3>
        {activeInvites === undefined ? <p aria-live="polite">Loading active invitations…</p> : activeInvites.length === 0 ? <p>No active invitations.</p> : (
          <ul aria-label="Active invitations">
            {activeInvites.map((invite) => (
              <li aria-label={`Active ${invite.role} invitation for ${invite.rooms.map((room) => room.title).join(", ")}`} key={invite._id}>
                <p><strong>{invite.role}</strong> · {invite.uses} of {invite.maxUses} uses</p>
                <p>Rooms: {invite.rooms.map((room) => room.title).join(", ")}</p>
                <p><time dateTime={new Date(invite.expiresAt).toISOString()}>Expires {new Date(invite.expiresAt).toLocaleString()}</time></p>
                <button disabled={revokingInviteIds.has(invite._id)} onClick={() => void revoke(invite._id)} type="button">
                  {revokingInviteIds.has(invite._id) ? "Revoking…" : "Revoke invitation"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
