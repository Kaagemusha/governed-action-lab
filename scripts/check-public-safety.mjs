import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const { stdout } = await execute("git", ["ls-files", "-z"]);
const files = stdout.split("\0").filter(Boolean);
const forbiddenPaths = [
  /\/Users\//,
  /\/home\/[^/\s]+/,
  /\b(?:ANT-KB|Knowledge-Garden|markdown-vault|whitemore|ant-mini|clawd)\b/i,
  /\b[a-z0-9-]+\.lan\b/i,
];
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["'][^"']{8,}["']/i,
];
const approvalArtifact = /(?:^|\/)(?:\.approvals|\.receipts|\.runtime)(?:\/|$)|approvals\.json$|receipts\.json$/;
const allowedUrlPrefixes = [
  "https://example.invalid/",
  "https://github.com/Kaagemusha/context-layer-lab",
  "https://kaagemusha.github.io/governed-action-lab/",
];
const findings = [];

for (const file of files) {
  if (file === "scripts/check-public-safety.mjs") continue;
  if (file === ".env" || file.endsWith("/.env") || approvalArtifact.test(file)) {
    findings.push(`${file}: runtime or environment artifact must not be tracked`);
    continue;
  }
  if ([".png", ".jpg", ".jpeg", ".gif", ".ico"].includes(extname(file).toLowerCase())) continue;
  const content = await readFile(file, "utf8");
  for (const pattern of [...forbiddenPaths, ...secretPatterns]) {
    if (pattern.test(content)) findings.push(`${file}: matched ${pattern}`);
  }
  for (const match of content.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    if (match[0] !== "127.0.0.1") findings.push(`${file}: private or undeclared IP address: ${match[0]}`);
  }
  if (file.startsWith("examples/") || file.startsWith("data/") || file === "docs/sample-data.js") {
    for (const match of content.matchAll(/https?:\/\/[^\s"'<>`)]+/g)) {
      const url = match[0].replace(/[.,;:]$/, "");
      if (!allowedUrlPrefixes.some((prefix) => url.startsWith(prefix))) {
        findings.push(`${file}: URL is outside the public fixture allowlist: ${url}`);
      }
    }
  }
}

if (findings.length > 0) {
  console.error("Public-safety scan failed:");
  findings.forEach((finding) => console.error(`- ${finding}`));
  process.exitCode = 1;
} else {
  console.log(`public-safety scan passed (${files.length} tracked files)`);
}
