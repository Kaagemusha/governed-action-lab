import { buildPublicDemo, sha256 } from "./runtime.js";
import { PUBLIC_POLICY, SAMPLE_DIAGNOSTIC } from "./sample-data.js";

const elements = Object.fromEntries(
  [
    "packet-file","open-packet","reset-sample","source-mode","source-message",
    "action-title","verdict-badge","evidence-title","evidence-state","target-id",
    "target-hash","verdict-title","verdict-reason","policy-rule","adapter-id",
    "environment","approval-boundary","receipt-panel","receipt-result","effect-detail",
    "verification-detail","rollback-detail","run-action","export-receipt",
    "approval-dialog","approval-target","approval-evidence","approval-expiry","confirm-approval",
    "review-status","review-authority","review-next",
  ].map((id) => [id, document.getElementById(id)]),
);
const actionLabels = {
  inspect_run_receipt: "Inspect the failed run receipt",
  retry_failed_lane: "Retry the failed lane in the sandbox",
  delete_preserved_output: "Delete the preserved local output",
};
let diagnostic = structuredClone(SAMPLE_DIAGNOSTIC);
let demos = [];
let selectedType = "inspect_run_receipt";
let receipt = null;

function clockFor(packet) {
  return { now: () => new Date(packet.scenario.asOf) };
}
function rebuild() {
  demos = buildPublicDemo(diagnostic, PUBLIC_POLICY, clockFor(diagnostic));
  receipt = null;
  render();
}
function selected() {
  return demos.find((item) => item.actionType === selectedType);
}
function recordFor(item) {
  return diagnostic.records.find((record) => record.id === item.request.action.recordId);
}
function shortHash(value) {
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}
function makeReceipt(item, kind) {
  const before = item.request.expectedState.contentHash;
  const after = kind === "read" ? before : sha256({
    laneId: item.request.action.laneId,
    evidenceRecordId: item.request.action.recordId,
    synthetic: true,
  });
  const result = {
    schemaVersion: "governed-action-receipt/v1",
    requestId: item.request.id,
    actionDigest: item.decision.actionDigest,
    decisionDigest: item.decision.decisionDigest,
    approvalId: kind === "retry" ? `browser-approval-${item.request.id}` : null,
    adapter: { id: "synthetic-automation", version: "browser-demo/1" },
    result: "succeeded",
    effects: [{
      kind: kind === "read" ? "read" : "create_retry_record",
      resourceId: item.request.target.resourceId,
      beforeHash: before,
      afterHash: after,
    }],
    verification: {
      passed: true,
      detail: kind === "read"
        ? "Read effect preserved the target hash."
        : "Synthetic retry record matches lane, evidence, and content hash.",
    },
    compensation: {
      supported: kind === "retry",
      authorized: kind === "retry",
      attempted: false,
      result: "not_needed",
    },
    note: "Browser-only synthetic demonstration; no external system was changed.",
  };
  return { ...result, receiptDigest: sha256(result) };
}
function renderReceipt() {
  elements["receipt-panel"].hidden = !receipt;
  elements["export-receipt"].disabled = !receipt;
  if (!receipt) return;
  const effect = receipt.effects[0];
  elements["receipt-result"].textContent = "Succeeded in synthetic sandbox";
  elements["effect-detail"].textContent = `${effect.kind} · ${shortHash(effect.beforeHash)} → ${shortHash(effect.afterHash)}`;
  elements["verification-detail"].textContent = receipt.verification.detail;
  elements["rollback-detail"].textContent = receipt.compensation.supported
    ? "Exact snapshot restoration pre-authorized for failure; not needed."
    : "Not applicable to a read-only effect.";
}
function render() {
  const item = selected();
  const decision = item.decision;
  const evidence = recordFor(item);
  document.querySelectorAll(".action-choice").forEach((button) => {
    button.classList.toggle("active", button.dataset.action === selectedType);
  });
  elements["action-title"].textContent = actionLabels[selectedType];
  elements["verdict-badge"].textContent = `${decision.classification} · ${decision.disposition.replace("_", " ")}`;
  elements["verdict-badge"].className = `verdict-badge ${decision.classification}`;
  elements["evidence-title"].textContent = evidence.title;
  elements["evidence-state"].textContent = `Valid through ${new Date(evidence.validUntil).toLocaleString("en-US", { timeZone: "UTC", timeZoneName: "short" })}`;
  elements["target-id"].textContent = item.request.target.resourceId;
  elements["target-hash"].textContent = `Expected ${shortHash(item.request.expectedState.contentHash)}`;
  elements["verdict-title"].textContent =
    decision.disposition === "allow" ? "Allowed automatically" :
    decision.disposition === "approval_required" ? "Held for human approval" :
    "Refused without override";
  elements["verdict-reason"].textContent = decision.reasons.map((reason) => reason.message).join(" ");
  elements["policy-rule"].textContent = decision.reasons[0].policyRuleId;
  elements["adapter-id"].textContent = decision.classification === "red" ? "None executable" : item.request.target.adapterId;
  elements["environment"].textContent = item.request.target.environment.replaceAll("_", " ");
  const reviewStatus = {
    allow: "READY",
    approval_required: "APPROVAL REQUIRED",
    refuse: "REFUSED",
  }[decision.disposition];
  elements["review-status"].textContent = reviewStatus;
  elements["review-authority"].textContent =
    decision.disposition === "allow" ? "Read-only policy permits the bounded action." :
    decision.disposition === "approval_required" ? "A separate human must approve this exact request." :
    "Policy refusal cannot be overridden by approval.";
  elements["review-next"].textContent =
    decision.disposition === "allow" ? "Recheck current state before the read." :
    decision.disposition === "approval_required" ? "Inspect target, effect, evidence, expiry, and rollback before deciding." :
    "Use the stated safer alternative; do not execute.";
  elements["approval-boundary"].hidden = decision.classification !== "yellow";
  elements["run-action"].textContent =
    selectedType === "inspect_run_receipt" ? "Run read-only inspection" :
    selectedType === "retry_failed_lane" ? "Review exact approval" :
    "Action refused";
  elements["run-action"].disabled = decision.classification === "red";
  renderReceipt();
}
function loadPacket(packet, name) {
  diagnostic = packet?.format ? packet : packet?.diagnostic;
  if (!diagnostic) throw new Error("Packet must contain a context-layer diagnostic.");
  rebuild();
  elements["source-mode"].textContent = "Local packet";
  elements["source-message"].textContent = `${name} recomputed locally; embedded decisions were ignored.`;
}

