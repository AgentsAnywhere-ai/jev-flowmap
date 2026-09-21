import { anthropic } from './provider.js';

// The expensive one. Twelve passages a turn, forty turns a day, all of it
// asking a frontier model for a boolean and throwing the sentence away.
export async function relevanceCheck(passage, goal) {
  const response = await anthropic.messages.create({
    model: 'claude-opus-5',
    max_tokens: 5,
    messages: [{ role: 'user', content: `Is this passage relevant to the goal "${goal}"? Answer yes or no.\n\n${passage}` }],
  });
  const answer = response.content[0].text.trim().toLowerCase();
  return answer.startsWith('y');
}

export async function timeSensitivity(request) {
  const response = await anthropic.messages.create({
    model: 'claude-opus-5',
    max_tokens: 5,
    messages: [{ role: 'user', content: `Rate how time-sensitive this request is, 1 to 5:\n${request}` }],
  });
  return Number(response.content[0].text.trim());
}
