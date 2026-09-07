import { fileURLToPath } from 'node:url';
import express from 'express';
import { ludin } from '@ludin/express';
import { petstore } from './petstore.js';

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
    // Any HTML file of yours, served next to the reference behind a button.
    readme: { enabled: true, path: fileURLToPath(new URL('../readme.html', import.meta.url)), label: 'Guide' },
    auth: {
      users: [
        { email: 'admin@example.com', password: process.env.LUDIN_ADMIN_PW ?? 'admin', role: 'admin', name: 'Admin' },
        { email: 'dev@example.com', password: process.env.LUDIN_DEV_PW ?? 'dev', role: 'developer', name: 'Dev' },
        { email: 'viewer@example.com', password: process.env.LUDIN_VIEWER_PW ?? 'viewer', role: 'viewer' },
      ],
      session: { secret: process.env.LUDIN_SESSION_SECRET ?? 'dev-only-secret' },
    },
    ipAllowlist: (process.env.LUDIN_IPS ?? '').split(',').filter(Boolean),
    visibility: { 'tag:Admin': ['admin'] },
    theme: {
      title: 'Petstore API',
      // Any URL or data URI works – this one is inline so the demo needs no network.
      logo:
        'data:image/svg+xml;utf8,' +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0f766e"/>' +
            '<path d="M9 21c0-4 3-7 7-7s7 3 7 7" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round"/>' +
            '<circle cx="12" cy="11" r="2.2" fill="#fff"/><circle cx="20" cy="11" r="2.2" fill="#fff"/></svg>',
        ),
      primary: '#0f766e',
      accent: '#f59e0b',
      loginHeadline: 'Petstore developer docs',
      loginDescription: 'Try admin@example.com / admin, dev@example.com / dev, or viewer@example.com / viewer.',
    },
  }),
);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`▶ http://localhost:${port}/docs`));
