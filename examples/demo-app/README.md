# demo-app

A tiny synthetic application, not runnable and not a real product. It exists so
jev-flowmap has something to map that anyone can inspect.

It deliberately contains:

- Four surfaces: a browser UI, an HTTP API, an agent tool and a CLI.
- A guard (`src/session.js`) that both the API and the account screen apply.
- A destructive step (`DELETE /api/account`).
- A dead end: in `src/web/account.js`, an expired session renders a blank page
  with no message, no retry and no way back.
- Two files no user reaches: `src/db.js` and `src/types.js`.

The generated output is in [`../demo-app-output/`](../demo-app-output/).
