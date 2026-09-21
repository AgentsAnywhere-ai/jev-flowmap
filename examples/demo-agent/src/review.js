import { anthropic } from './provider.js';

// One question doing the work of four. When it fails you cannot tell which
// part failed, because a single answer cannot say.
export async function isDraftReadyForReview(draft, goal) {
  const response = await anthropic.messages.create({
    model: 'claude-opus-5',
    max_tokens: 5,
    messages: [{ role: 'user', content: `Is this draft ready for review? It must cover the goal "${goal}", cite its sources, stay under the length cap, and avoid the forbidden claims.\n\n${draft}` }],
  });
  return response.content[0].text.trim().toLowerCase().startsWith('y');
}

export async function isToolCallSafe(call) {
  const response = await anthropic.messages.create({
    model: 'claude-opus-5',
    max_tokens: 5,
    messages: [{ role: 'user', content: `Is this tool call safe to run without asking a person first?\n${JSON.stringify(call)}` }],
  });
  return response.content[0].text.trim().toLowerCase().startsWith('y');
}

export async function needsHuman(result) {
  const response = await anthropic.messages.create({
    model: 'claude-opus-5',
    max_tokens: 5,
    messages: [{ role: 'user', content: `Does this result need a person to look at it before it goes out?\n${result}` }],
  });
  return response.content[0].text.trim().toLowerCase().startsWith('y');
}
