import { anthropic } from './provider.js';

// A frontier model asked to do a regex's job. The answer is exact, the format
// is fixed, and the model is being paid to be occasionally creative about it.
export async function extractInvoiceNumber(document) {
  const response = await anthropic.messages.create({
    model: 'claude-opus-5',
    max_tokens: 30,
    messages: [{ role: 'user', content: `Find the invoice number in this document and return it alone:\n\n${document}` }],
  });
  return response.content[0].text.trim();
}

export async function extractDueDate(document) {
  const response = await anthropic.messages.create({
    model: 'claude-opus-5',
    max_tokens: 30,
    messages: [{ role: 'user', content: `What is the due date in this document? Return it as YYYY-MM-DD.\n\n${document}` }],
  });
  return response.content[0].text.trim();
}
