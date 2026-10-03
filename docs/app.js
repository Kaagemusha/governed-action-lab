// Governed Action Lab console. Framework-free ES module with no network calls
// after load. Every decision on screen comes from buildPublicDemo's return
// value; receipts come only from buildSyntheticBrowserReceipt, and a retry
// receipt is built only by the click handler of the dialog's confirm button.

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const BEAT_MS = REDUCED ? 0 : 240;
const LAB1 = "https://kaagemusha.github.io/context-layer-lab/";
const REPO = "https://github.com/Kaagemusha/governed-action-lab";
const ATTACK_MATRIX = `${REPO}/blob/main/docs/attack-matrix.md`;

// ---- Shared time formatter (spec 1.11, verbatim) ----
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
// Public scenario: time of day on the labelled scenario clock.
function clock(iso, scenarioIso) {
  const d = new Date(iso), s = new Date(scenarioIso);
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (ymd(d) === ymd(s)) return hm;
  const next = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate() + 1));
  if (ymd(d) === ymd(next)) return `${hm} the next day`;
  return stamp(iso);
}
// A visitor's own file: always absolute.
function stamp(iso) {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}
function span(ms) {
  const m = Math.round(Math.abs(ms) / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}
const ms = (n) => (n < 1 ? "under 1 ms" : `${Math.round(n)} ms`);
// In public mode use clock(); in own-file mode use stamp() everywhere. Raw ISO never reaches the screen.

// ---- DOM helpers: data only ever reaches the page through textContent / setAttribute ----
const $ = (id) => document.getElementById(id);
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}
const mark = (kind, extra) => el("span", { class: `mark ${kind}${extra ? " " + extra : ""}`, "aria-hidden": "true" });
const word = (kind, text) => el("span", { class: `word ${kind}` }, text);
const stateWord = (kind, text) => el("span", { class: "state" }, mark(kind), word(kind, text));
const clear = (node) => { node.replaceChildren(); return node; };
const data = (text) => el("span", { class: "data" }, text);
const shortHash = (h) => (typeof h === "string" && h.length > 12 ? `${h.slice(0, 8)}…${h.slice(-4)}` : String(h ?? ""));
const short = (h) => el("span", { class: "data hash" }, shortHash(h));
function dirRow(label, ...value) {
  return el("div", { class: "dir" },
    el("dt", { class: "dir-label" }, label),
    el("span", { class: "dir-leader", "aria-hidden": "true" }),
    el("dd", { class: "dir-value" }, ...value));
}

let announceFrame = 0;
function announce(text) {
  const node = $("announcer");
  node.textContent = "";
  cancelAnimationFrame(announceFrame);
  announceFrame = requestAnimationFrame(() => { node.textContent = text; });
}

