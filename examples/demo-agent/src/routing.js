// Judgment written as a keyword list. Nobody calls this an AI operation, which
// is exactly why it never gets audited.

const URGENT_KEYWORDS = ['asap', 'urgent', 'immediately', 'critical', 'outage', 'down', 'blocked', 'losing'];
const BILLING_TERMS = ['invoice', 'charge', 'refund', 'payment', 'card', 'subscription'];

export function routeTicket(ticket) {
  const text = ticket.body.toLowerCase();
  if (BILLING_TERMS.some((term) => text.includes(term))) return 'billing';
  if (text.includes('error') || text.includes('crash') || text.includes('500') || text.includes('timeout')) return 'technical';
  return 'general';
}

export function isUrgent(ticket) {
  const text = `${ticket.subject} ${ticket.body}`.toLowerCase();
  return URGENT_KEYWORDS.some((word) => text.includes(word));
}
