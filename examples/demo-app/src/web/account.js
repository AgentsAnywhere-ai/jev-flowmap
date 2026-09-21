// Browser screen, reached after signup. Shows the account and offers deletion.
export async function renderAccount(root) {
  const response = await fetch('/api/account');

  // Deliberate dead end for the demo: an expired session renders a blank page
  // with no message, no retry and no way back to sign in.
  if (response.status === 401) {
    root.innerHTML = '';
    return;
  }

  const account = await response.json();
  root.innerHTML = `
    <h1>${account.email}</h1>
    <p>Plan: ${account.plan}</p>
    <button id="delete">Delete my account</button>`;
  root.querySelector('#delete').addEventListener('click', async () => {
    await fetch('/api/account', { method: 'DELETE' });
    location.assign('/');
  });
}