function words(value) {
  if (value === null || value === undefined) return "";
  const s = String(value).replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
function omit(object, key) {
  const copy = { ...object };
  delete copy[key];
  return copy;
}
function durationWords(seconds) {
  if (seconds % 86400 === 0) return span(seconds * 1000);
  if (seconds % 60 === 0) { const m = seconds / 60; return `${m} ${m === 1 ? "minute" : "minutes"}`; }
  return `${seconds} seconds`;
}

// ---- Module state ----
let runtime = null;
let sample = null;
let diagnostic = null;
let demos = [];
let mode = "sample";
let fileName = "";
let selected = "retry_failed_lane";
let paths = freshPaths();
let approvedByClick = false;
let dialogOpener = null;
let booted = false;
const timers = new Set();

const PATH_IDS = { inspect_run_receipt: "path-read", retry_failed_lane: "path-retry", delete_preserved_output: "path-delete" };
const HASH_FOR = { inspect_run_receipt: "#read", retry_failed_lane: "#retry", delete_preserved_output: "#delete" };
const PATH_FOR_HASH = { "#read": "inspect_run_receipt", "#retry": "retry_failed_lane", "#delete": "delete_preserved_output" };

function freshPaths() {
  return {
    inspect_run_receipt: { receipt: null, revealed: 0, tamper: false, again: false },
    retry_failed_lane: { phase: "waiting", receipt: null, revealed: 0, tamper: false, reuse: false },
    delete_preserved_output: { forge: null },
  };
}
function clearTimers() { for (const t of timers) clearTimeout(t); timers.clear(); }
function later(fn, delay) {
  if (delay <= 0) { fn(); return; }
  const t = setTimeout(() => { timers.delete(t); fn(); }, delay);
  timers.add(t);
}
const clockFor = (packet) => ({ now: () => new Date(packet.scenario.asOf) });

// ---- View model (derived from the computed demo only) ----
function view(actionType) {
  const item = demos.find((d) => d.actionType === actionType);
  const sc = diagnostic.scenario;
  const asOf = sc.asOf;
  const own = mode === "file";
  const t = (iso) => (own ? stamp(iso) : clock(iso, asOf));
  const on = (iso) => (own ? `${stamp(iso)} on your diagnostic's clock` : `${clock(iso, asOf)} on the scenario clock`);
  const laneId = item.request.action.laneId;
  const lane = sc.lanes.find((l) => l.id === laneId);
  const label = lane?.label ?? laneId;
  const laneReceipt = sc.receipts.find((r) => r.recordId === item.request.action.recordId)
    ?? sc.receipts.find((r) => r.laneId === laneId);
  const record = diagnostic.records.find((r) => r.id === item.request.action.recordId);
  const rule = PUBLIC_POLICY().rules.find((r) => r.actionType === actionType);
  return { item, request: item.request, decision: item.decision, sc, asOf, own, t, on, label, laneReceipt, record, rule };
}
const PUBLIC_POLICY = () => sample.PUBLIC_POLICY;

function pathTitle(actionType, label) {
  if (actionType === "inspect_run_receipt") return `Read ${label}'s failed run record`;
  if (actionType === "retry_failed_lane") return `Retry ${label} in the sandbox`;
  if (actionType === "delete_preserved_output") return `Delete ${label}'s unpublished output`;
  return `${words(actionType)}: ${label}`;
}
function outcomeOf(decision, actionType) {
  if (decision.disposition === "allow") return { kind: "ok", text: "Allowed automatically" };
  // Once you approve, the row says so instead of still asking for approval.
  if (decision.disposition === "approval_required" && actionType === "retry_failed_lane"
    && paths.retry_failed_lane.phase === "approved") return { kind: "ok", text: "Approved once by you" };
  if (decision.disposition === "approval_required") return { kind: "hold", text: "Needs your approval" };
  if (decision.disposition === "refuse") return { kind: "stop", text: "Refused by policy" };
  return { kind: "pending", text: words(decision.disposition) };
}
function outcomeVerb(outcome) {
  return outcome === "failed" ? "failed" : words(outcome).toLowerCase();
}

// ---- Stage: header lines and path rows ----
function renderHeader() {
  const v = view("retry_failed_lane");
  const r = v.laneReceipt;
  const from = clear($("from-line"));
  if (mode === "file") {
    $("clock-line").textContent = `Your diagnostic's clock: ${stamp(v.asOf)}.`;
    from.append(`From your diagnostic, ${fileName}: ${v.label} ${outcomeVerb(r?.outcome)} at ${r ? stamp(r.observedAt) : "an unknown time"}.`);
    $("paths-title").textContent = "Three paths, recomputed from your file.";
  } else {
    $("clock-line").textContent = `Scenario clock: ${clock(v.asOf, v.asOf)} UTC, ${stamp(v.asOf).replace(/, \d\d:\d\d UTC$/, "")}, fixed.`;
    from.append("From ", el("a", { href: LAB1 }, "lab 1"), `: ${v.label} ${outcomeVerb(r?.outcome)} at ${r ? clock(r.observedAt, v.asOf) : "an unknown time"}.`);
    $("paths-title").textContent = "Try the three public paths.";
  }
}

function renderPathRows() {
  for (const [actionType, id] of Object.entries(PATH_IDS)) {
    const v = view(actionType);
    const row = $(id).closest(".path");
    row.querySelector(".path-title").textContent = pathTitle(actionType, v.label);
    const o = outcomeOf(v.decision, actionType);
    clear(row.querySelector(".path-outcome")).append(mark(o.kind), word(o.kind, o.text));
  }
}

function placeSelection() {
  for (const [actionType, id] of Object.entries(PATH_IDS)) {
    const input = $(id);
    const isSel = actionType === selected;
    input.checked = isSel;
    input.closest(".path").classList.toggle("is-selected", isSel);
  }
  const row = $(PATH_IDS[selected]).closest(".path");
  if (row.nextElementSibling !== $("path-detail")) row.after($("path-detail"));
}

// ---- Detail panel ----
function setAction(label, variant) {
  const btn = $("path-action");
  btn.hidden = false;
  btn.removeAttribute("aria-disabled");
  btn.textContent = label;
  btn.className = variant === "text" ? "btn-text" : `btn btn-${variant}`;
}
function renderDetail() {
  const text = $("detail-text");
  const extra = clear($("detail-extra"));
  extra.hidden = true;
  if (selected === "inspect_run_receipt") {
    const p = paths.inspect_run_receipt;
    if (!p.receipt) {
      text.textContent = "Reads the record. Changes nothing, so policy lets the agent do it without asking.";
      setAction("Run the read", "primary");
    } else {
      text.textContent = "Done. Read only, state unchanged. The receipt is below.";
      setAction("Run the read again", "secondary");
      if (p.again) { extra.hidden = false; extra.append(el("p", { class: "detail-result" }, p.again)); }
    }
  } else if (selected === "retry_failed_lane") {
    const p = paths.retry_failed_lane;
    if (p.phase === "approved") {
      text.textContent = "Approved once. One synthetic retry record was created. The receipt is below.";
      setAction("Try to reuse the approval", "secondary");
      if (p.reuse) {
        extra.hidden = false;
        extra.append(el("p", { class: "detail-result" }, p.reuse, " ", el("a", { href: ATTACK_MATRIX }, "Attack matrix")));
      }
    } else if (p.phase === "declined") {
      text.textContent = "Not approved. Nothing ran. The agent cannot retry without a new approval.";
      setAction("Review and approve", "primary");
    } else {
      text.textContent = "Changes state, so policy holds it for a person. You are that person.";
      setAction("Review and approve", "primary");
    }
  } else {
    text.textContent = "Refused before any approval or adapter. Nothing will run, and no approval can override it.";
    setAction("Go to the decision record", "text");
  }
}

// ---- Trace ----
function setStep(step, kind, label, extra) {
  const li = document.querySelector(`#trace li[data-step="${step}"]`);
  const waiting = kind === "waiting";
  li.querySelector(".mark").className = `mark ${waiting ? "hold waiting" : kind}`;
  li.classList.toggle("is-current", waiting);
  const body = clear(li.querySelector(".t-body"));
  body.append(el("span", { class: "t-label" }, ...[label].flat()));
  for (const node of [extra].flat()) if (node) body.append(node);
}
function checklist(v, p) {
  const policy = PUBLIC_POLICY();
  const list = el("ul", { class: "check-list", "aria-label": "What this retry needs" });
  const after = p.revealed >= 2 && p.receipt;
  for (const req of v.decision.requirements) {
    let kind = "pending", status = "Checked when it runs", name = words(req);
    if (req === "exact_human_approval") {
      name = "Exact human approval";
      if (p.phase === "approved") { kind = "ok"; status = "Approved by you"; }
      else if (p.phase === "declined") { kind = "hold"; status = "Not approved"; }
      else { kind = "hold"; status = "Waiting for you"; }
    } else if (req === "fresh_evidence") {
      name = "Fresh evidence";
      const r = v.laneReceipt;
      if (r) {
        const age = Date.parse(v.request.proposedAt) - Date.parse(r.observedAt);
        const limit = policy.maxEvidenceAgeSeconds * 1000;
        if (age <= limit) { kind = "ok"; const nb = (s) => el("span", { class: "nowrap" }, s);
          status = [`Observed ${v.t(r.observedAt)}, `, nb(span(age)), " before the proposal. Policy limit ", nb(span(limit)), "."]; }
        else { kind = "stop"; status = "Too old"; }
      } else { kind = "stop"; status = "No run receipt"; }
    } else if (req === "passing_precondition") {
      name = "Target state unchanged";
      if (after && p.receipt.preconditionCheck?.passed) { kind = "ok"; status = "Recorded as matched by the synthetic receipt"; }
    } else if (req === "authorized_compensation") {
      name = "Undo plan authorized in advance";
      if (after && p.receipt.compensation?.authorized) { kind = "ok"; status = p.receipt.compensation.result === "not_needed" ? "Authorized, not needed" : `Authorized, ${words(p.receipt.compensation.result).toLowerCase()}`; }
    }
    list.append(el("li", {}, mark(kind), el("span", {}, el("span", { class: "check-name" }, name), " ", word(kind === "pending" ? "pending" : kind, status))));
  }
  return list;
}
function renderTrace() {
  const v = view(selected);
  setStep("proposed", "ok", `By the agent, at ${v.on(v.request.proposedAt)}.`);
  if (selected === "inspect_run_receipt") {
    const p = paths.inspect_run_receipt;
    setStep("policy", "ok", "Allowed. Reading changes nothing.");
    setStep("approval", "stale", "Not needed for a read.");
    const e = p.receipt?.effects?.[0];
    if (p.receipt && p.revealed >= 1) setStep("runs", "ok", ["Read once. State ", short(e?.beforeHash), " before and after."]);
    else setStep("runs", "pending", "Not yet.");
    if (p.receipt && p.revealed >= 2) setStep("record", "ok", "Receipt written. See below.");
    else setStep("record", "pending", "Not yet.");
  } else if (selected === "retry_failed_lane") {
    const p = paths.retry_failed_lane;
    setStep("policy", "hold", "Held for a person. A retry changes state, so this exact request needs approval.", checklist(v, p));
    if (p.phase === "approved") {
      const until = Date.parse(v.decision.decisionAt) + (v.rule?.maxApprovalLifetimeSeconds ?? 0) * 1000;
      setStep("approval", "ok", `Approved once by you at ${v.t(v.decision.decisionAt)}. Valid until ${v.t(new Date(until).toISOString())}, for this exact request only.`);
    } else if (p.phase === "declined") {
      setStep("approval", "hold", "Not approved. Nothing ran.");
    } else {
      setStep("approval", "waiting", "Waiting for you.");
    }
    const e = p.receipt?.effects?.[0];
    if (p.receipt && p.revealed >= 1) setStep("runs", "ok", ["Ran once in the browser sandbox. State ", short(e?.beforeHash), " became ", short(e?.afterHash), "."]);
    else setStep("runs", "pending", "Runs only after approval.");
    if (p.receipt && p.revealed >= 2) setStep("record", "ok", "Receipt written. See below.");
    else setStep("record", "pending", "Nothing recorded yet.");
  } else {
    setStep("policy", "stop", "Refused. This action has no adapter and no allowed environment.",
      el("span", { class: "t-detail" }, "In plain words: deleting unpublished output is in the catalog but marked as never runnable, in any environment."));
    setStep("approval", "stale", "Not offered. A refused action has no approval step.");
    setStep("runs", "stale", "Never runs.");
    setStep("record", "ok", "Decision recorded. Nothing ran. See below.");
  }
}

// ---- Record area: receipt slip (read, retry) or decision record (delete) ----
function renderRecord() {
  const area = clear($("record-area"));
  if (selected === "delete_preserved_output") { area.append(decisionRecord()); return; }
  const p = paths[selected];
  if (p.receipt && p.revealed >= 2) area.append(slip(selected, p));
}

function slip(actionType, p) {
  const v = view(actionType);
  const r = p.receipt;
  const e = r.effects?.[0];
  const isRead = actionType === "inspect_run_receipt";
  const resultValue = p.tamper
    ? el("span", {}, el("s", {}, words(r.result)), " ", el("span", { class: "stop" }, "Failed (edited)"))
    : words(r.result);
  const status = el("p", { class: "slip-status", id: `slip-status-${actionType}` }, p.slipStatus ?? "");
  status.hidden = !p.slipStatus;
  const tamperBtn = el("button", { class: "btn btn-secondary", type: "button", "aria-pressed": String(!!p.tamper), "data-slip": "tamper" }, p.tamper ? "Undo the change" : "Change one field");
  return el("article", { class: "slip", "aria-labelledby": "slip-title" },
    el("h3", { id: "slip-title", tabindex: "-1" }, "Receipt"),
    el("p", { class: "slip-summary" }, isRead ? "Read only. Nothing changed." : "One synthetic retry record created. Undo not needed."),
    el("p", { class: "small" }, "A receipt records what ran, the state before and after, and how it was checked."),
    el("dl", { class: "slip-rows" },
      dirRow("Action", pathTitle(actionType, v.label)),
      dirRow("Approval", isRead ? "Not needed" : "Yours, once (simulated in this browser)"),
      dirRow("Result", resultValue),
      dirRow("Effect", ...(isRead
        ? ["State ", short(e?.beforeHash), ", unchanged"]
        : ["State ", short(e?.beforeHash), " became ", short(e?.afterHash)])),
      dirRow("Recorded check", `"${r.verification?.detail ?? ""}"`),
      dirRow("Undo plan", isRead ? "Not applicable to a read" : (r.compensation?.authorized ? "Authorized, not needed" : words(r.compensation?.result))),
      dirRow("Time", v.on(r.startedAt)),
      dirRow("Receipt", data(r.id)),
      dirRow("Digest", data(r.receiptDigest))),
    el("div", { class: "slip-actions" },
      el("button", { class: "btn btn-secondary", type: "button", "data-slip": "check" }, "Check the digest"),
      tamperBtn,
      el("button", { class: "btn btn-secondary", type: "button", "data-slip": "save" }, "Save receipt (JSON)")),
    status,
    el("p", { class: "slip-foot" }, "Synthetic receipt from a browser-only sandbox (adapter ", el("span", { class: "data" }, r.adapter?.version ?? "browser-synthetic/1"), "). Not production authorization. Check a saved file with ", el("code", {}, "npm run action -- verify-receipt --receipt <file>"), "."));
}

function decisionRecord() {
  const v = view("delete_preserved_output");
  const d = v.decision;
  const p = paths.delete_preserved_output;
  const reasons = el("ul", { class: "reasons" }, ...d.reasons.map((r) => el("li", {}, el("code", {}, r.code), el("span", {}, `"${r.message}"`))));
  const catalogSafer = "Inspect or preserve the output for human reconciliation.";
  const forge = el("p", { class: "forge-result", id: "forge-result" });
  if (p.forge) {
    forge.append(mark(p.forge.rejected ? "stop" : "hold"), " ", p.forge.text);
    forge.dataset.state = p.forge.rejected ? "rejected" : "unexpected";
  } else forge.hidden = true;
  const status = el("p", { class: "record-status", id: "record-status" }, p.status ?? "");
  status.hidden = !p.status;
  return el("article", { class: "decision-record", "aria-labelledby": "decision-title" },
    el("h3", { id: "decision-title", tabindex: "-1" }, "Decision record"),
    el("p", { class: "record-summary" }, stateWord("stop", "Refused."), " Nothing ran."),
    el("p", { class: "record-note" }, "This is a policy decision, not an execution receipt."),
    el("dl", { class: "record-rows" },
      dirRow("Rule", data(d.reasons[0]?.policyRuleId ?? v.rule?.id ?? "")),
      dirRow("In plain words", "Deleting unpublished output is in the catalog but marked as never runnable, and it has no allowed environment."),
      dirRow("Reasons", reasons),
      dirRow("Approval", "Cannot override a refusal"),
      dirRow("Adapter", "None. No adapter can run this."),
      dirRow("Safer option, from the action catalog", `"${catalogSafer}"`),
      dirRow("Decision", data(d.id)),
      dirRow("Digest", data(d.decisionDigest))),
    el("div", { class: "record-actions" },
      el("button", { class: "btn btn-secondary", type: "button", "data-record": "check" }, "Check the digest"),
      el("button", { class: "btn btn-secondary", type: "button", "data-record": "forge" }, "Forge an \"allowed\" decision"),
      el("button", { class: "btn btn-secondary", type: "button", "data-record": "save" }, "Save decision record (JSON)")),
    forge,
    status);
}

// ---- Request disclosure ----
function renderRequest() {
  const v = view(selected);
  const { request, decision } = v;
  const sha = runtime.sha256;
  const verdict = (ok) => el("span", { class: `word ${ok ? "ok" : "stop"}` }, ok ? "matches" : "does not match");
  const diagOk = sha(diagnostic) === request.evidence.diagnosticHash;
  const policyOk = sha(PUBLIC_POLICY()) === decision.policy?.manifestDigest;
  const actionOk = sha(request) === decision.actionDigest;
  const decisionOk = sha(omit(decision, "decisionDigest")) === decision.decisionDigest;
  const env = words(request.target.environment).toLowerCase();
  const recId = request.evidence.recordIds?.[0] ?? request.action.recordId;
  const rec = diagnostic.records.find((r) => r.id === recId);
  const obs = diagnostic.scenario.receipts.find((r) => r.recordId === recId);
  const pre = JSON.stringify({ request, decision }, null, 2);
  const preNode = el("pre", {}, el("code", {}));
  preNode.firstChild.textContent = pre;
  clear($("request-body")).append(
    el("dl", { class: "request-rows" },
      dirRow("Request", data(request.id)),
      dirRow("Proposed by", data(request.proposer?.id ?? ""), request.proposer?.kind === "agent" ? " (an agent)" : ` (${words(request.proposer?.kind)})`),
      dirRow("What it asked", `"${request.intent}"`),
      dirRow("Target", data(request.target.resourceId), `, ${env}${selected === "delete_preserved_output" ? " (not permitted for this action)" : ""}`),
      dirRow("Target state", short(request.expectedState?.contentHash), selected === "delete_preserved_output" ? ", as proposed. It is never rechecked, because this action never runs." : ", rechecked right before it runs"),
      dirRow("Evidence", data(recId), obs ? `, observed ${v.t(obs.observedAt)}` : "", rec ? `, valid until ${v.t(rec.validUntil)}` : ""),
      dirRow("Built from", "Diagnostic ", short(request.evidence.diagnosticHash), ". Recomputed in your browser: ", verdict(diagOk), "."),
      dirRow("Policy", data(`${decision.policy?.id} ${decision.policy?.version}`), ", rule ", data(decision.reasons[0]?.policyRuleId ?? ""), ", class ", data(decision.classification)),
      dirRow("Policy digest", short(decision.policy?.manifestDigest), ". Recomputed from the published policy: ", verdict(policyOk), "."),
      dirRow("Action digest", short(decision.actionDigest), ". Recomputed from the request: ", verdict(actionOk), "."),
      dirRow("Decision digest", short(decision.decisionDigest), ". Recomputed: ", verdict(decisionOk), "."),
      dirRow("Decided", v.on(decision.decisionAt))),
    el("details", { class: "json" }, el("summary", {}, "Show the request and decision as JSON"), preNode));
}

// ---- Rules table ----
function renderRules() {
  const policy = PUBLIC_POLICY();
  const ACTION_WORDS = { inspect_run_receipt: "Read a run record", retry_failed_lane: "Retry a failed job", delete_preserved_output: "Delete unpublished output" };
  const rows = policy.rules.map((r) => {
    const approval = r.adapterId === null ? "Never runs. No approval can override it."
      : r.approvalRequired ? `Needs exact approval, valid for ${durationWords(r.maxApprovalLifetimeSeconds ?? 0)}`
      : "Runs without approval";
    const where = r.adapterId === null || r.allowedEnvironment === null ? "Nowhere. No adapter."
      : r.allowedEnvironment === "read_only" ? "Read only"
      : `${words(r.allowedEnvironment)}${r.reversible ? ", reversible" : ""}`;
    return el("tr", {},
      el("td", { "data-label": "Rule" }, el("code", {}, r.id)),
      el("td", { "data-label": "Action" }, ACTION_WORDS[r.actionType] ?? words(r.actionType)),
      el("td", { "data-label": "Approval" }, approval),
      el("td", { "data-label": "Where it can run" }, where));
  });
  const table = el("table", { class: "stack rules-table" },
    el("thead", {}, el("tr", {}, ...["Rule", "Action", "Approval", "Where it can run"].map((h) => el("th", { scope: "col" }, h)))),
    el("tbody", {}, ...rows));
  const foot = el("p", { class: "small foot" }, "Policy ", el("code", {}, policy.id), `, version ${policy.version}. Evidence older than ${span(policy.maxEvidenceAgeSeconds * 1000)} is refused.`);
  const slot = document.querySelector('[data-slot="rules"]');
  slot.querySelector("#rules-reserve")?.remove();
  slot.querySelector(".rules-table")?.remove();
  slot.querySelector(".rules-foot")?.remove();
  foot.classList.add("rules-foot");
  slot.append(table, foot);
}

// ---- Render ----
function render() {
  renderPathRows();
  placeSelection();
  renderDetail();
  renderTrace();
  renderRecord();
  renderRequest();
}
function renderAll() {
  renderHeader();
  render();
}

// ---- Actions ----
function select(actionType, { updateHash = true } = {}) {
  if (!demos.length || !PATH_IDS[actionType]) return;
  selected = actionType;
  if (updateHash && location.hash !== HASH_FOR[actionType]) history.replaceState(null, "", HASH_FOR[actionType]);
  render();
}

function focusRecord(id) {
  const h = $(id);
  if (!h) return;
  h.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "start" });
  h.focus({ preventScroll: true });
}

