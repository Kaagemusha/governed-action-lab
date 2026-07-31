import { diagnosticSnapshotSchema, type DiagnosticSnapshot } from "./contracts.js";

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function shiftInstants(value: unknown, deltaMs: number): unknown {
  if (typeof value === "string" && ISO_INSTANT.test(value)) {
    return new Date(new Date(value).getTime() + deltaMs).toISOString();
  }
  if (Array.isArray(value)) return value.map((item) => shiftInstants(item, deltaMs));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, shiftInstants(item, deltaMs)]),
    );
  }
  return value;
}

export function freshenPublicFixture(input: unknown, targetAsOf = new Date()): DiagnosticSnapshot {
  const fixture = diagnosticSnapshotSchema.parse(input);
  if (!Number.isFinite(targetAsOf.getTime())) throw new Error("Target time must be a valid instant.");
  const sourceAsOf = new Date(fixture.scenario.asOf).getTime();
  const shifted = shiftInstants(fixture, targetAsOf.getTime() - sourceAsOf);
  return diagnosticSnapshotSchema.parse(shifted);
}
