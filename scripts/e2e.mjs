// Browser smoke test + screenshots for the express example (must be running on :3000).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 1380, height: 860 }, colorScheme: 'light', locale: 'en-US' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && !m.text().includes('Failed to load resource') && errors.push(m.text()));

await page.goto('http://localhost:3000/docs');
await page.waitForSelector('form.login');
await page.screenshot({ path: 'shots/01-login.png' });

// wrong password
await page.fill('#email', 'dev@example.com');
await page.fill('#pw', 'wrong');
await page.click('button.btn-primary');
await page.waitForSelector('.err-text');

// developer login
await page.fill('#pw', 'dev');
await page.click('button.btn-primary');
await page.waitForSelector('.shell');
await page.waitForSelector('.nav-item');
await page.screenshot({ path: 'shots/02-overview.png' });

// the configured readme page, framed and sandboxed
await page.click('a[href="#/readme"]');
await page.waitForSelector('iframe.readme-frame');
const frame = page.frameLocator('iframe.readme-frame');
await frame.locator('h1:has-text("Petstore API")').waitFor({ timeout: 5000 });
await page.screenshot({ path: 'shots/03-readme.png' });
await page.click('a[href="#/"] >> nth=0');
await page.waitForSelector('.nav-item');

if (await page.locator('a.nav-item[href="#/op/resetDb"]').count()) throw new Error('developer should not see Admin tag');
if (await page.locator('a[href="#/admin"]').count()) throw new Error('developer should not see Admin button');

// Export artifacts: generated from the same role-filtered document (spec §3.13),
// so a developer's collection must not name an operation they cannot see.
for (const [what, must] of [['postman', 'List all pets'], ['types.d.ts', 'listPets']]) {
  const res = await page.request.get(`http://localhost:3000/docs/api/export/${what}`);
  if (!res.ok()) throw new Error(`export ${what}: ${res.status()}`);
  const body = await res.text();
  if (!body.includes(must)) throw new Error(`export ${what} is missing ${must}`);
  if (body.includes('resetDb') || body.includes('/admin/reset')) throw new Error(`export ${what} leaks a hidden operation`);
}

// The changes screen, and release notes built from the diff it already holds.
await page.click('a[href="#/changes"]');
await page.waitForSelector('.chg-kind');
await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
await page.click('.op-head .op-path button');
const notes = await page.evaluate(() => navigator.clipboard.readText());
if (!/^### Breaking changes$/m.test(notes)) throw new Error('release notes have no breaking section');
if (!notes.includes('DELETE /pets/{petId}')) throw new Error('release notes lost a change');
await page.screenshot({ path: 'shots/08-changes.png' });
await page.click('a[href="#/"] >> nth=0');
await page.waitForSelector('.nav-item');

// open an operation and try it out
await page.click('a.nav-item[href="#/op/showPetById"] >> nth=0');
await page.waitForSelector('.try');
await page.click('.try .btn-primary');
await page.waitForSelector('.result-h');
const status = await page.locator('.result-h .status-pill').innerText();
if (status !== '200') throw new Error(`expected 200 from try-it-out, got ${status}`);
await page.screenshot({ path: 'shots/04-operation.png' });

// POST with body
await page.click('a.nav-item[href="#/op/createPet"] >> nth=0');
await page.waitForSelector('.try textarea');
await page.click('.try .btn-primary');
await page.waitForSelector('.result-h');
const created = await page.locator('.result-h .status-pill').innerText();
if (created !== '201') throw new Error(`expected 201, got ${created}`);

// dark mode
await page.click('.menu > button');
await page.click('.seg button >> nth=2');   // light · system · dark
await page.keyboard.press('Escape');
await page.click('a.nav-item[href="#/op/me"] >> nth=0');
await page.waitForSelector('.try');
await page.screenshot({ path: 'shots/05-dark.png' });

// sign out → login again as admin → admin page
await page.click('.menu > button');
await page.click('.menu-pop > button');     // the only direct button: sign out
await page.waitForSelector('form.login');
await page.fill('#email', 'admin@example.com');
await page.fill('#pw', 'admin');
await page.click('button.btn-primary');
await page.waitForSelector('a[href="#/admin"]');
await page.waitForSelector('a.nav-item[href="#/op/resetDb"]', { timeout: 5000 }).catch(() => { throw new Error('admin should see Admin tag'); });
await page.click('a[href="#/admin"]');
await page.waitForSelector('table');
await page.click('.menu > button');
await page.click('.seg button >> nth=0');   // light · system · dark
await page.keyboard.press('Escape');
await page.screenshot({ path: 'shots/06-admin.png' });

// viewer cannot try
await page.click('.menu > button');
await page.click('.menu-pop > button');     // the only direct button: sign out
await page.fill('#email', 'viewer@example.com');
await page.fill('#pw', 'viewer');
await page.click('button.btn-primary');
await page.waitForSelector('.nav-item');
await page.click('a.nav-item[href="#/op/listPets"] >> nth=0');
await page.waitForSelector('.try');
if (!(await page.locator('.try .btn-primary').isDisabled())) throw new Error('viewer should not be able to send');

// mobile
await page.setViewportSize({ width: 390, height: 800 });
await page.screenshot({ path: 'shots/07-mobile.png' });

await browser.close();
if (errors.length) {
  console.error('Browser errors:', errors);
  process.exit(1);
}
console.log('e2e OK');
