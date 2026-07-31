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

async function scanTree(patterns, findings) {
  const files = (await git(["ls-files", "-z"])).split("\0").filter(Boolean);
  for (const path of files) {
    scan(path, path, await readFile(path, "utf8").catch(() => ""), patterns, findings);
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
