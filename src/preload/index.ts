import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Torrent API for renderer
const torrentAPI = {
  // Start streaming a torrent
  start: (magnetOrPath: string): Promise<{
    url: string
    name: string
    size: number
    infoHash: string
  }> => ipcRenderer.invoke('torrent:start', magnetOrPath),

  // Stop the current torrent
  stop: (): Promise<void> => ipcRenderer.invoke('torrent:stop'),

  // Get torrent info
  getInfo: (): Promise<{
    name: string
    size: number
    downloaded: number
    downloadSpeed: number
    uploadSpeed: number
    progress: number
    numPeers: number
    infoHash: string
  } | null> => ipcRenderer.invoke('torrent:get-info'),

  // Update playback position for sliding window
  updatePlayback: (time: number): void => {
    ipcRenderer.send('torrent:update-playback', time)
  },

  // Listen for status updates
  onStatus: (
    callback: (data: {
      downloadSpeed: number
      uploadSpeed: number
      progress: number
      numPeers: number
      downloaded: number
    }) => void
  ): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: Parameters<typeof callback>[0]): void => callback(data)
    ipcRenderer.on('torrent:status', handler)
    return () => ipcRenderer.removeListener('torrent:status', handler)
  }
}

// Custom APIs for renderer
const api = {
  torrent: torrentAPI
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
