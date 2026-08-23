// Browser check: renders the app, signs in, walks the schema tree, runs SQL in a real query
// session, and fails on any console error after sign-in.
// Run "npx playwright install chromium" once first, then:
//   node scripts/smoke/ui.mjs
// Env: APP_URL, SMOKE_CONNECTION, SMOKE_EMAIL, SMOKE_PASSWORD, SMOKE_SHOTS
// Expects the server, the Vite dev server, a saved connection, and the scripts/smoke/seed.cjs
// fixtures to already exist.
import { chromium } from 'playwright';

const APP = process.env.APP_URL ?? 'http://localhost:5273';
const CONNECTION_NAME = process.env.SMOKE_CONNECTION ?? 'demo (wsl)';
const SHOT = process.env.SMOKE_SHOTS ?? '.';
const EMAIL = process.env.SMOKE_EMAIL ?? 'smoke@sqlmypg.local';
const PASSWORD = process.env.SMOKE_PASSWORD ?? 'smoke-test-password';

let pass = 0;
const fails = [];
const ok = (name, cond, extra) => {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fails.push(name);
    console.log(`  FAIL ${name}${extra === undefined ? '' : ' -> ' + String(extra).slice(0, 300)}`);
  }
};
const shot = (n) => page.screenshot({ path: `${SHOT}/ui-${n}.png` });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });

const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => pageErrors.push(e.message));

const editor = page.locator('.monaco-editor').first();
const typeSql = async (sql, key = 'Control+Enter') => {
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type(sql);
  await page.waitForTimeout(300);
  await page.keyboard.press(key);
  await page.waitForTimeout(3000);
};

await page.goto(APP, { waitUntil: 'networkidle' });
await shot('1-login');

console.log('\n== login screen');
ok('page renders something (not a white screen)', (await page.locator('body').innerText()).trim().length > 10);
ok('no uncaught page errors on first paint', pageErrors.length === 0, pageErrors.join(' | '));
const emailBox = page.locator('input[type="email"], input[name="email"]').first();
ok('email field present', (await emailBox.count()) > 0);
ok('password field present', (await page.locator('input[type="password"]').count()) > 0);
ok('product name on screen', /sqlmypg/i.test(await page.locator('body').innerText()));

console.log('\n== sign in');
await emailBox.fill(EMAIL);
await page.locator('input[type="password"]').first().fill(PASSWORD);
await page.getByRole('button', { name: /sign in|log in|continue/i }).first().click();
await page.waitForTimeout(2500);
await shot('2-shell');
// the pre-login /api/auth/me 401 is the expected "not signed in" answer, not a defect
consoleErrors.length = 0;
const shellText = await page.locator('body').innerText();
ok('logged in: the login form is gone', (await page.locator('input[type="password"]').count()) === 0, shellText.slice(0, 200));
ok('the saved connection is listed in the shell', shellText.includes(CONNECTION_NAME), shellText.slice(0, 300));

console.log('\n== schema tree');
// the sidebar renders each connection as a button; the top bar also carries it in a <select>,
// so target the button - an <option> is never clickable
await page.locator('button', { hasText: CONNECTION_NAME }).first().click();
await page.waitForTimeout(2500);
const tree = page.getByRole('tree');
ok('schemas loaded from the catalog', /shop/.test(await tree.innerText()), (await tree.innerText()).slice(0, 300));
await page.getByRole('treeitem').filter({ hasText: /shop/ }).first().click();
await page.waitForTimeout(1500);
// relations sit under a kind group ("Tables"), so expand that too
await page.getByRole('treeitem').filter({ hasText: /Tables/ }).first().click();
await page.waitForTimeout(2500);
await shot('3-tree');
const treeText = await tree.innerText();
ok('relations appear under the schema', /events/.test(treeText) && /customers/.test(treeText), treeText.slice(0, 500));
ok('row/size estimates shown next to relations', /[\d.]+\s?(K|M|B|kB|MB|GB)/.test(treeText), treeText.match(/[^\n]*events[^\n]*/)?.[0]);

console.log('\n== sql editor (lazy Monaco chunk)');
ok('Monaco is not fetched before a query tab exists', (await page.locator('.monaco-editor').count()) === 0);
await page.keyboard.press('Control+T');
const monacoLoaded = await editor.waitFor({ state: 'visible', timeout: 30000 }).then(
  () => true,
  () => false,
);
ok('Monaco mounts from the local bundle when a tab opens', monacoLoaded);
ok(
  'no request went to a CDN',
  !(await page.evaluate(() =>
    performance.getEntriesByType('resource').some((r) => /jsdelivr|unpkg|cdnjs/.test(r.name)),
  )),
);

if (monacoLoaded) {
  await page.waitForTimeout(1500);
  await typeSql('SELECT id, kind, amount FROM shop.events ORDER BY id LIMIT 500;');
  await shot('4-results');
  let text = await page.locator('body').innerText();
  ok('query ran and the grid shows rows', /purchase|refund|signup/.test(text), text.slice(-600));
  ok('column headers rendered', /kind/.test(text) && /amount/.test(text));
  ok('a session is attached to the tab', !/no session/i.test(text), text.slice(-300));

  console.log('\n== transaction state in the UI');
  await typeSql(
    'BEGIN; CREATE TEMP TABLE foo(i int); INSERT INTO foo VALUES (1),(2); SELECT * FROM foo;',
    'Control+Shift+Enter',
  );
  await shot('5-transaction');
  text = await page.locator('body').innerText();
  ok('IN TRANSACTION is surfaced', /in\s*transaction/i.test(text), text.slice(-400));

  await typeSql('SELECT * FROM nope_not_here;');
  await shot('6-error');
  text = await page.locator('body').innerText();
  ok('a SQL error is shown with its message', /does not exist|42P01/i.test(text), text.slice(-400));

  await typeSql('ROLLBACK;');
}

console.log('\n== browse a 5,000,000 row table');
const eventsRow = page.getByRole('treeitem').filter({ hasText: /events/ }).first();
if (await eventsRow.count()) {
  await eventsRow.dblclick();
  await page.waitForTimeout(4000);
  await shot('7-browse');
  const text = await page.locator('body').innerText();
  ok('table browser opened with data', /occurred_at|payload|user_id/.test(text), text.slice(0, 500));
}

console.log('\n== console health');
const ignorable = (m) => /favicon|React DevTools|ResizeObserver loop|Autofocus processing was blocked/i.test(m);
const realErrors = consoleErrors.filter((m) => !ignorable(m));
ok('no uncaught exceptions after sign-in', pageErrors.length === 0, pageErrors.join(' | '));
ok('no console errors after sign-in', realErrors.length === 0, realErrors.slice(0, 5).join(' | '));

await shot('8-final');
await browser.close();

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log('failed:\n' + fails.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
