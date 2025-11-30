import { ElectronAPI } from '@electron-toolkit/preload'

export interface TorrentStatus {
  downloadSpeed: number
  uploadSpeed: number
  progress: number
  numPeers: number
  downloaded: number
}

export interface TorrentInfo {
  name: string
  size: number
  downloaded: number
  downloadSpeed: number
  uploadSpeed: number
  progress: number
  numPeers: number
  infoHash: string
}

export interface TorrentStartResult {
  url: string
  name: string
  size: number
  infoHash: string
}

export interface TorrentAPI {
  start: (magnetOrPath: string) => Promise<TorrentStartResult>
  stop: () => Promise<void>
  getInfo: () => Promise<TorrentInfo | null>
  updatePlayback: (time: number) => void
  onStatus: (callback: (data: TorrentStatus) => void) => () => void
}

export interface API {
  torrent: TorrentAPI
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: API
  }
}