document.querySelectorAll(".action-choice").forEach((button) => {
  button.addEventListener("click", () => {
    selectedType = button.dataset.action;
    receipt = null;
    render();
  });
});
elements["run-action"].addEventListener("click", () => {
  const item = selected();
  if (selectedType === "inspect_run_receipt") {
    receipt = makeReceipt(item, "read");
    renderReceipt();
  } else if (selectedType === "retry_failed_lane") {
    elements["approval-target"].textContent = item.request.target.resourceId;
    elements["approval-evidence"].textContent = item.request.evidence.recordIds.join(", ");
    elements["approval-expiry"].textContent = new Date(new Date(diagnostic.scenario.asOf).getTime() + 300000).toISOString();
    elements["approval-dialog"].showModal();
  }
});
elements["approval-dialog"].addEventListener("close", () => {
  if (elements["approval-dialog"].returnValue === "approve") {
    receipt = makeReceipt(selected(), "retry");
    renderReceipt();
  }
});
elements["open-packet"].addEventListener("click", () => elements["packet-file"].click());
elements["packet-file"].addEventListener("change", async () => {
  const file = elements["packet-file"].files[0];
  if (!file) return;
  try {
    loadPacket(JSON.parse(await file.text()), file.name);
  } catch (error) {
    elements["source-message"].textContent = error instanceof Error ? error.message : "Invalid packet.";
  }
  elements["packet-file"].value = "";
});
elements["reset-sample"].addEventListener("click", () => {
  diagnostic = structuredClone(SAMPLE_DIAGNOSTIC);
  elements["source-mode"].textContent = "Synthetic sample";
  elements["source-message"].textContent = "No content leaves this browser.";
  rebuild();
});
elements["export-receipt"].addEventListener("click", () => {
  if (!receipt) return;
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(receipt, null, 2)}\n`], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${selectedType}-receipt.json`;
  link.click();
  URL.revokeObjectURL(url);
});

rebuild();
