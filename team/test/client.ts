import assert from 'node:assert/strict'
import { chromium, _electron } from 'playwright-core'
import type { Page } from 'playwright-core'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

async function login(page: Page, origin: string, username: string, password: string) {
  await page.goto(origin)
  await page.getByLabel('用户名').fill(username)
  await page.getByLabel('密码').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('button', { name: '通讯录', exact: true }).waitFor()
}

export async function verifyClient(origin: string, password: string) {
  if (process.env.IM_TEST_CHROME) {
    const browser = await chromium.launch({ executablePath: process.env.IM_TEST_CHROME, headless: true })
    const errors: string[] = []
    try {
      const alice = await browser.newPage({ locale: 'zh-CN' }),
        bob = await browser.newPage({ locale: 'zh-CN' })
      for (const page of [alice, bob]) {
        page.setDefaultTimeout(8_000)
        page.on('pageerror', error => errors.push(error.stack ?? error.message))
      }
      await login(alice, origin, 'alice', password)
      await login(bob, origin, 'bob', password)
      await alice.locator('.bt-side-top').getByRole('button', { name: '新建', exact: true }).click()
      await alice.getByLabel('群名称').fill('浏览器验证群')
      await alice.getByRole('checkbox', { name: 'bob', exact: true }).check()
      await alice.getByRole('button', { name: '创建', exact: true }).click()
      await alice.locator('.dsb-head .bt-pill').filter({ hasText: '浏览器验证群' }).waitFor()
      await alice.getByLabel('输入消息').fill('来自 Alice 的实时消息')
      await alice.getByRole('button', { name: '发送', exact: true }).click()
      await bob
        .locator('.bt-side [data-room-id]').filter({ hasText: '浏览器验证群' })
        .click()
      await bob.locator('article').getByText('来自 Alice 的实时消息').waitFor()
      await bob.getByRole('button', { name: '引用', exact: true }).click()
      await bob.getByLabel('输入消息').fill('Bob 已收到')
      await bob.getByRole('button', { name: '发送', exact: true }).click()
      await alice.locator('article').getByText('Bob 已收到').waitFor()
      assert.equal(await alice.locator('article blockquote').textContent(), '来自 Alice 的实时消息')
      await alice.locator('.dsb-head .bt-pill').click()
      await alice.locator('.bt-panel').getByRole('heading', { name: '群成员' }).waitFor()
      await alice.locator('.bt-panel .modal-head button').click()
      await alice.getByRole('button', { name: '设置', exact: true }).click()
      await alice.locator('.bt-settings').getByRole('button', { name: '外观', exact: true }).click()
      await alice.getByRole('combobox', { name: '主题', exact: true }).waitFor()
      await alice.getByRole('combobox', { name: '消息布局', exact: true }).selectOption('flat')
      assert.equal(await alice.locator('body').getAttribute('data-bt-layout'), 'flat')
    } catch (error) {
      if (errors.length) throw new Error(errors.join('\n'), { cause: error })
      throw error
    } finally {
      await browser.close()
    }
  }
  if (process.env.IM_TEST_ELECTRON) {
    const folder = await mkdtemp(join(tmpdir(), 'dsbot-team-client-'))
    const electron = await _electron.launch({
      args: [fileURLToPath(new URL('../', import.meta.url)), '--user-data-dir=' + folder],
      executablePath: process.env.IM_TEST_ELECTRON,
    })
    try {
      const setup = await electron.firstWindow()
      await setup.getByLabel('服务器地址').fill(origin)
      const nextWindow = electron.waitForEvent('window')
      await setup.getByRole('button', { name: '连接' }).click()
      const page = await nextWindow
      await login(page, origin, 'alice', password)
      assert.equal(
        await page.evaluate(() => typeof (window as Window & { require?: unknown }).require),
        'undefined'
      )
      await page.reload()
      await page.getByRole('button', { name: '通讯录', exact: true }).waitFor()
    } finally {
      await electron.close()
      await rm(folder, { recursive: true, force: true })
    }
  }
}
