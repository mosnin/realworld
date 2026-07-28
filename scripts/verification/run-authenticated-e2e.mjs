import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";

const siteUrl = "http://127.0.0.1:3100";

function setConvexEnvironmentVariable(name, value) {
  const result = spawnSync(
    "pnpm",
    ["exec", "convex", "env", "set", "--", name, value],
    {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
    },
  );

  if (result.status !== 0) {
    const detail = result.stderr.trim();
    throw new Error(
      `Could not configure the ephemeral Convex ${name} value.${detail === "" ? "" : ` ${detail}`}`,
    );
  }
}

function runChecked(command, args, description) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "inherit", "inherit"],
  });

  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${description} failed with exit code ${result.status ?? "unknown"}.`);
  }
}

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicExponent: 0x10001,
});
const privateKeyPem = privateKey
  .export({ format: "pem", type: "pkcs8" })
  .toString()
  .trimEnd()
  .replace(/\n/g, " ");
const publicJwk = publicKey.export({ format: "jwk" });
const jwks = JSON.stringify({
  keys: [{ ...publicJwk, alg: "RS256", use: "sig" }],
});

setConvexEnvironmentVariable("JWT_PRIVATE_KEY", privateKeyPem);
setConvexEnvironmentVariable("JWKS", jwks);
setConvexEnvironmentVariable("SITE_URL", siteUrl);

runChecked(
  "pnpm",
  ["exec", "convex", "run", "auth:isAuthenticated"],
  "Convex auth readiness probe",
);

const tests = spawnSync("pnpm", ["test:e2e"], {
  env: {
    ...process.env,
    REALWORLD_E2E_AUTH: "password-sign-up",
  },
  stdio: "inherit",
});

if (tests.error !== undefined) {
  throw tests.error;
}

process.exit(tests.status ?? 1);
