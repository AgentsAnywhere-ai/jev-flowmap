// Browser screen. A person fills this in.
export function renderSignup(root) {
  root.innerHTML = `
    <form id="signup">
      <input name="email" type="email" required />
      <button type="submit">Create account</button>
      <p id="signup-error" hidden></p>
    </form>`;
  root.querySelector('#signup').addEventListener('submit', onSubmit);
}

async function onSubmit(event) {
  event.preventDefault();
  const email = new FormData(event.target).get('email');
  const response = await fetch('/api/signup', { method: 'POST', body: JSON.stringify({ email }) });
  if (!response.ok) {
    const error = document.querySelector('#signup-error');
    error.textContent = 'That email was not accepted. Try another.';
    error.hidden = false;
    return;
  }
  location.assign('/account');
}
