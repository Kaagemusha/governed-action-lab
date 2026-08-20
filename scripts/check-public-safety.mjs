import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const args = process.argv.slice(2);
const prePush = args.includes("--pre-push");
const probeIndex = args.indexOf("--scan-file");
const probeFile = probeIndex >= 0 ? args[probeIndex + 1] : null;
const binary = new Set([".doc", ".docx", ".gif", ".ico", ".jpeg", ".jpg", ".pdf", ".png", ".webp", ".zip"]);
const genericPatterns = [
  /\/Users\/[^/\s]+\//,
  /\/home\/[^/\s]+\//,
  /\/private\/var\/folders\//,
  /\b[a-z0-9-]+\.lan\b/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["'][^"']{8,}["']/i,
];
const runtimeArtifact = /(?:^|\/)(?:\.approvals|\.receipts|\.runtime)(?:\/|$)/;
const allowedFixtureUrls = [
  "https://example.invalid/",
  "https://github.com/Kaagemusha/context-layer-lab",
  "https://github.com/Kaagemusha/governed-action-lab",
  "https://kaagemusha.github.io/context-layer-lab/",
  "https://kaagemusha.github.io/governed-action-lab/",
];

async function git(arguments_) {
  return exec("git", arguments_, { maxBuffer: 20 * 1024 * 1024 }).then((result) => result.stdout);
}

async function stdin() {
  let value = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) value += chunk;
  return value;
}

function literalPattern(value) {
  return new RegExp(value.replace(/[.*+?^{}$()|[\]\\]/g, "\\$&"), "i");
}

async function loadPrivatePatterns(required) {
  const configured = process.env.PUBLIC_SAFETY_PATTERNS_FILE
    || await git(["config", "--get", "publicSafety.patternsFile"]).then((value) => value.trim()).catch(() => "");
  if (!configured) {
    if (required) throw new Error("set git config publicSafety.patternsFile before pushing");
    return [];
  }
  const path = resolve(configured.replace(/^~(?=\/)/, homedir()));
  const content = await readFile(path, "utf8").catch(() => null);
  if (content === null) {
    if (required) throw new Error("private safety pattern file is unreadable: " + path);
    return [];
  }
  return content.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map(literalPattern);
}

