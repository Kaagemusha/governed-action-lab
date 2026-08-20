import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const chrome = spawn(chromePath, [
  "--headless=new",
  "--no-first-run",
  "--disable-extensions",
  ...(process.env.CI ? ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] : []),
  `--user-data-dir=${profile}`,
  "--remote-debugging-port=0",
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

let chromeStderr = "";
let chromeSpawnError;
chrome.on("error", (error) => {
  chromeSpawnError = error;
});
chrome.stderr.setEncoding("utf8");
chrome.stderr.on("data", (chunk) => {
  chromeStderr = `${chromeStderr}${chunk}`.slice(-8_000);
});

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const activePortFile = join(profile, "DevToolsActivePort");
let socket;

try {
  const startupDeadline = Date.now() + 30_000;
  let page;
  while (Date.now() < startupDeadline) {
    if (chromeSpawnError) {
      throw new Error(`Could not start Chrome at ${chromePath}: ${chromeSpawnError.message}`);
    }
    if (chrome.exitCode !== null || chrome.signalCode !== null) {
      const detail = chromeStderr.trim();
      throw new Error(
        `Chrome at ${chromePath} exited before DevTools started (code ${chrome.exitCode}, signal ${chrome.signalCode}).${detail ? `\n${detail}` : ""}`,
      );
    }

    const activePort = await readFile(activePortFile, "utf8").catch(() => null);
    const debugPort = Number.parseInt(activePort?.split(/\r?\n/, 1)[0] ?? "", 10);
    if (Number.isInteger(debugPort) && debugPort > 0 && debugPort <= 65_535) {
      const pages = await fetch(`http://127.0.0.1:${debugPort}/json`, {
        signal: AbortSignal.timeout(1_000),
      })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null);
      page = Array.isArray(pages) ? pages.find((candidate) => candidate.type === "page") : undefined;
      if (page) break;
    }
    await sleep(100);
  }
  if (!page) {
    const detail = chromeStderr.trim();
    throw new Error(
      `Chrome DevTools at ${chromePath} did not expose a page target within 30 seconds.${detail ? `\n${detail}` : ""}`,
    );
  }

  socket = new WebSocket(page.webSocketDebuggerUrl);
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
  socket?.close();
  if (chrome.exitCode === null && chrome.signalCode === null) {
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    chrome.kill("SIGTERM");
    await Promise.race([exited, sleep(2_000)]);
    if (chrome.exitCode === null && chrome.signalCode === null) {
      chrome.kill("SIGKILL");
      await Promise.race([new Promise((resolve) => chrome.once("exit", resolve)), sleep(2_000)]);
    }
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
