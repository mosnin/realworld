import { v } from "convex/values";

import { internalMutation, query } from "./_generated/server";
import { requireAuthenticatedTokenIdentifier } from "./lib/auth";

export const displayNameCooldownMs = 24 * 60 * 60 * 1000;
const profileReceiptMs = 30 * 24 * 60 * 60 * 1000;
const forbiddenInvisibleCharacters = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
// This is intentionally narrower than "all Unicode names": it admits ASCII
// callsigns, their decomposed diacritics, and common emoji sequences. That
// prevents Greek/Cyrillic and less obvious Latin confusables from impersonating
// system labels without depending on an unvetted UTS-39 implementation.
const allowedCallsignRepertoire = /^[A-Za-z0-9\p{M}\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\s.'_-]+$/u;
const emojiCharacter = /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}]/u;
const asciiLetterOrDigit = /[A-Za-z0-9]/u;
const reservedLabels = new Set([
  "realworld",
  "system",
  "assistant",
  "support",
  "moderator",
  "admin",
  "administrator",
  "service",
]);
type DisplayNameCapabilities = {
  Segmenter?: typeof Intl.Segmenter | null;
};

const profileView = v.object({
  displayName: v.string(),
  displayNameUpdatedAt: v.number(),
});

/** Exported for deterministic local validation tests; it is not a Convex function. */
export function normalizeDisplayName(value: string, capabilities?: DisplayNameCapabilities) {
  const normalized = value.normalize("NFKC");
  if (forbiddenInvisibleCharacters.test(normalized)) {
    throw new Error("Display name contains unsupported invisible characters");
  }

  const displayName = normalized.trim().replace(/\s+/gu, " ");
  if (displayName.includes("@")) {
    throw new Error("Display name cannot contain an email address");
  }
  const decomposedDisplayName = displayName.normalize("NFKD");
  if (!allowedCallsignRepertoire.test(decomposedDisplayName)) {
    throw new Error("Display name contains unsupported characters");
  }
  let hasAsciiBaseForMark = false;
  for (const character of decomposedDisplayName) {
    if (/^[A-Za-z]$/u.test(character)) {
      hasAsciiBaseForMark = true;
      continue;
    }
    if (/^\p{M}$/u.test(character)) {
      if (!hasAsciiBaseForMark) {
        throw new Error("Display name contains unattached combining marks");
      }
      continue;
    }
    hasAsciiBaseForMark = false;
  }
  // Keeping emoji-only callsigns separate from text callsigns prevents an emoji
  // glyph that resembles a letter (for example, enclosed A) from bypassing the
  // reserved-name skeleton while preserving expressive non-ZWJ emoji/flag callsigns.
  if (emojiCharacter.test(displayName) && asciiLetterOrDigit.test(decomposedDisplayName)) {
    throw new Error("Display name cannot mix emoji and text characters");
  }

  const Segmenter = capabilities !== undefined && "Segmenter" in capabilities
    ? capabilities.Segmenter
    : Intl.Segmenter;
  if (typeof Segmenter !== "function") {
    throw new Error("Unicode grapheme segmentation is unavailable");
  }
  const segmenter = new Segmenter(undefined, { granularity: "grapheme" });

  const visibleGraphemes = [...segmenter.segment(displayName)]
    .filter(({ segment }) => !/^\s+$/u.test(segment)).length;
  if (visibleGraphemes < 2 || visibleGraphemes > 40) {
    throw new Error("Display name must contain 2 to 40 visible characters");
  }

  const compactLabel = displayName
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^A-Za-z0-9]/gu, "")
    .toLowerCase();
  if (reservedLabels.has(compactLabel) || compactLabel.startsWith("agent") || compactLabel.endsWith("agent")) {
    throw new Error("Display name is reserved");
  }

  return displayName;
}

function validateIdempotencyKey(value: string) {
  if (value.trim().length === 0 || value.length > 200) {
    throw new Error("Invalid idempotency key");
  }
  return value;
}

async function findPrincipalByTokenIdentifier(
  ctx: Parameters<typeof requireAuthenticatedTokenIdentifier>[0],
  tokenIdentifier: string,
) {
  return await ctx.db
    .query("principals")
    .withIndex("by_token_identifier", (index) => index.eq("tokenIdentifier", tokenIdentifier))
    .unique();
}

/** Returns only the signed-in human's callsign projection, never identity metadata. */
export const getMine = query({
  args: {},
  returns: v.union(v.null(), profileView),
  handler: async (ctx) => {
    const tokenIdentifier = await requireAuthenticatedTokenIdentifier(ctx);
    const principal = await findPrincipalByTokenIdentifier(ctx, tokenIdentifier);
    if (principal === null) return null;
    if (principal.type !== "human" || principal.state !== "active") throw new Error("Unauthorized");
    if (principal.displayName === undefined || principal.displayNameUpdatedAt === undefined) return null;
    return {
      displayName: principal.displayName,
      displayNameUpdatedAt: principal.displayNameUpdatedAt,
    };
  },
});

/**
 * Sets the active authenticated human's own callsign. It deliberately accepts
 * neither a principal id nor any Mission, role, email, or token argument.
 */
export const setMine = internalMutation({
  args: { displayName: v.string(), idempotencyKey: v.string() },
  returns: v.object({ displayName: v.string() }),
  handler: async (ctx, args) => {
    const tokenIdentifier = await requireAuthenticatedTokenIdentifier(ctx);
    const principal = await findPrincipalByTokenIdentifier(ctx, tokenIdentifier);
    if (principal !== null && (principal.type !== "human" || principal.state !== "active")) {
      throw new Error("Unauthorized");
    }

    const displayName = normalizeDisplayName(args.displayName);
    const idempotencyKey = validateIdempotencyKey(args.idempotencyKey);
    const commandFingerprint = JSON.stringify({ command: "setMine", displayName });
    const now = Date.now();

    if (principal === null) {
      const principalId = await ctx.db.insert("principals", {
        type: "human",
        state: "active",
        tokenIdentifier,
        displayName,
        displayNameUpdatedAt: now,
        createdAt: now,
        updatedAt: now,
        schemaVersion: 1,
      });
      await ctx.db.insert("profileReceipts", {
        principalId,
        idempotencyKey,
        commandFingerprint,
        resultDisplayName: displayName,
        createdAt: now,
        expiresAt: now + profileReceiptMs,
        schemaVersion: 1,
      });
      return { displayName };
    }

    const prior = await ctx.db
      .query("profileReceipts")
      .withIndex("by_principal_and_idempotency_key", (index) =>
        index.eq("principalId", principal._id).eq("idempotencyKey", idempotencyKey),
      )
      .unique();
    if (prior !== null) {
      if (prior.commandFingerprint !== commandFingerprint) {
        throw new Error("Idempotency key reuse with a different callsign");
      }
      return { displayName: prior.resultDisplayName };
    }

    const isChange = principal.displayName !== displayName;
    if (isChange && principal.displayNameUpdatedAt !== undefined && now - principal.displayNameUpdatedAt < displayNameCooldownMs) {
      throw new Error("Display name can only change once every 24 hours");
    }

    if (isChange || principal.displayNameUpdatedAt === undefined) {
      await ctx.db.patch(principal._id, {
        displayName,
        displayNameUpdatedAt: now,
        updatedAt: now,
      });
    }
    await ctx.db.insert("profileReceipts", {
      principalId: principal._id,
      idempotencyKey,
      commandFingerprint,
      resultDisplayName: displayName,
      createdAt: now,
      expiresAt: now + profileReceiptMs,
      schemaVersion: 1,
    });
    return { displayName };
  },
});
