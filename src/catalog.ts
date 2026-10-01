import type { CatalogAction } from "./contracts.js";

export type CatalogEntry = {
  type: CatalogAction["type"];
  mutates: boolean;
  executable: boolean;
  projectedEffect: string;
  saferAlternative: string | null;
};

export const ACTION_CATALOG: Record<CatalogAction["type"], CatalogEntry> = {
  inspect_run_receipt: {
    type: "inspect_run_receipt",
    mutates: false,
    executable: true,
    projectedEffect: "Read one bounded synthetic run receipt.",
    saferAlternative: null,
  },
  retry_failed_lane: {
    type: "retry_failed_lane",
    mutates: true,
    executable: true,
    projectedEffect: "Create one synthetic retry record in a temporary sandbox.",
    saferAlternative: null,
  },
  delete_preserved_output: {
    type: "delete_preserved_output",
    mutates: true,
    executable: false,
    projectedEffect: "Delete preserved output.",
    saferAlternative: "Inspect or preserve the output for human reconciliation.",
  },
};
