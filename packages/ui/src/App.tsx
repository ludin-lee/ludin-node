import { useEffect, useState } from 'preact/hooks';
import { api, ApiError, type Me } from './api';
import { Login } from './Login';
import { Docs } from './Docs';
import { Brand } from './Brand';
import { onLangChange, t } from './i18n';

export function App() {
  const [me, setMe] = useState<Me | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [, bump] = useState(0);
  useEffect(() => onLangChange(() => bump((x) => x + 1)), []);

  const refresh = () =>
    api
      .me()
      .then(setMe)
      .catch((e: ApiError) => setError(e.message));

  useEffect(() => {
    refresh();
  }, []);

  if (error)
    return (
      <div class="login-wrap">
        <div class="login">
          <Brand />
          <h1>{t('unavailable')}</h1>
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
