import { tmpdir } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";

const stablePreviewHost = "realworld-cloud-preview-mosnins-projects.vercel.app";
const temporaryOutputPrefix = "realworld-cloud-preview-";

export function requireCloudPreviewSettings() {
  const value = process.env.REALWORLD_CLOUD_PREVIEW_URL;
  if (value === undefined || value === "") {
    throw new Error("REALWORLD_CLOUD_PREVIEW_URL is required for cloud-preview E2E.");
  }

  const url = new URL(value);
  if (
    url.protocol !== "https:"
    || url.hostname !== stablePreviewHost
    || url.port !== ""
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new Error("REALWORLD_CLOUD_PREVIEW_URL must be the reviewed stable protected preview origin without credentials, a path, query, or hash.");
  }

  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (secret === undefined || secret === "") {
    throw new Error("VERCEL_AUTOMATION_BYPASS_SECRET is required for cloud-preview E2E.");
  }

  return {
    baseURL: url.origin,
    protectionHeaders: {
      "x-vercel-protection-bypass": secret,
      "x-vercel-set-bypass-cookie": "true",
    },
  };
}

export function requireTemporaryCloudPreviewOutputDirectory() {
  const value = process.env.REALWORLD_CLOUD_PREVIEW_OUTPUT_DIR;
  if (value === undefined || value === "") {
    throw new Error("REALWORLD_CLOUD_PREVIEW_OUTPUT_DIR is required; use pnpm test:e2e:cloud-preview so the output is removed after the run.");
  }

  const outputDirectory = resolve(value);
  const temporaryRoot = resolve(tmpdir());
  const pathFromTemporaryRoot = relative(temporaryRoot, outputDirectory);
  if (
    !isAbsolute(value)
    || pathFromTemporaryRoot === ""
    || pathFromTemporaryRoot.startsWith("..")
    || isAbsolute(pathFromTemporaryRoot)
    || !basename(outputDirectory).startsWith(temporaryOutputPrefix)
  ) {
    throw new Error("REALWORLD_CLOUD_PREVIEW_OUTPUT_DIR must be a wrapper-created temporary directory.");
  }

  return outputDirectory;
}
