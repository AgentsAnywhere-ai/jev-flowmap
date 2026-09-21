// Agent tool surface. An assistant discovers these through tools/list before
// calling them, which is what separates this from the HTTP API above.
import { routes } from './server.js';

export const tools = [
  {
    name: 'demo_create_account',
    description: 'Create a demo account from an email address.',
    inputSchema: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] },
    handler: (input) => routes['POST /api/signup'](new Request('http://demo/api/signup', { method: 'POST', body: JSON.stringify(input) })),
  },
];

export const listTools = () => tools.map(({ handler, ...rest }) => rest);
