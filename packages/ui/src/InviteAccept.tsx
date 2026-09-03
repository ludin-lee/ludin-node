import { useEffect, useState } from 'preact/hooks';
import { api, ApiError, type Me } from './api';
import { Brand } from './Brand';

/** Shown for `#/invite/<token>` – the only screen reachable without a session. */
export function InviteAccept({ token, onAccepted }: { token: string; onAccepted: (me: Me) => void }) {
  const [invite, setInvite] = useState<{ email: string; role: string; expiresAt: string } | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.inviteInfo(token).then(setInvite).catch((e: ApiError) => setError(e.message));
  }, [token]);

  async function submit(e: Event) {
    e.preventDefault();
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const me = await api.acceptInvite({ token, password, name: name.trim() || undefined });
      location.hash = '';
      onAccepted(me);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not accept the invitation');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="login-wrap">
      <form class="login" onSubmit={submit}>
        <Brand />
        {!invite && !error && <span class="spin" />}
        {error && !invite && (
          <>
            <h1>Invitation unavailable</h1>
            <p>{error}</p>
            <a class="btn" href="#/">
              Go to sign in
            </a>
          </>
        )}
        {invite && (
          <>
            <h1>Set your password</h1>
            <p>
              You were invited as <b>{invite.email}</b> with the <b>{invite.role}</b> role.
            </p>
            <div class="field">
              <label for="iname">Name (optional)</label>
              <input id="iname" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
            </div>
            <div class="field">
              <label for="ipw">Password (min 8 characters)</label>
              <input
                id="ipw"
                type="password"
                autocomplete="new-password"
                required
                minLength={8}
                value={password}
                onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
              />
            </div>
            <div class="field">
              <label for="ipw2">Repeat password</label>
              <input
                id="ipw2"
                type="password"
                autocomplete="new-password"
                required
                value={confirm}
                onInput={(e) => setConfirm((e.target as HTMLInputElement).value)}
              />
            </div>
            {error && <div class="err-text">{error}</div>}
            <button class="btn btn-primary" disabled={busy}>
              {busy ? <span class="spin" style="border-top-color:#fff" /> : 'Activate account'}
            </button>
          </>
        )}
        <div class="foot">Protected by ludin</div>
      </form>
    </div>
  );
}