function reveal(actionType, onDone) {
  const p = paths[actionType];
  const step = (n) => () => {
    if (paths[actionType] !== p) return;   // state was reset meanwhile
    p.revealed = n;
    if (selected === actionType) { renderTrace(); renderRecord(); renderDetail(); }
    if (n === 2) onDone?.();
  };
  if (BEAT_MS === 0) { step(1)(); step(2)(); return; }
  later(step(1), BEAT_MS);
  later(step(2), BEAT_MS * 2);
}

function runRead() {
  const v = view("inspect_run_receipt");
  const p = paths.inspect_run_receipt;
  if (!p.receipt) {
    p.receipt = runtime.buildSyntheticBrowserReceipt(v.item, "read");
    p.revealed = 0; p.tamper = false; p.slipStatus = ""; p.again = "";
    render();
    reveal("inspect_run_receipt", () => {
      if (selected === "inspect_run_receipt") focusRecord("slip-title");
      announce("Read done. Receipt written.");
    });
    return;
  }
  const again = runtime.buildSyntheticBrowserReceipt(v.item, "read");
  p.again = again.id === p.receipt.id && again.receiptDigest === p.receipt.receiptDigest
    ? "Same request, same receipt. A read is safe to repeat."
    : "Unexpected: the rebuilt receipt differs.";
  renderDetail();
  announce(p.again);
}

