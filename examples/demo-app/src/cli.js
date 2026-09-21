#!/usr/bin/env node
// Terminal command. A person or a script runs this.
import { put } from './db.js';

const [command, ...args] = process.argv.slice(2);

if (command === 'invite') {
  const email = args[0];
  if (!email) { console.error('usage: demo invite <email>'); process.exit(1); }
  put(`invite:${email}`, { email, invitedAt: Date.now() });
  console.log(`invited ${email}`);
} else {
  console.error('commands: invite <email>');
  process.exit(1);
}
