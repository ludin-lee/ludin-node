import { useState } from 'preact/hooks';
import { api, ApiError, type Me } from './api';
import { boot } from './config';
import { Brand } from './Brand';
import { t } from './i18n';

export function Login({ onLogin }: { onLogin: (me: Me) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const theme = boot.theme ?? {};

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin(await api.login(email, password));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('loginFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="login-wrap">
      <form class="login" onSubmit={submit}>
        <Brand />
        <h1>{theme.loginHeadline || t('signInHeadline')}</h1>
        <p>{theme.loginDescription || t('signInDescription')}</p>
        <div class="field">
          <label for="email">{t('email')}</label>
          <input id="email" type="email" autocomplete="username" required value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} />
        </div>
        <div class="field">
          <label for="pw">{t('password')}</label>
          <input id="pw" type="password" autocomplete="current-password" required value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} />
        </div>
        {error && <div class="err-text">{error}</div>}
        <button class="btn btn-primary" disabled={busy}>
          {busy ? <span class="spin" style="border-top-color:#fff" /> : t('signIn')}
        </button>
        <div class="foot">Protected by ludin</div>
      </form>
    </div>
  );
}
