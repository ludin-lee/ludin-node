import express from 'express';
import { ludin } from '@ludin/express';
import { sqliteStore } from '@ludin/store-sqlite';
import { petstore } from './petstore.js';

// Binding mode by default; set LUDIN_DB=./ludin.db to run in store mode, where
// the accounts below become a one-time seed and the admin screen turns editable.
const store = process.env.LUDIN_DB ? sqliteStore(process.env.LUDIN_DB) : undefined;

const app = express();
app.use(express.json());

// --- a tiny API the docs will call ------------------------------------------
const pets = [
  { id: 1, name: 'Mochi', tag: 'cat' },
  { id: 2, name: 'Bori', tag: 'dog' },
];
app.get('/api/pets', (req, res) => res.json(pets.slice(0, Number(req.query.limit) || 100)));
app.post('/api/pets', (req, res) => {
  const pet = { id: pets.length + 1, ...req.body };
  pets.push(pet);
  res.status(201).json(pet);
});
app.get('/api/pets/:id', (req, res) => {
  const pet = pets.find((p) => p.id === Number(req.params.id));
  pet ? res.json(pet) : res.status(404).json({ code: 404, message: 'not found' });
});
app.delete('/api/pets/:id', (req, res) => res.status(204).end());
app.post('/api/admin/reset', (req, res) => res.json({ ok: true }));
app.get('/api/secure/me', (req, res) => {
  if (req.headers.authorization !== 'Bearer letmein') return res.status(401).json({ message: 'bad token' });
  res.json({ user: 'demo', via: req.headers['x-ludin-user'] });
});

// --- docs -------------------------------------------------------------------
app.use(
  '/docs',
  ludin({
    spec: petstore,
    store,
    auth: {
      users: [
        { email: 'admin@example.com', password: process.env.LUDIN_ADMIN_PW ?? 'admin', role: 'admin', name: 'Admin' },
        { email: 'dev@example.com', password: process.env.LUDIN_DEV_PW ?? 'dev', role: 'developer', name: 'Dev' },
        { email: 'viewer@example.com', password: process.env.LUDIN_VIEWER_PW ?? 'viewer', role: 'viewer' },
      ],
      session: { secret: process.env.LUDIN_SESSION_SECRET ?? 'dev-only-secret' },
    },
    ipAllowlist: (process.env.LUDIN_IPS ?? '').split(',').filter(Boolean),
    audit: { retentionDays: 90 },
    visibility: { 'tag:Admin': ['admin'] },
    theme: {
      title: 'Petstore API',
      primary: '#0f766e',
      accent: '#f59e0b',
      loginHeadline: 'Petstore developer docs',
      loginDescription: 'Try admin@example.com / admin, dev@example.com / dev, or viewer@example.com / viewer.',
    },
  }),
);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () =>
  console.log(`▶ http://localhost:${port}/docs  (${store ? `store mode · ${process.env.LUDIN_DB}` : 'binding mode'})`),
);
