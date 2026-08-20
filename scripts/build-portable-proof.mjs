import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { policyManifestSchema, diagnosticSnapshotSchema } from "../dist/src/contracts.js";
import { buildPortableGreenProof } from "../dist/src/proof-packet.js";

const diagnosticPath = "examples/context-layer-diagnostic-v2.json";
const metadataPath = "examples/fixture-metadata-v2.json";
const policyPath = "data/policy.json";
const outputPath = "docs/governed-action-proof.json";

const diagnosticBytes = await readFile(diagnosticPath);
const diagnostic = diagnosticSnapshotSchema.parse(JSON.parse(diagnosticBytes.toString("utf8")));
if (diagnostic.format !== "context-layer-diagnostic/v2") {
  throw new Error(`${diagnosticPath} is not a v2 diagnostic`);
}
const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
const policy = policyManifestSchema.parse(JSON.parse(await readFile(policyPath, "utf8")));
const fixtureSha256 = createHash("sha256").update(diagnosticBytes).digest("hex");
if (fixtureSha256 !== metadata.fixtureSha256) {
  throw new Error(`${diagnosticPath} bytes do not match ${metadataPath}`);
}

const proof = await buildPortableGreenProof({ diagnostic, metadata, policy });
const expected = `${JSON.stringify(proof, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const actual = await readFile(outputPath, "utf8").catch(() => "");
  if (actual !== expected) {
    console.error(`${outputPath} has drifted; run npm run proof:sync`);
    process.exitCode = 1;
  } else {
    console.log("portable green proof is in sync");
  }
} else {
  await writeFile(outputPath, expected);
  console.log(`built ${outputPath}`);
}
