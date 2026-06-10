const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getFlags: () => ipcRenderer.invoke('get-flags'),
  submitExplanation: (data) => ipcRenderer.invoke('submit-explanation', data),
});