function openApproval(opener) {
  const dialog = $("approval-dialog");
  const v = view("retry_failed_lane");
  const r = v.laneReceipt;
  const lifetime = v.rule?.maxApprovalLifetimeSeconds ?? 0;
  const until = new Date(Date.parse(v.decision.decisionAt) + lifetime * 1000).toISOString();
  const age = r ? Date.parse(v.request.proposedAt) - Date.parse(r.observedAt) : 0;
  clear($("approval-facts")).append(
    dirRow("What", `Retry ${v.label} once, in the synthetic sandbox`),
    dirRow("Because", r ? `${v.label} ${outcomeVerb(r.outcome)} at ${v.t(r.observedAt)}, ${span(age)} before this request` : `${v.label} has no run receipt`),
    dirRow("Effect", "Creates one synthetic retry record"),
    dirRow("Before it runs", "The target state is rechecked. It must still be ", short(v.request.expectedState?.contentHash), "."),
    dirRow("Valid for", `${durationWords(lifetime)} after you approve: until ${v.on(until)}`),
    dirRow("Use", "Once. It cannot be reused."),
    dirRow("If it fails halfway", "The sandbox is restored to its exact earlier state."),
    dirRow("Bound to",
      el("span", { class: "bound" },
        el("span", {}, "request ", short(v.request.id.replace(/^request-/, ""))),
        el("span", {}, "action ", short(v.decision.actionDigest)),
        el("span", {}, "decision ", short(v.decision.decisionDigest)))));
  approvedByClick = false;
  dialog.returnValue = "";
  dialogOpener = opener ?? null;
  dialog.showModal();
  $("approve-cancel").focus();
}

