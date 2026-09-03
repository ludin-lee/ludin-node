import { useEffect, useState } from 'preact/hooks';
import { api, ApiError, type Me } from './api';
import { Login } from './Login';
import { InviteAccept } from './InviteAccept';
import { Docs } from './Docs';
import { Brand } from './Brand';

function inviteToken(): string | null {
  const m = /^#\/invite\/(.+)$/.exec(location.hash);
  return m ? decodeURIComponent(m[1]) : null;
}

export function App() {
  const [me, setMe] = useState<Me | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<string | null>(inviteToken());

  const refresh = () =>
    api
      .me()
      .then(setMe)
      .catch((e: ApiError) => setError(e.message));

  useEffect(() => {
    refresh();
    const onHash = () => setInvite(inviteToken());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  // The invitation screen is the one place reachable without a session.
  if (invite && (me === undefined || !me.authenticated)) {
    return (
      <InviteAccept
        token={invite}
        onAccepted={(accepted) => {
          setInvite(null);
          setMe(accepted);
        }}
      />
    );
  }

  if (error)
    return (
      <div class="login-wrap">
        <div class="login">
          <Brand />
          <h1>Unavailable</h1>
          <p>{error}</p>
        </div>
      </div>
    );
  if (me === undefined) return <div class="login-wrap"><span class="spin" /></div>;
  if (!me.authenticated) return <Login onLogin={setMe} />;
  return (
    <Docs
      me={me}
      onLogout={async () => {
        await api.logout();
        setMe({ ...me, authenticated: false, user: null, permissions: [] });
      }}
    />
  );
}
