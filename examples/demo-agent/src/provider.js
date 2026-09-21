// Client construction only. No decisions are made here.
import Anthropic from '@anthropic-ai/sdk';
export const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
