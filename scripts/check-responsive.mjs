import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";

const chromeCandidates = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
].filter(Boolean);
let chromePath;
for (const candidate of chromeCandidates) {
  if (await access(candidate).then(() => true).catch(() => false)) {
    chromePath = candidate;
    break;
  }
}
if (!chromePath) throw new Error("Chrome is required for responsive QA. Set CHROME_PATH.");

const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};
await mkdir("output/screenshots", { recursive: true });
const server = createServer(async (request, response) => {
  const pathname = request.url === "/" ? "/index.html" : new URL(request.url, "http://local").pathname;
  const relative = normalize(pathname).replace(/^[/\\]+/, "");
  if (relative.startsWith("..")) {
    response.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(join("docs", relative));
    response.writeHead(200, { "content-type": mime[extname(relative)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Could not bind QA server.");

const profile = await mkdtemp(join(tmpdir(), "governed-responsive-"));
const debugPort = 9327;
const chrome = spawn(chromePath, [
  "--headless=new",
  "--no-first-run",
  "--disable-extensions",
  ...(process.env.CI ? ["--no-sandbox"] : []),
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${debugPort}`,
  "about:blank",
], { stdio: "ignore" });

let pages;
for (let attempt = 0; attempt < 50; attempt += 1) {
  pages = await fetch(`http://127.0.0.1:${debugPort}/json`).then((response) => response.json()).catch(() => null);
  if (pages) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!pages) throw new Error("Chrome DevTools did not start.");
const page = pages.find((candidate) => candidate.type === "page");
if (!page) throw new Error("No Chrome page target.");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let identifier = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const handler = pending.get(message.id);
  if (!handler) return;
  pending.delete(message.id);
  if (message.error) handler.reject(new Error(message.error.message));
  else handler.resolve(message.result);
});
function send(method, params = {}) {
  identifier += 1;
  return new Promise((resolve, reject) => {
    pending.set(identifier, { resolve, reject });
    socket.send(JSON.stringify({ id: identifier, method, params }));
  });
}

try {
  await send("Page.enable");
  for (const width of [320, 375, 390]) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await send("Page.navigate", { url: `http://127.0.0.1:${address.port}/` });
    await new Promise((resolve) => setTimeout(resolve, 650));
    const evaluation = await send("Runtime.evaluate", {
      expression: `(() => {
        const offenders = [...document.body.querySelectorAll('*')].filter((element) => {
          const style = getComputedStyle(element);
          if (style.position === 'fixed') return false;
          const box = element.getBoundingClientRect();
          return box.left < -1 || box.right > innerWidth + 1;
        }).slice(0, 10).map((element) => element.id ? '#' + element.id : element.className || element.tagName);
        return {
          innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          offenders
        };
      })()`,
      returnByValue: true,
    });
    const result = evaluation.result.value;
    if (result.documentWidth !== width || result.offenders.length > 0) {
      throw new Error(`${width}px overflow: ${JSON.stringify(result)}`);
    }
    console.log(`PASS responsive ${width}px`);
    if (width === 390) {
      const heightResult = await send("Runtime.evaluate", {
        expression: "document.documentElement.scrollHeight",
        returnByValue: true,
      });
      const capture = await send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height: heightResult.result.value, scale: 1 },
      });
      await writeFile("output/screenshots/governed-action-mobile-390.png", Buffer.from(capture.data, "base64"));
    }
  }
} finally {
  socket.close();
  chrome.kill("SIGTERM");
  server.close();
}
