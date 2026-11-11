const { ipcRenderer } = require('electron')
window.addEventListener('DOMContentLoaded', () => {
  const form = document.querySelector('form')
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    try {
      await ipcRenderer.invoke('team:save', form.elements.origin.value)
    } catch (error) {
      document.querySelector('[role=alert]').textContent = error.message
    }
  })
})
