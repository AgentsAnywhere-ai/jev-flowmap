import { anthropic } from './provider.js';
import { stopAfterTenActions } from './limits.js';

// Decisions the loop makes every turn. Each one ends as a value the code
// branches on, and each one is currently a full generative call.

export async function pickNextWorker(state, workers) {
  const response = await anthropic.messages.create({
    model: 'claude-opus-5',
    max_tokens: 20,
    messages: [{ role: 'user', content: `Goal: ${state.goal}\nSo far: ${state.log}\nWhich worker next? One of: ${workers.join(', ')}` }],
  });
  return response.content[0].text.trim();
}

export async function areWeDone(state) {
  const response = await anthropic.messages.create({
    model: 'claude-opus-5',
    max_tokens: 5,
    messages: [{ role: 'user', content: `Goal: ${state.goal}\nWork log: ${state.log}\nIs the goal met? yes or no.` }],
  });
  return response.content[0].text.trim().toLowerCase().startsWith('y');
}

export async function chooseModelTier(task) {
  const response = await anthropic.messages.create({
    model: 'claude-opus-5',
    max_tokens: 10,
    messages: [{ role: 'user', content: `Does this task need the powerful model or the fast one?\n${task}` }],
  });
  return response.content[0].text.includes('powerful') ? 'powerful' : 'fast';
}

export async function run(state, workers) {
  while (!stopAfterTenActions(state)) {
    if (await areWeDone(state)) break;
    const worker = await pickNextWorker(state, workers);
    state.actions.push(worker);
  }
  return state;
}
