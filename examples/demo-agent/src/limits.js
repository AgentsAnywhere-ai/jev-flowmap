// Exact rules. Every one of these has a single right answer.
export const MAX_ACTIONS = 10;
export const MAX_SPEND_USD = 500;

export function stopAfterTenActions(state) {
  return state.actions.length >= MAX_ACTIONS;
}

export function refuseOverBudget(request) {
  if (request.amountUsd > MAX_SPEND_USD) return { allowed: false, reason: 'over_budget' };
  return { allowed: true };
}

const INVOICE = /\bINV-(\d{4})-(\d{6})\b/;

export function pullInvoiceNumber(text) {
  const m = INVOICE.exec(text);
  return m ? { year: m[1], serial: m[2], full: m[0] } : null;
}
