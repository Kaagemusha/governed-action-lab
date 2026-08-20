import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a path.`);
  }
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const metadataPath = resolve("examples/fixture-metadata.json");
const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
const required = [
  "producer",
  "producerCommit",
  "producerArtifact",
  "format",
  "fixture",
  "fixtureSha256",
];

for (const field of required) {
  if (typeof metadata[field] !== "string" || metadata[field].length === 0) {
    throw new Error(`Fixture metadata requires a non-empty ${field}.`);
  }
}
if (!/^[0-9a-f]{40}$/.test(metadata.producerCommit)) {
  throw new Error("producerCommit must be a full Git commit SHA.");
}
if (!/^[0-9a-f]{64}$/.test(metadata.fixtureSha256)) {
  throw new Error("fixtureSha256 must be a lowercase SHA-256 digest.");
}
if (metadata.producerArtifact.startsWith("/") || metadata.producerArtifact.split("/").includes("..")) {
  throw new Error("producerArtifact must be a repository-relative path without traversal.");
}

const fixturePath = resolve("examples", metadata.fixture);
const fixtureBytes = await readFile(fixturePath);
const fixture = JSON.parse(fixtureBytes.toString("utf8"));
if (fixture.format !== metadata.format) {
  throw new Error(`Fixture format ${fixture.format ?? "missing"} does not match ${metadata.format}.`);
}
const actualHash = sha256(fixtureBytes);
if (actualHash !== metadata.fixtureSha256) {
  throw new Error(`Fixture SHA-256 drifted: expected ${metadata.fixtureSha256}, received ${actualHash}.`);
}

const producerRoot = argument("--producer-root");
if (producerRoot) {
  const { stdout } = await run(
    "git",
    ["-C", resolve(producerRoot), "show", `${metadata.producerCommit}:${metadata.producerArtifact}`],
    { encoding: "buffer", maxBuffer: 10 * 1024 * 1024 },
  );
  const producerBytes = Buffer.from(stdout);
  if (!producerBytes.equals(fixtureBytes)) {
    throw new Error("Frozen fixture differs from the artifact at the declared producer commit.");
  }
}

console.log(
  `context contract passed (${metadata.format}, ${actualHash.slice(0, 12)}${
    producerRoot ? ", producer commit matched" : ""
  })`,
);