function onApproved() {
  const v = view("retry_failed_lane");
  const p = paths.retry_failed_lane;
  p.phase = "approved";
  p.receipt = runtime.buildSyntheticBrowserReceipt(v.item, "retry");
  p.revealed = 0; p.tamper = false; p.slipStatus = ""; p.reuse = "";
  render();
  reveal("retry_failed_lane", () => {
    if (selected === "retry_failed_lane") focusRecord("slip-title");
    announce("Approved. One synthetic retry record created. Receipt written.");
  });
}

function onDeclined() {
  const p = paths.retry_failed_lane;
  if (p.phase !== "approved") p.phase = "declined";
  render();
  if (dialogOpener && document.contains(dialogOpener)) dialogOpener.focus();
  else $("path-action").focus();
  announce("Not approved. Nothing ran.");
}

function tryReuse() {
  const v = view("retry_failed_lane");
  const p = paths.retry_failed_lane;
  if (!p.receipt) return;
  const again = runtime.buildSyntheticBrowserReceipt(v.item, "retry");
  const same = again.id === p.receipt.id && again.receiptDigest === p.receipt.receiptDigest;
  p.reuse = same
    ? "Not offered again. This page treats your approval as spent: rebuilding the receipt returned the same id and digest, so nothing new was recorded. Simulated in this page. The real approval store enforces single use and expiry, tested in CI as APPROVAL_REPLAY and EXPIRED_APPROVAL_REUSE."
    : "Unexpected: the rebuilt receipt differs from the one already recorded. Nothing new was recorded.";
  renderDetail();
  announce(p.reuse);
}

