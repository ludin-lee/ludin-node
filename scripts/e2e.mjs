// Browser smoke test + screenshots for the express example (must be running on :3000).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 1380, height: 860 }, colorScheme: 'light' });
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

const navText = await page.locator('.nav').innerText();
if (navText.includes('/admin/reset')) throw new Error('developer should not see Admin tag');
if (await page.locator('a[href="#/admin"]').count()) throw new Error('developer should not see Admin button');

// open an operation and try it out
await page.click('a.nav-item:has-text("/pets/{petId}") >> nth=0');
await page.waitForSelector('.try');
await page.click('button:has-text("Send request")');
await page.waitForSelector('.result-h');
const status = await page.locator('.result-h .status-pill').innerText();
if (status !== '200') throw new Error(`expected 200 from try-it-out, got ${status}`);
await page.screenshot({ path: 'shots/03-operation.png' });

// POST with body
await page.click('a.nav-item:has-text("/pets") >> nth=1');
await page.waitForSelector('.try textarea');
await page.click('button:has-text("Send request")');
await page.waitForSelector('.result-h');
const created = await page.locator('.result-h .status-pill').innerText();
if (created !== '201') throw new Error(`expected 201, got ${created}`);

// dark mode
await page.click('.menu > button');
await page.click('.seg button:has-text("dark")');
await page.keyboard.press('Escape');
await page.click('a.nav-item:has-text("/secure/me")');
await page.waitForSelector('.try');
await page.screenshot({ path: 'shots/04-dark.png' });

// sign out → login again as admin → admin page
await page.click('.menu > button');
await page.click('.menu-pop button:has-text("Sign out")');
await page.waitForSelector('form.login');
await page.fill('#email', 'admin@example.com');
await page.fill('#pw', 'admin');
await page.click('button.btn-primary');
await page.waitForSelector('a[href="#/admin"]');
await page.waitForSelector('.nav-item:has-text("/admin/reset")', { timeout: 5000 }).catch(() => { throw new Error('admin should see Admin tag'); });
await page.click('a[href="#/admin"]');
await page.waitForSelector('table');
await page.click('.menu > button');
await page.click('.seg button:has-text("light")');
await page.keyboard.press('Escape');
await page.screenshot({ path: 'shots/05-admin.png' });

// viewer cannot try
await page.click('.menu > button');
await page.click('.menu-pop button:has-text("Sign out")');
await page.fill('#email', 'viewer@example.com');
await page.fill('#pw', 'viewer');
await page.click('button.btn-primary');
await page.waitForSelector('.nav-item');
await page.click('a.nav-item:has-text("/pets") >> nth=0');
await page.waitForSelector('.try');
if (!(await page.locator('button:has-text("Send request")').isDisabled())) throw new Error('viewer should not be able to send');

// mobile
await page.setViewportSize({ width: 390, height: 800 });
await page.screenshot({ path: 'shots/06-mobile.png' });

await browser.close();
if (errors.length) {
  console.error('Browser errors:', errors);
  process.exit(1);
}
console.log('e2e OK');
