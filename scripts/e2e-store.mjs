// Browser test for store mode: boots the express example against a throwaway
// SQLite file, then drives invite → accept → audit through the real UI.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.PORT ?? 3010);
const base = `http://localhost:${PORT}/docs`;
const dir = mkdtempSync(join(tmpdir(), 'ludin-e2e-'));
const db = join(dir, 'ludin.db');
mkdirSync('shots', { recursive: true });

const server = spawn('pnpm', ['--filter', 'example-express', 'dev'], {
  env: { ...process.env, LUDIN_DB: db, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
  // Own process group so cleanup takes the tsx child down with pnpm.
  detached: true,
});
server.stdout.on('data', (b) => process.env.VERBOSE && process.stdout.write(b));
server.stderr.on('data', (b) => process.stderr.write(b));

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${base}/api/me`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('example server did not start');
}

function cleanup() {
  try {
    process.kill(-server.pid, 'SIGKILL');
  } catch {
    server.kill('SIGKILL');
  }
  rmSync(dir, { recursive: true, force: true });
}
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

const errors = [];
try {
  await waitForServer();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const ctx = await browser.newContext({ viewport: { width: 1380, height: 860 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('Failed to load resource') && errors.push(m.text()));

  // seeded admin from auth.users
  await page.goto(base);
  await page.fill('#email', 'admin@example.com');
  await page.fill('#pw', 'admin');
  await page.click('button.btn-primary');
  await page.waitForSelector('a[href="#/admin"]');

  // admin screen is editable in store mode
  await page.click('a[href="#/admin"]');
  await page.waitForSelector('table');
  const chip = await page.locator('.op-path .chip').first().innerText();
  if (!chip.includes('store mode')) throw new Error(`expected store mode, got "${chip}"`);
  if (await page.locator('button:has-text("+ Invite")').isDisabled()) throw new Error('invite button should be enabled');

  // add an IP rule and see it listed
  await page.fill('input[placeholder="10.0.0.0/8"]', '203.0.113.0/24');
  await page.fill('input[placeholder="note (optional)"]', 'office');
  await page.click('form.row button:has-text("Add")');
  await page.waitForSelector('td:has-text("203.0.113.0/24")');
  await page.screenshot({ path: 'shots/07-admin-store.png' });

  // invite someone → grab the one-time link
  await page.click('button:has-text("+ Invite")');
  await page.waitForSelector('.modal');
  await page.fill('.modal input[type="email"]', 'invitee@example.com');
  await page.click('.modal button:has-text("Create invitation")');
  await page.waitForSelector('.modal input[readonly]');
  const link = await page.locator('.modal input[readonly]').inputValue();
  if (!link.includes('#/invite/')) throw new Error(`unexpected invite link: ${link}`);
  await page.screenshot({ path: 'shots/08-invite.png' });
  await page.click('.modal button[aria-label="Close"]');
  await page.waitForSelector('td:has-text("invitee@example.com")');

  // a fresh browser context (no cookies) accepts the invitation
  const guestCtx = await browser.newContext({ viewport: { width: 1380, height: 860 } });
  const guest = await guestCtx.newPage();
  guest.on('pageerror', (e) => errors.push(String(e)));
  await guest.goto(link);
  await guest.waitForSelector('#ipw');
  await guest.fill('#iname', 'Invited Dev');
  await guest.fill('#ipw', 'invited-password');
  await guest.fill('#ipw2', 'invited-password');
  await guest.click('button:has-text("Activate account")');
  await guest.waitForSelector('.shell', { timeout: 10000 });
  await guest.waitForSelector('.nav-item');
  const who = await guest.locator('.menu > button').innerText();
  if (!who.includes('Invited Dev')) throw new Error(`invitee not signed in: ${who}`);
  await guestCtx.close();

  // the same link is dead for the next person
  const staleCtx = await browser.newContext();
  const stale = await staleCtx.newPage();
  await stale.goto(link);
  await stale.waitForSelector('text=Invitation unavailable');
  await staleCtx.close();

  // audit log shows the whole trail and filters
  await page.reload();
  await page.click('a[href="#/audit"]');
  await page.waitForSelector('.toolbar');
  await page.waitForSelector('td:has-text("invite.accept")');
  await page.selectOption('.toolbar select', 'login.success');
  await page.click('.toolbar button:has-text("Apply")');
  await page.waitForFunction(() => {
    const cells = [...document.querySelectorAll('tbody tr td:nth-child(2)')];
    return cells.length > 0 && cells.every((c) => c.textContent.trim() === 'login.success');
  });
  await page.screenshot({ path: 'shots/09-audit.png' });

  // sessions can be revoked from the admin screen
  await page.click('a[href="#/admin"]');
  await page.waitForSelector('table');
  await page.click('tr:has-text("invitee@example.com") button:has-text("Sign out")');
  await page.waitForSelector('tr:has-text("invitee@example.com") td:text-is("—")');

  await browser.close();
} finally {
  cleanup();
}

if (errors.length) {
  console.error('Browser errors:', errors);
  process.exit(1);
}
console.log('store-mode e2e OK');
