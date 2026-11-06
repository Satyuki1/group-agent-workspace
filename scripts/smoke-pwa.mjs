// Browser-only boundary: trusted HTTPS, Chrome installability, worker and offline navigation.
import { chromium, expect } from '../upstream/buzz-app/node_modules/@playwright/test/index.mjs';
import { readFile, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const origin = process.env.PUBLIC_ORIGIN ?? 'https://127.0.0.1:18443';
const out = '/workspace/test-results/pwa';
await mkdir(out, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'group-agent-pwa-'));
const context = await chromium.launchPersistentContext(profile, { headless: true, executablePath: '/ms-playwright/chromium-1243/chrome-linux64/chrome', args: ['--no-sandbox'], viewport: { width: 1440, height: 960 } });
try {
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  await page.addInitScript(() => { window.addEventListener('beforeinstallprompt', () => { window.__installOffered = true; }); });
  await page.goto(origin);
  assert.equal(await page.evaluate(() => isSecureContext), true);
  const session = await context.newCDPSession(page);
  const manifest = await session.send('Page.getAppManifest');
  assert.equal(manifest.errors.length, 0);
  const config = JSON.parse(manifest.data);
  assert.equal(config.name, '群体智能');
  assert.equal(config.display, 'standalone');
  for (const icon of config.icons) {
    const image = await page.evaluate(async src => {
      const img = new Image(); img.src = src; await img.decode();
      return [img.naturalWidth, img.naturalHeight];
    }, icon.src);
    assert.deepEqual(image, icon.sizes.split('x').map(Number));
  }
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  const errors = await session.send('Page.getInstallabilityErrors');
  assert.deepEqual(errors.installabilityErrors, []);
  assert.equal(await page.evaluate(async () => (await caches.keys()).length), 0);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: '暂时无法连接' })).toBeVisible();
  await expect(page.getByText('离线期间无法发送消息。', { exact: false })).toBeVisible();
  await context.setOffline(false);
  await page.getByRole('link', { name: '重新连接' }).click();
  await page.getByLabel('账号', { exact: true }).waitFor();
  const password = /^密码：(.+)$/m.exec(await readFile('/tmp/group-agent-admin.txt', 'utf8'))?.[1];
  await page.getByLabel('账号', { exact: true }).fill('admin');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('navigation', { name: '主导航', exact: true }).waitFor();
  const install = page.getByRole('button', { name: '安装应用', exact: true });
  await expect(install).toBeVisible();
  await install.hover();
  await page.screenshot({ path: out + '/install-entry.png' });
  const nativeOffer = await page.evaluate(() => Boolean(window.__installOffered));
  // Exercise the actual manual entry in a browser where promotion is suppressed,
  // without accepting an OS-level install or fabricating an appinstalled event.
  const helpPage = await context.newPage();
  helpPage.setDefaultTimeout(30000);
  await helpPage.addInitScript(() => window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); event.stopImmediatePropagation(); }));
  await helpPage.goto(origin);
  await helpPage.getByRole('button', { name: '安装应用', exact: true }).click();
  await expect(helpPage.getByRole('dialog', { name: '安装群体智能' })).toBeVisible();
  await expect(helpPage.getByRole('dialog')).toHaveCSS('opacity', '1');
  await helpPage.screenshot({ path: out + '/install-help.png' });
  await helpPage.keyboard.press('Escape');
  await expect(helpPage.getByRole('dialog')).toBeHidden();
  await expect(helpPage.getByRole('button', { name: '安装应用', exact: true })).toBeFocused();
  await helpPage.evaluate(() => localStorage.setItem('buzz-appearance.v1', 'dark'));
  await helpPage.reload();
  await helpPage.setViewportSize({ width: 800, height: 800 });
  await helpPage.getByRole('button', { name: '安装应用', exact: true }).click();
  await expect(helpPage.getByRole('dialog', { name: '安装群体智能' })).toBeVisible();
  await expect(helpPage.getByRole('dialog')).toHaveCSS('opacity', '1');
  await helpPage.screenshot({ path: out + '/install-help-narrow.png' });
  const result = { secureContext: true, manifest: config.name, display: config.display, icons: '192 / 512 verified', installabilityErrors: errors.installabilityErrors, nativeInstallEvent: nativeOffer, offlineRecovery: true, privateCaches: 0, installEntry: true, keyboardDismissal: true };
  await writeFile(out + '/result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
