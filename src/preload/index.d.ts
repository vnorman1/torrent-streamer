import { ElectronAPI } from '@electron-toolkit/preload'

export interface TorrentStatus {
  downloadSpeed: number
  uploadSpeed: number
  progress: number
  numPeers: number
  downloaded: number
  ratio?: number
  bufferedAheadSeconds?: number
  bufferSizeMB?: number
  qualityTier?: '4K' | '1080p_high' | '1080p' | '720p' | 'unknown'
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
  contentType?: string
  ratio?: number
}

export interface TorrentStartResult {
  url: string
  name: string
  size: number
  infoHash: string
  contentType?: string
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
