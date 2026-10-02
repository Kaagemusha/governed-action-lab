// The public console runs under a Content Security Policy without
// 'unsafe-eval'. Zod probes `new Function` before compiling fast parsers;
// jitless mode skips that probe, so the page logs no CSP violation.
// Imported first by browser-runtime.ts so it runs before any schema parses.
import { config } from "zod";

config({ jitless: true });