function scan(label, path, content, patterns, findings) {
  if (path === ".env" || path.endsWith("/.env") || runtimeArtifact.test(path)) {
    findings.add(label + ": runtime or environment artifact must not be tracked");
    return;
  }
  if (path === "scripts/check-public-safety.mjs" || binary.has(extname(path).toLowerCase())) return;
  for (const pattern of patterns) {
    if (pattern.test(content)) findings.add(label + ": matched a public-safety pattern");
  }
  for (const match of content.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    if (match[0] !== "127.0.0.1") findings.add(label + ": private or undeclared IP: " + match[0]);
  }
  if (path.startsWith("examples/") || path.startsWith("data/") || path === "docs/sample-data.js") {
    for (const match of content.matchAll(/https?:\/\/[^\s"'<>),\x60]+/g)) {
      const url = match[0].replace(/[.,;:]$/, "");
      if (!allowedFixtureUrls.some((prefix) => url.startsWith(prefix))) {
        findings.add(label + ": fixture URL is outside the allowlist: " + url);
      }
    }
  }
}

function sameKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function validatePortableProof(content, findings) {
  let packet;
  try {
    packet = JSON.parse(content);
  } catch {
    findings.add("docs/governed-action-proof.json: portable proof is not valid JSON");
    return;
  }
  const fail = (condition, message) => {
    if (!condition) findings.add(`docs/governed-action-proof.json: ${message}`);
  };
  fail(sameKeys(packet, ["schemaVersion", "mode", "synthetic", "diagnosticSource", "diagnostic", "policy", "review", "approvalBoundary", "receipt", "packetDigest"]), "portable proof has an unexpected top-level shape");
  fail(packet.schemaVersion === "governed-action-proof/v1", "unexpected proof schema");
  fail(packet.mode === "synthetic_green_inspection" && packet.synthetic === true, "proof is not explicitly synthetic green inspection");
  fail(sameKeys(packet.diagnosticSource, ["producer", "producerCommit", "producerArtifact", "format", "fixtureSha256", "diagnosticCanonicalSha256"]), "diagnostic source has an unexpected shape");
  fail(packet.diagnosticSource?.producer === "Kaagemusha/context-layer-lab", "unexpected diagnostic producer");
  fail(packet.diagnosticSource?.producerCommit === "5d74a5c5a0d1269a916612bcc69db60003ea69b8", "diagnostic commit is not frozen");
  fail(packet.diagnosticSource?.producerArtifact === "docs/operational-health.json", "unexpected producer artifact");
  fail(packet.diagnosticSource?.format === "context-layer-diagnostic/v2", "proof source is not diagnostic v2");
  fail(packet.diagnosticSource?.fixtureSha256 === "2398c03fe8d80c941dc66827be0a4a7015f799d63cda06dbdc84778934273064", "fixture byte digest is not frozen");
  fail(packet.diagnosticSource?.diagnosticCanonicalSha256 === "3856460b1b54ff9dcfe7b86e442dac7ca1dc021c9d835f486f609950efab69c5", "fixture canonical digest is not frozen");
  fail(packet.diagnostic?.format === "context-layer-diagnostic/v2", "embedded diagnostic is not v2");
  fail(packet.diagnostic?.scenario?.asOf === "2026-07-28T09:10:00Z", "diagnostic time is not frozen");
  fail(packet.policy?.schemaVersion === "governed-action-policy/v1" && packet.policy?.id === "governed-action-lab-public-policy" && packet.policy?.version === "1.3.0", "proof does not embed public policy 1.3.0");
  fail(packet.review?.schemaVersion === "governed-action-review/v2" && packet.review?.status === "READY", "proof review is not READY v2");
  fail(packet.review?.request?.action?.type === "inspect_run_receipt" && packet.review?.request?.action?.laneId === "site-refresh", "proof action is not the bounded green inspection");
  fail(packet.review?.request?.target?.environment === "read_only", "proof target is not read-only");
  fail(packet.review?.request?.proposedAt === "2026-07-28T09:10:00.000Z" && packet.review?.decision?.decisionAt === "2026-07-28T09:10:00.000Z", "review times are not frozen");
  fail(sameKeys(packet.approvalBoundary, ["required", "grant"]) && packet.approvalBoundary.required === false && packet.approvalBoundary.grant === null, "proof carries an approval boundary");
  fail(packet.receipt?.schemaVersion === "governed-action-receipt/v1" && packet.receipt?.result === "succeeded", "receipt is not a successful v1 receipt");
  fail(packet.receipt?.approvalId === null, "receipt carries an approval");
  fail(packet.receipt?.startedAt === "2026-07-28T09:10:00.000Z" && packet.receipt?.endedAt === "2026-07-28T09:10:00.000Z", "receipt times are not frozen");
  fail(packet.receipt?.effects?.length === 1 && packet.receipt.effects[0]?.kind === "read" && packet.receipt.effects[0]?.beforeHash === packet.receipt.effects[0]?.afterHash, "receipt is not a single read-only effect");
  for (const match of content.matchAll(/https?:\/\/[^\s"'<>),\x60]+/g)) {
    const url = match[0].replace(/[.,;:]$/, "");
    if (!allowedFixtureUrls.some((prefix) => url.startsWith(prefix))) {
      findings.add("docs/governed-action-proof.json: proof URL is outside the allowlist: " + url);
    }
  }
}

async function scanTree(patterns, findings) {
  const files = (await git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]))
    .split("\0").filter(Boolean);
  for (const path of files) {
    const content = await readFile(path, "utf8").catch(() => "");
    scan(path, path, content, patterns, findings);
    if (path === "docs/governed-action-proof.json") validatePortableProof(content, findings);
  }
  return files.length;
}

async function outgoingCommits(input) {
  const commits = new Set();
  for (const line of input.trim().split(/\r?\n/).filter(Boolean)) {
    const [, localSha, , remoteSha] = line.split(/\s+/);
    if (!localSha || /^0+$/.test(localSha)) continue;
    const revisions = remoteSha && !/^0+$/.test(remoteSha)
      ? [remoteSha + ".." + localSha]
      : [localSha, "--not", "--remotes"];
    (await git(["rev-list", ...revisions])).trim().split(/\r?\n/).filter(Boolean)
      .forEach((commit) => commits.add(commit));
  }
  return commits;
}

async function scanHistory(commits, patterns, findings) {
  for (const commit of commits) {
    const paths = (await git(["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", commit]))
      .split("\0").filter(Boolean);
    for (const path of paths) {
      if (binary.has(extname(path).toLowerCase())) continue;
      const content = await git(["show", commit + ":" + path]).catch(() => "");
      scan(commit.slice(0, 12) + ":" + path, path, content, patterns, findings);
    }
  }
}

try {
  const patterns = [...genericPatterns, ...await loadPrivatePatterns(prePush)];
  const findings = new Set();
  let count = 1;
  if (probeFile) {
    scan(probeFile, probeFile, await readFile(probeFile, "utf8"), patterns, findings);
  } else {
    count = await scanTree(patterns, findings);
    if (prePush) await scanHistory(await outgoingCommits(await stdin()), patterns, findings);
  }
  if (findings.size) {
    console.error("Public-safety scan failed:");
    for (const finding of findings) console.error("- " + finding);
    process.exitCode = 1;
  } else {
    console.log("public-safety scan passed (" + count + " file(s)" + (prePush ? ", outgoing history checked" : "") + ")");
  }
} catch (error) {
  console.error("Public-safety scan failed closed: " + error.message);
  process.exitCode = 1;
}
