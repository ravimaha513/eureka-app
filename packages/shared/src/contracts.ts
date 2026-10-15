/**
 * Contracts (interview-alerts package, migration 0086): the commercial record
 * of a closure, filed on the placement. The MSA, PO and SOW themselves are
 * placement documents of the matching type (documents.ts); the contract row
 * carries the facts Accounts invoices from.
 */
export const CONTRACT_KINDS = ["msa", "po", "sow", "other"] as const;
export type ContractKind = (typeof CONTRACT_KINDS)[number];
export const CONTRACT_KIND_LABELS: Record<ContractKind, string> = {
  msa: "Master services agreement", po: "Purchase order", sow: "Statement of work", other: "Other contract",
};
/** Document types that belong to a contract (uploaded on the placement). */
export const CONTRACT_DOCUMENT_TYPES = ["msa", "purchase_order", "sow"] as const;
export const CONTRACT_TITLE_MAX = 120;
export const CONTRACT_REFERENCE_MAX = 80;
export const CONTRACT_NOTES_MAX = 2000;