function download(object, name) {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(object, null, 2)}\n`], { type: "application/json" }));
  const link = el("a", { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function slipAction(kind) {
  const p = paths[selected];
  if (!p?.receipt) return;
  const r = p.receipt;
  if (kind === "check") {
    const ok = runtime.sha256(omit(r, "receiptDigest")) === r.receiptDigest;
    p.slipStatus = ok ? "Matches. Recomputed in your browser from the receipt's other fields." : "Does not match. The receipt's digest differs from its other fields.";
  } else if (kind === "tamper") {
    p.tamper = !p.tamper;
    if (p.tamper) {
      const edited = structuredClone(omit(r, "receiptDigest"));
      edited.result = "failed";
      const digest = runtime.sha256(edited);
      p.slipStatus = digest === r.receiptDigest
        ? "Unexpected: the edited copy has the same digest."
        : `Changed a copy: result now says failed. Recomputed digest ${shortHash(digest)} does not match. The edit is detected.`;
    } else {
      const ok = runtime.sha256(omit(r, "receiptDigest")) === r.receiptDigest;
      p.slipStatus = ok ? "Change undone. The digest matches again." : "Change undone, but the digest does not match.";
    }
  } else if (kind === "save") {
    download(r, `${selected}-synthetic-receipt.json`);
    if (!p.tamper) return;
    p.slipStatus = "Saved the original, unedited receipt.";
  }
  renderRecord();
  const btn = document.querySelector(`#record-area [data-slip="${kind}"]`);
  btn?.focus();
  announce(p.slipStatus);
}

