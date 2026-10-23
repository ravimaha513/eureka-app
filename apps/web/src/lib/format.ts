/** "offer_letter" → "Offer letter", "i9" → "I9" (document types are snake_case keys). */
export const docTypeLabel = (t: string) => { const s = t.replace(/_/g, " "); return s.charAt(0).toUpperCase() + s.slice(1); };
