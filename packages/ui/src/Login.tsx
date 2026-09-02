import { useState } from 'preact/hooks';
import { api, ApiError, type Me } from './api';
import { boot } from './config';
import { Brand } from './Brand';

export function Login({ onLogin }: { onLogin: (me: Me) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = boot.theme ?? {};

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin(await api.login(email, password));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="login-wrap">
      <form class="login" onSubmit={submit}>
        <Brand />
        <h1>{t.loginHeadline || 'Sign in to continue'}</h1>
        <p>{t.loginDescription || 'This API documentation is private. Use the account you were given.'}</p>
        <div class="field">
          <label for="email">Email</label>
          <input id="email" type="email" autocomplete="username" required value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} />
        </div>
        <div class="field">
          <label for="pw">Password</label>
          <input id="pw" type="password" autocomplete="current-password" required value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} />
        </div>
        {error && <div class="err-text">{error}</div>}
        <button class="btn btn-primary" disabled={busy}>
          {busy ? <span class="spin" style="border-top-color:#fff" /> : 'Sign in'}
        </button>
        <div class="foot">Protected by rudin</div>
      </form>
    </div>
  );
}
