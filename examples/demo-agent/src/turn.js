import { relevanceCheck, timeSensitivity } from './research.js';
import { isDraftReadyForReview, isToolCallSafe, needsHuman } from './review.js';
import { routeTicket, isUrgent } from './routing.js';
import { pickNextWorker, areWeDone, chooseModelTier } from './loop.js';
import { refuseOverBudget, pullInvoiceNumber } from './limits.js';
import { extractInvoiceNumber, extractDueDate } from './extract.js';
import { put } from './store.js';

// One turn. Every decision above ends here as a branch.
export async function runTurn(state, ticket, passages, workers) {
  const queue = ticket ? routeTicket(ticket) : null;
  if (queue) put(`ticket:${ticket.id}:queue`, queue);
  if (ticket && isUrgent(ticket)) {
    state.priority = 'high';
  }

  const budget = refuseOverBudget(state.request);
  if (!budget.allowed) return { stopped: 'over_budget' };

  const invoice = pullInvoiceNumber(state.request.body ?? '');
  if (invoice) put(`invoice:${invoice.full}`, state.request.id);

  if (!invoice && state.request.document) {
    const number = await extractInvoiceNumber(state.request.document);
    if (number) put(`invoice:${number}`, state.request.id);
    const due = await extractDueDate(state.request.document);
    if (due) state.dueDate = due;
  }

  const urgency = await timeSensitivity(state.request);
  if (urgency >= 4) state.deadlineHours = 4;

  const kept = [];
  for (const passage of passages) {
    if (await relevanceCheck(passage, state.goal)) kept.push(passage);
  }
  state.sources = kept;

  const tier = await chooseModelTier(state.goal);
  state.model = tier === 'powerful' ? 'claude-opus-5' : 'claude-haiku-4-5';

  if (await areWeDone(state)) return { done: true, state };

  const worker = await pickNextWorker(state, workers);
  const call = { worker, args: state.request };
  if (!(await isToolCallSafe(call))) return { blocked: 'unsafe_tool_call', call };
  state.actions.push(worker);

  if (state.draft && !(await isDraftReadyForReview(state.draft, state.goal))) {
    return { needsRevision: true, state };
  }
  if (state.draft && (await needsHuman(state.draft))) {
    return { queuedForHuman: true, state };
  }
  return { state };
}
