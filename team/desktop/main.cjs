const { app, BrowserWindow, ipcMain, Menu, Notification, Tray, nativeImage } = require('electron')
const { readFile, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const configFile = () => join(app.getPath('userData'), 'team-server.json')
let win,
  settings,
  tray,
  origin,
  quitting = false
const defaults = {
  title: 'DS Bot Team',
  width: 1100,
  height: 760,
  minWidth: 480,
  minHeight: 440,
  webPreferences: {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webviewTag: false,
    webSecurity: true,
  },
}
function validOrigin(value) {
  const url = new URL(value)
  const local =
    !app.isPackaged && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !local) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw Error('请输入 HTTPS 服务器地址')
  return url.origin
}
function safeWindow(window, allowed) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  for (const event of ['will-navigate', 'will-redirect'])
    window.webContents.on(event, (e, url) => {
      if (!allowed(url)) e.preventDefault()
    })
  const session = window.webContents.session
  session.setPermissionRequestHandler((_contents, _permission, cb) => cb(false))
  session.setPermissionCheckHandler(() => false)
}
function openSettings() {
  if (settings) {
    settings.show()
    return
  }
  settings = new BrowserWindow({
    ...defaults,
    width: 440,
    height: 300,
    minWidth: 360,
    minHeight: 240,
    webPreferences: { ...defaults.webPreferences, preload: join(__dirname, 'setup.cjs') },
  })
  safeWindow(settings, () => false)
  settings.on('closed', () => {
    settings = undefined
  })
  void settings.loadFile(join(__dirname, 'setup.html'))
}
function openTeam() {
  if (win) {
    win.show()
    return
  }
  if (!origin) {
    openSettings()
    return
  }
  const server = origin
  win = new BrowserWindow({
    ...defaults,
    webPreferences: {
      ...defaults.webPreferences,
      preload: join(__dirname, 'preload.cjs'),
      partition:
        'persist:team-' +
        require('node:crypto').createHash('sha256').update(server).digest('hex').slice(0, 20),
    },
  })
  safeWindow(win, (url) => {
    try {
      return new URL(url).origin === server
    } catch {
      return false
    }
  })
  win.on('close', (e) => {
    if (!quitting && tray) {
      e.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => {
    win = undefined
  })
  void win.loadURL(server).catch(() => openSettings())
}
function fromTeam(event) {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame)
    return false
  try {
    return new URL(event.senderFrame.url).origin === origin
  } catch {
    return false
  }
}
app.on('before-quit', () => {
  quitting = true
})
app.on('window-all-closed', () => {
  if (!tray && process.platform !== 'darwin') app.quit()
})
app.on('activate', openTeam)
app.whenReady().then(async () => {
  try {
    origin = validOrigin(JSON.parse(await readFile(configFile(), 'utf8')).origin)
  } catch {}
  ipcMain.handle('team:save', async (event, value) => {
    if (
      !settings ||
      event.sender !== settings.webContents ||
      event.senderFrame !== settings.webContents.mainFrame
    )
      throw Error('Invalid settings window')
    const selected = validOrigin(String(value))
    await writeFile(configFile(), JSON.stringify({ origin: selected }), { mode: 0o600 })
    if (win) win.destroy()
    origin = selected
    openTeam()
    settings?.close()
  })
  ipcMain.on('team:settings', (event) => {
    if (fromTeam(event)) openSettings()
  })
  ipcMain.on('team:badge', (event, count) => {
    if (fromTeam(event) && Number.isSafeInteger(count) && count >= 0) {
      app.setBadgeCount(Math.min(999, count))
      tray?.setToolTip(count ? 'DS Bot Team · ' + count + ' 条未读' : 'DS Bot Team')
    }
  })
  ipcMain.on('team:notify', (event, value) => {
    if (
      !fromTeam(event) ||
      !Notification.isSupported() ||
      !value ||
      !/^[a-f0-9-]{36}$/.test(value.conversation)
    )
      return
    const notification = new Notification({ title: 'DS Bot Team', body: '收到一条新消息' })
    notification.on('click', () => {
      openTeam()
      win?.webContents.send('team:open', value.conversation)
    })
    notification.show()
  })
  try {
    tray = new Tray(nativeImage.createFromPath(join(__dirname, 'tray.png')))
    tray.setToolTip('DS Bot Team')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开团队消息', click: openTeam },
        { label: '服务器设置', click: openSettings },
        { label: '退出', click: () => app.quit() },
      ])
    )
    tray.on('click', openTeam)
  } catch {}
  openTeam()
})
