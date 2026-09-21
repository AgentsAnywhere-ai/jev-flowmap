import { anthropic } from './provider.js';

// Everything here produces prose a person reads.

export async function writeBriefing(findings, goal) {
  return anthropic.messages.create({
    model: 'claude-opus-5',
    max_tokens: 2000,
    messages: [{ role: 'user', content: `Write a briefing on ${goal} from these findings:\n${findings}` }],
  });
}

export async function draftReply(thread) {
  return anthropic.messages.create({
    model: 'claude-opus-5',
    max_tokens: 800,
    messages: [{ role: 'user', content: `Draft a reply to this thread:\n${thread}` }],
  });
}

export async function writePatch(issue, file) {
  return anthropic.messages.create({
    model: 'claude-opus-5',
    max_tokens: 4000,
    messages: [{ role: 'user', content: `Write a patch for ${issue} in:\n${file}` }],
  });
}

export async function summariseFindings(findings) {
  return anthropic.messages.create({
    model: 'claude-opus-5',
    max_tokens: 1200,
    messages: [{ role: 'user', content: `Summarise:\n${findings}` }],
  });
}