function recordAction(kind) {
  const v = view("delete_preserved_output");
  const d = v.decision;
  const p = paths.delete_preserved_output;
  if (kind === "check") {
    const ok = runtime.sha256(omit(d, "decisionDigest")) === d.decisionDigest;
    p.status = ok ? "Matches. Recomputed in your browser from the decision's other fields." : "Does not match. The decision's digest differs from its other fields.";
    renderRecord();
    document.querySelector('#record-area [data-record="check"]')?.focus();
    announce(p.status);
  } else if (kind === "forge") {
    const forged = { ...d, disposition: "allow", classification: "green" };
    forged.decisionDigest = runtime.sha256(omit(forged, "decisionDigest"));
    let r;
    try {
      r = runtime.recomputeImportedDecision({ diagnostic, request: v.request, decision: forged }, PUBLIC_POLICY(), clockFor(diagnostic));
    } catch (error) {
      p.forge = { rejected: false, text: `Unexpected: the check could not run. ${String(error?.message ?? error)}` };
    }
    if (r) {
      const rejected = r.importedDecisionAccepted === false && r.decision?.disposition === "refuse";
      p.forge = rejected
        ? { rejected: true, text: "Forged decision rejected. Its digest does not match what policy computes from this request. Recomputed: refused." }
        : { rejected: false, text: `Unexpected: the forged decision was ${r.importedDecisionAccepted ? "accepted" : "rejected"}, and policy recomputed ${words(r.decision?.disposition).toLowerCase()}.` };
    }
    renderRecord();
    document.querySelector('#record-area [data-record="forge"]')?.focus();
    announce(p.forge.text);
  } else if (kind === "save") {
    download(d, "delete_preserved_output-decision-record.json");
  }
}

// ---- Check a file ----
function showFileError(reason, mono) {
  const e = clear($("file-error"));
  if (reason === null) {
    e.append("This file was not loaded. It is not a Context Layer diagnostic, a proof file, or a receipt from this lab.");
  } else {
    e.append(`This file was not loaded. The page still shows ${mode === "file" ? fileName : "the public sample"}. Reason: `);
    e.append(mono ? el("span", { class: "data" }, reason) : reason);
  }
  e.hidden = false;
}

function swapTo(candidate, name, statusText) {
  const nextDemos = runtime.buildPublicDemo(candidate, PUBLIC_POLICY(), clockFor(candidate));
  // Only now, after every path was rebuilt from the candidate, does any state change.
  clearTimers();
  diagnostic = candidate;
  demos = nextDemos;
  paths = freshPaths();
  mode = "file";
  fileName = name;
  $("back-to-sample").hidden = false;
  renderAll();
  $("file-status").textContent = statusText;
  announce(statusText);
  const demo = $("demo");
  demo.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "start" });
  demo.focus({ preventScroll: true });
}

async function checkFile(file) {
  const input = $("file-input");
  $("file-error").hidden = true;
  const name = file.name;
  let text;
  try { text = await file.text(); } catch { input.value = ""; showFileError("this file could not be read.", false); return; }
  input.value = "";
  let parsed;
  try { parsed = JSON.parse(text); } catch { showFileError("this file is not JSON.", false); return; }
  const sha = runtime.sha256;
  const verdict = (ok) => (ok ? "matches" : "does not match");
  try {
    if (parsed && typeof parsed === "object" && typeof parsed.format === "string" && parsed.format.startsWith("context-layer-diagnostic/")) {
      swapTo(structuredClone(parsed), name, `Loaded ${name}. All three paths were recomputed from it. Decisions inside the file were ignored.`);
      return;
    }
    if (parsed?.schemaVersion === "governed-action-proof/v2") {
      const packetOk = sha(omit(parsed, "packetDigest")) === parsed.packetDigest;
      const receiptOk = !!parsed.receipt && sha(omit(parsed.receipt, "receiptDigest")) === parsed.receipt.receiptDigest;
      const reviewOk = !!parsed.review && sha(omit(parsed.review, "reviewDigest")) === parsed.review.reviewDigest;
      const r = runtime.recomputeImportedDecision({ diagnostic: parsed.diagnostic, request: parsed.review?.request, decision: parsed.review?.decision }, PUBLIC_POLICY(), clockFor(parsed.diagnostic));
      const status = `Proof file ${name}: packet digest ${shortHash(parsed.packetDigest)} ${verdict(packetOk)}. Receipt digest ${verdict(receiptOk)}. Review digest ${verdict(reviewOk)}. Embedded decision recomputed: ${r.importedDecisionAccepted ? "accepted" : "not accepted"}. The three paths now use its diagnostic.`;
      swapTo(structuredClone(parsed.diagnostic), name, status);
      return;
    }
    if (parsed?.schemaVersion === "governed-action-receipt/v2") {
      const ok = typeof parsed.receiptDigest === "string" && sha(omit(parsed, "receiptDigest")) === parsed.receiptDigest;
      const status = `Receipt ${name}: digest ${verdict(ok)}. This page checks the digest only. For the full schema check run npm run action -- verify-receipt.`;
      $("file-status").textContent = status;
      announce(status);
      return;
    }
  } catch (error) {
    showFileError(String(error?.message ?? error), true);
    return;
  }
  showFileError(null, false);
}

