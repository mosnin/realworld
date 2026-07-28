import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const nextRoot = path.dirname(require.resolve("next/package.json"));

const postcssPackage = require(
  require.resolve("postcss/package.json", { paths: [nextRoot] }),
);
const sharp = require(require.resolve("sharp", { paths: [nextRoot] }));

assert.equal(
  postcssPackage.version,
  "8.5.23",
  "Next must resolve the reviewed PostCSS security override",
);
assert.equal(
  sharp.versions.sharp,
  "0.35.3",
  "Next must resolve the reviewed Sharp security override",
);
assert.equal(
  sharp.versions.vips,
  "8.18.3",
  "Sharp must load the reviewed libvips security release",
);

const source = await sharp({
  create: {
    width: 2,
    height: 2,
    channels: 4,
    background: { r: 17, g: 34, b: 51, alpha: 1 },
  },
})
  .png()
  .toBuffer();
const result = await sharp(source).resize(1, 1).webp().toBuffer({
  resolveWithObject: true,
});

assert.equal(result.info.format, "webp");
assert.equal(result.info.width, 1);
assert.equal(result.info.height, 1);

console.log(
  `Verified PostCSS ${postcssPackage.version}, Sharp ${sharp.versions.sharp}, and libvips ${sharp.versions.vips}.`,
);
