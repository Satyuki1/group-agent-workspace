const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('teamDesktop', {
  settings: () => ipcRenderer.send('team:settings'),
  badge: (count) => ipcRenderer.send('team:badge', count),
  notify: (value) => ipcRenderer.send('team:notify', value),
  onOpen: (callback) => {
    const listener = (_event, id) => callback(id)
    ipcRenderer.on('team:open', listener)
    return () => ipcRenderer.removeListener('team:open', listener)
  },
})