function backToSample() {
  let nextDemos;
  const candidate = structuredClone(sample.SAMPLE_DIAGNOSTIC);
  try { nextDemos = runtime.buildPublicDemo(candidate, PUBLIC_POLICY(), clockFor(candidate)); } catch (error) { bootFailed(error); return; }
  clearTimers();
  diagnostic = candidate;
  demos = nextDemos;
  paths = freshPaths();
  mode = "sample";
  fileName = "";
  $("back-to-sample").hidden = true;
  $("file-error").hidden = true;
  $("file-status").textContent = "Showing the public sample.";
  renderAll();
  announce("Back to the public sample.");
}

// ---- Boot ----
function bootFailed(error) {
  clearTimers();
  demos = [];
  document.documentElement.dataset.boot = "failed";
  const s = clear($("boot-status"));
  s.hidden = false;
  s.setAttribute("role", "alert");
  s.classList.add("boot-failed");
  s.append("The policy engine did not load, so nothing here can run. Reload to try again.");
  if (error) s.append(" ", el("span", { class: "data" }, `Reason: ${String(error?.message ?? error)}`));
  for (const row of document.querySelectorAll(".path")) {
    clear(row.querySelector(".path-outcome")).append(mark("pending"), word("", "Not checked"));
  }
  $("detail-text").textContent = "The policy engine did not load, so nothing here can run. Reload to try again.";
  $("path-action").hidden = true;
  setStep("proposed", "pending", "Not computed.");
  setStep("policy", "stop", "Policy could not load. Nothing ran.");
  setStep("approval", "pending", "Not yet.");
  setStep("runs", "pending", "Not yet.");
  setStep("record", "pending", "Not yet.");
  clear($("record-area")).append(el("p", { class: "small" }, "No records. Nothing was computed."));
  clear($("request-body")).append(el("p", { class: "small" }, "Not available: the policy engine did not load."));
  const rules = document.querySelector('[data-slot="rules"]');
  if (rules) clear(rules).append(el("p", { class: "small" }, "Not available: the policy engine did not load."));
  $("load-file").hidden = true;
  announce("The policy engine did not load.");
}

function wire() {
  for (const [actionType, id] of Object.entries(PATH_IDS)) {
    $(id).addEventListener("change", () => { if ($(id).checked) select(actionType); });
  }
  $("path-action").addEventListener("click", (event) => {
    if (!demos.length || $("path-action").getAttribute("aria-disabled") === "true") return;
    if (selected === "inspect_run_receipt") runRead();
    else if (selected === "retry_failed_lane") {
      if (paths.retry_failed_lane.phase === "approved") tryReuse();
      else openApproval(event.currentTarget);
    } else focusRecord("decision-title");
  });
  const dialog = $("approval-dialog");
  $("approve-confirm").addEventListener("click", (event) => {
    event.preventDefault();
    approvedByClick = true;
    dialog.close();
    onApproved();
  });
  // Cancel, Escape and any other close are a decline. Only the confirm click approves.
  dialog.addEventListener("close", () => {
    if (approvedByClick) { approvedByClick = false; dialog.returnValue = ""; return; }
    dialog.returnValue = "";
    onDeclined();
  });
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  $("record-area").addEventListener("click", (event) => {
    const s = event.target.closest("[data-slip]");
    if (s) { slipAction(s.dataset.slip); return; }
    const r = event.target.closest("[data-record]");
    if (r) recordAction(r.dataset.record);
  });
  $("load-file").addEventListener("click", () => { if (demos.length) $("file-input").click(); });
  $("file-input").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (file) checkFile(file);
  });
  $("back-to-sample").addEventListener("click", backToSample);
  addEventListener("hashchange", () => {
    const next = PATH_FOR_HASH[location.hash];
    if (next && next !== selected) select(next, { updateHash: false });
  });
}

async function boot() {
  try {
    runtime = await import("./runtime.js");
    sample = await import("./sample-data.js");
    diagnostic = structuredClone(sample.SAMPLE_DIAGNOSTIC);
    demos = runtime.buildPublicDemo(diagnostic, sample.PUBLIC_POLICY, clockFor(diagnostic));
    if (demos.length !== 3) throw new Error("The policy engine returned an unexpected set of paths.");
  } catch (error) {
    if (!booted) bootFailed(error);
    return;
  }
  booted = true;
  selected = PATH_FOR_HASH[location.hash] ?? "retry_failed_lane";
  wire();
  renderAll();
  renderRules();
  $("boot-status").hidden = true;
  document.documentElement.dataset.boot = "ready";
  // Nothing animates on load: transitions apply only after the first render.
  requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.add("animate")));
}

boot();
