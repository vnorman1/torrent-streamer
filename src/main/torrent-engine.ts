import { createServer, IncomingMessage, ServerResponse, Server } from 'http'
import { ipcMain, BrowserWindow } from 'electron'
import { AddressInfo } from 'net'

// ============================================================================
// CONFIGURATION - Optimized for all video qualities (SD to 4K HDR)
// ============================================================================

const DEFAULT_PORT = 9090
const MAX_BUFFER_SIZE_MB = 70 // Maximum RAM buffer in MB (strict limit)

// Adaptive buffer sizing based on video quality detection
const BUFFER_CONFIG = {
  // 4K HDR (50+ Mbps) - need more buffer due to high bitrate
  '4K': {
    minBufferSeconds: 15,
    maxBufferSeconds: 45,
    criticalBufferSeconds: 5,
    bitrateThreshold: 50 * 1024 * 1024 / 8
  },
  // 4K SDR / 1080p High (20-50 Mbps)
  '1080p_high': {
    minBufferSeconds: 20,
    maxBufferSeconds: 60,
    criticalBufferSeconds: 8,
    bitrateThreshold: 20 * 1024 * 1024 / 8
  },
  // 1080p Standard (8-20 Mbps)
  '1080p': {
    minBufferSeconds: 30,
    maxBufferSeconds: 90,
    criticalBufferSeconds: 10,
    bitrateThreshold: 8 * 1024 * 1024 / 8
  },
  // 720p and below (< 8 Mbps)
  '720p': {
    minBufferSeconds: 45,
    maxBufferSeconds: 120,
    criticalBufferSeconds: 15,
    bitrateThreshold: 0
  }
}

const BUFFER_BEHIND_SECONDS = 10
const STATUS_UPDATE_INTERVAL = 500
const SLIDING_WINDOW_INTERVAL = 500
const CONNECTION_TIMEOUT = 60000

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any = null
let server: Server | null = null
let serverPort: number = DEFAULT_PORT
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let currentTorrent: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let currentFile: any = null
let currentPlaybackTime = 0
let currentPlaybackBytes = 0
let estimatedBitrate = 0
let lastBytePosition = 0
let lastByteTime = 0
let slidingWindowInterval: NodeJS.Timeout | null = null
let statusUpdateInterval: NodeJS.Timeout | null = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let memoryStore: any = null
let isInitialized = false

// ============================================================================
// MIME TYPES - Comprehensive video format support
// ============================================================================

const VIDEO_MIME_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/mp4',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  asf: 'video/x-ms-asf',
  flv: 'video/x-flv',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  mpe: 'video/mpeg',
  m2v: 'video/mpeg',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  mts: 'video/mp2t',
  '3gp': 'video/3gpp',
  '3g2': 'video/3gpp2',
  ogv: 'video/ogg',
  ogg: 'video/ogg',
  vob: 'video/x-ms-vob',
  divx: 'video/x-msvideo',
  xvid: 'video/x-msvideo',
  rm: 'application/vnd.rn-realmedia',
  rmvb: 'application/vnd.rn-realmedia-vbr'
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

function getContentType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() || ''
  return VIDEO_MIME_TYPES[ext] || 'application/octet-stream'
}

function isVideoFile(filename: string): boolean {
  const ext = filename.toLowerCase().split('.').pop() || ''
  return ext in VIDEO_MIME_TYPES
}

function detectQualityTier(fileSizeBytes: number): keyof typeof BUFFER_CONFIG {
  const fileSizeGB = fileSizeBytes / (1024 * 1024 * 1024)
  if (fileSizeGB > 30) return '4K'
  if (fileSizeGB > 15) return '1080p_high'
  if (fileSizeGB > 5) return '1080p'
  return '720p'
}

function getBufferConfig(fileSizeBytes: number) {
  const tier = detectQualityTier(fileSizeBytes)
  const config = BUFFER_CONFIG[tier]
  
  const estimatedDuration = fileSizeBytes > 10e9 ? 7200 :
                            fileSizeBytes > 5e9 ? 5400 :
                            fileSizeBytes > 2e9 ? 3600 :
                            fileSizeBytes > 500e6 ? 2400 :
                            1200
  
  const bytesPerSecond = fileSizeBytes / estimatedDuration
  const maxBufferBytes = MAX_BUFFER_SIZE_MB * 1024 * 1024
  const desiredAheadBytes = config.maxBufferSeconds * bytesPerSecond
  const behindBytes = BUFFER_BEHIND_SECONDS * bytesPerSecond
  const actualAheadBytes = Math.min(desiredAheadBytes, maxBufferBytes - behindBytes)
  const actualAheadSeconds = actualAheadBytes / bytesPerSecond
  
  return {
    tier,
    bytesPerSecond,
    behindBytes,
    aheadBytes: actualAheadBytes,
    behindSeconds: BUFFER_BEHIND_SECONDS,
    aheadSeconds: actualAheadSeconds,
    criticalBufferSeconds: config.criticalBufferSeconds,
    estimatedDuration
  }
}

async function findAvailablePort(startPort: number): Promise<number> {
  return new Promise((resolve) => {
    const testServer = createServer()
    testServer.listen(startPort, () => {
      const port = (testServer.address() as AddressInfo).port
      testServer.close(() => resolve(port))
    })
    testServer.on('error', () => {
      resolve(findAvailablePort(startPort + 1))
    })
  })
}

// ============================================================================
// HTTP STREAMING SERVER
// ============================================================================

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, Content-Type',
      'Access-Control-Max-Age': '86400'
    })
    res.end()
    return
  }

  if (!currentFile) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('No file loaded')
    return
  }

  const file = currentFile
  const fileSize = file.length
  const contentType = getContentType(file.name)

  const headers: Record<string, string | number> = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Connection': 'keep-alive',
    'X-Content-Type-Options': 'nosniff'
  }

  const range = req.headers.range

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-')
    const start = parseInt(parts[0], 10)
    const requestedEnd = parts[1] ? parseInt(parts[1], 10) : fileSize - 1
    const end = Math.min(requestedEnd, fileSize - 1)
    
    if (start >= fileSize || start < 0 || end < start) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + fileSize, ...headers })
      res.end()
      return
    }

    const chunkSize = end - start + 1
    currentPlaybackBytes = start
    
    const now = Date.now()
    if (lastBytePosition > 0 && lastByteTime > 0 && now - lastByteTime < 5000) {
      const bytesDiff = Math.abs(start - lastBytePosition)
      const timeDiff = (now - lastByteTime) / 1000
      if (bytesDiff > 0 && timeDiff > 0) {
        const instantBitrate = bytesDiff / timeDiff
        estimatedBitrate = estimatedBitrate > 0 
          ? estimatedBitrate * 0.7 + instantBitrate * 0.3 
          : instantBitrate
      }
    }
    lastBytePosition = start
    lastByteTime = now

    res.writeHead(206, {
      ...headers,
      'Content-Range': 'bytes ' + start + '-' + end + '/' + fileSize,
      'Content-Length': chunkSize
    })

    if (req.method === 'HEAD') {
      res.end()
      return
    }

    try {
      const stream = file.createReadStream({ start, end })
      
      stream.on('error', (err: Error) => {
        if (!err.message.includes('prematurely')) {
          console.error('[HTTP] Stream error:', err.message)
        }
        res.end()
      })

      res.on('close', () => {
        stream.destroy()
      })

      stream.pipe(res)
    } catch (err) {
      console.error('[HTTP] Failed to create stream')
      if (!res.headersSent) res.writeHead(500)
      res.end()
    }
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': fileSize })

    if (req.method === 'HEAD') {
      res.end()
      return
    }

    try {
      const stream = file.createReadStream()
      stream.on('error', () => res.end())
      res.on('close', () => stream.destroy())
      stream.pipe(res)
    } catch {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    }
  }
}

// ============================================================================
// INITIALIZATION
// ============================================================================

export async function initTorrentEngine(): Promise<void> {
  if (isInitialized) {
    console.log('[Engine] Already initialized')
    return
  }

  try {
    const WebTorrent = (await import('webtorrent')).default
    memoryStore = (await import('memory-chunk-store')).default

    client = new WebTorrent({
      maxConns: 100,
      uploadLimit: 5 * 1024 * 1024,
      downloadLimit: -1
    })

    client.on('error', (err: Error) => {
      console.error('[Engine] WebTorrent error:', err.message)
    })

    serverPort = await findAvailablePort(DEFAULT_PORT)
    
    server = createServer(handleRequest)
    server.keepAliveTimeout = 60000
    server.headersTimeout = 65000
    
    server.on('error', (err: Error) => {
      console.error('[HTTP] Server error:', err.message)
    })

    await new Promise<void>((resolve, reject) => {
      server!.listen(serverPort, 'localhost', () => {
        console.log('[HTTP] Streaming server on http://localhost:' + serverPort)
        resolve()
      })
      server!.on('error', reject)
    })

    setupIPCHandlers()
    isInitialized = true
    console.log('[Engine] Initialized successfully')
  } catch (error) {
    console.error('[Engine] Initialization failed:', error)
    throw error
  }
}

// ============================================================================
// IPC HANDLERS
// ============================================================================

function setupIPCHandlers(): void {
  ipcMain.handle('torrent:start', async (_event, magnetOrPath: string) => {
    return new Promise((resolve, reject) => {
      if (!magnetOrPath?.trim()) {
        reject(new Error('Invalid magnet link or torrent path'))
        return
      }

      if (!client) {
        reject(new Error('Torrent client not initialized'))
        return
      }

      const cleanup = (): Promise<void> => {
        return new Promise((resolveCleanup) => {
          if (currentTorrent) {
            stopSlidingWindow()
            stopStatusUpdates()
            try {
              client.remove(currentTorrent.infoHash, { destroyStore: true }, () => {
                console.log('[Torrent] Previous torrent removed')
                resetState()
                resolveCleanup()
              })
            } catch {
              resetState()
              resolveCleanup()
            }
          } else {
            resolveCleanup()
          }
        })
      }

      cleanup().then(() => {
        let torrentInput: string | Buffer = magnetOrPath
        if (magnetOrPath.startsWith('data:application/x-bittorrent;base64,')) {
          const base64Data = magnetOrPath.replace('data:application/x-bittorrent;base64,', '')
          torrentInput = Buffer.from(base64Data, 'base64')
          console.log('[Torrent] Adding from base64 buffer')
        } else {
          console.log('[Torrent] Adding:', magnetOrPath.substring(0, 80))
        }

        let resolved = false
        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true
            reject(new Error('Connection timeout'))
          }
        }, CONNECTION_TIMEOUT)

        const errorHandler = (err: Error): void => {
          if (!resolved) {
            resolved = true
            clearTimeout(timeout)
            reject(err)
            client.removeListener('error', errorHandler)
          }
        }
        client.on('error', errorHandler)

        try {
          client.add(
            torrentInput,
            {
              store: memoryStore,
              maxWebConns: 10,
              announce: [
                'wss://tracker.openwebtorrent.com',
                'wss://tracker.btorrent.xyz',
                'wss://tracker.fastcast.nz',
                'udp://tracker.opentrackr.org:1337/announce',
                'udp://tracker.openbittorrent.com:6969/announce',
                'udp://open.stealth.si:80/announce',
                'udp://exodus.desync.com:6969/announce',
                'udp://tracker.torrent.eu.org:451/announce',
                'udp://tracker.tiny-vps.com:6969/announce',
                'udp://tracker.moeking.me:6969/announce'
              ]
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (torrent: any) => {
              if (resolved) return
              resolved = true
              clearTimeout(timeout)
              client.removeListener('error', errorHandler)

              currentTorrent = torrent
              
              console.log('[Torrent] Added:', torrent.name)
              console.log('[Torrent] InfoHash:', torrent.infoHash)
              console.log('[Torrent] Files:', torrent.files.length)
              console.log('[Torrent] Piece length:', formatBytes(torrent.pieceLength))

              torrent.on('error', (err: Error) => console.error('[Torrent] Error:', err.message))
              torrent.on('warning', (warn: Error) => console.warn('[Torrent] Warning:', warn.message))

              const videoFile = findBestVideoFile(torrent.files)
              if (!videoFile) {
                reject(new Error('No video file found'))
                return
              }

              currentFile = videoFile
              const contentType = getContentType(videoFile.name)
              const bufferConfig = getBufferConfig(videoFile.length)
              
              console.log('[Torrent] Selected:', videoFile.name)
              console.log('[Torrent] Size:', formatBytes(videoFile.length))
              console.log('[Torrent] Quality tier:', bufferConfig.tier)
              console.log('[Torrent] Est. duration:', Math.round(bufferConfig.estimatedDuration / 60), 'min')
              console.log('[Torrent] Buffer ahead:', Math.round(bufferConfig.aheadSeconds), 's')

              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              torrent.files.forEach((f: any) => {
                if (f !== videoFile) f.deselect()
              })

              videoFile.select()
              
              const pieceLength = torrent.pieceLength
              const startPiece = Math.floor(videoFile.offset / pieceLength)
              const quickStartPieces = Math.min(
                30,
                Math.ceil((bufferConfig.criticalBufferSeconds * bufferConfig.bytesPerSecond) / pieceLength)
              )
              const endPiece = Math.min(startPiece + quickStartPieces, torrent.pieces.length - 1)
              
              console.log('[Torrent] Quick start: pieces ' + startPiece + '-' + endPiece)
              if (torrent.critical) {
                try { torrent.critical(startPiece, endPiece) } catch { /* ignore */ }
              }

              torrent._bufferConfig = bufferConfig

              startSlidingWindow()
              startStatusUpdates()

              const streamUrl = 'http://localhost:' + serverPort + '/'
              console.log('[Torrent] Stream URL:', streamUrl)

              resolve({
                url: streamUrl,
                name: videoFile.name,
                size: videoFile.length,
                contentType,
                infoHash: torrent.infoHash
              })
            }
          )
        } catch (err) {
          if (!resolved) {
            resolved = true
            clearTimeout(timeout)
            client.removeListener('error', errorHandler)
            reject(err)
          }
        }
      })
    })
  })

  ipcMain.on('torrent:update-playback', (_event, time: number) => {
    currentPlaybackTime = time
  })

  ipcMain.handle('torrent:stop', async () => {
    stopSlidingWindow()
    stopStatusUpdates()
    
    if (currentTorrent && client) {
      return new Promise<void>((resolve) => {
        try {
          client.remove(currentTorrent.infoHash, { destroyStore: true }, () => {
            resetState()
            resolve()
          })
        } catch {
          resetState()
          resolve()
        }
      })
    }
  })

  ipcMain.handle('torrent:get-info', async () => {
    if (!currentTorrent || !currentFile) return null

    let progress = 0
    try { progress = currentFile.progress || 0 } catch { /* ignore */ }

    return {
      name: currentFile.name,
      size: currentFile.length,
      contentType: getContentType(currentFile.name),
      downloaded: currentTorrent.downloaded || 0,
      downloadSpeed: currentTorrent.downloadSpeed || 0,
      uploadSpeed: currentTorrent.uploadSpeed || 0,
      progress,
      numPeers: currentTorrent.numPeers || 0,
      infoHash: currentTorrent.infoHash,
      ratio: currentTorrent.ratio || 0
    }
  })
}

function resetState(): void {
  currentTorrent = null
  currentFile = null
  currentPlaybackTime = 0
  currentPlaybackBytes = 0
  estimatedBitrate = 0
  lastBytePosition = 0
  lastByteTime = 0
}

// ============================================================================
// FILE SELECTION
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findBestVideoFile(files: any[]): any {
  const sortedFiles = [...files].sort((a, b) => b.length - a.length)
  
  for (const file of sortedFiles) {
    if (isVideoFile(file.name)) {
      return file
    }
  }
  
  console.log('[Torrent] No recognized video, using largest file')
  return sortedFiles[0] || null
}

// ============================================================================
// SLIDING WINDOW BUFFER MANAGEMENT
// ============================================================================

function startSlidingWindow(): void {
  if (slidingWindowInterval) clearInterval(slidingWindowInterval)

  let lastLogTime = 0

  slidingWindowInterval = setInterval(() => {
    if (!currentTorrent || !currentFile) return

    try {
      const torrent = currentTorrent
      const file = currentFile
      
      if (!torrent.pieces || !torrent.pieceLength) return

      const pieceLength = torrent.pieceLength
      const totalPieces = torrent.pieces.length
      const fileOffset = file.offset || 0
      const bufferConfig = torrent._bufferConfig || getBufferConfig(file.length)

      const bytesPerSecond = estimatedBitrate > 0 
        ? estimatedBitrate 
        : bufferConfig.bytesPerSecond

      let currentByte = 0
      if (currentPlaybackBytes > 0) {
        currentByte = currentPlaybackBytes - fileOffset
      } else if (currentPlaybackTime > 0) {
        currentByte = Math.floor(currentPlaybackTime * bytesPerSecond)
      }
      currentByte = Math.max(0, Math.min(currentByte, file.length))

      const currentPiece = Math.floor((fileOffset + currentByte) / pieceLength)
      const filePieceStart = Math.floor(fileOffset / pieceLength)
      const filePieceEnd = Math.ceil((fileOffset + file.length) / pieceLength) - 1

      const maxBufferBytes = MAX_BUFFER_SIZE_MB * 1024 * 1024
      const behindBytes = Math.min(BUFFER_BEHIND_SECONDS * bytesPerSecond, maxBufferBytes * 0.15)
      const aheadBytes = Math.min(maxBufferBytes - behindBytes, bufferConfig.aheadBytes)
      
      const piecesBehind = Math.ceil(behindBytes / pieceLength)
      const piecesAhead = Math.ceil(aheadBytes / pieceLength)

      const windowStart = Math.max(filePieceStart, currentPiece - piecesBehind)
      const windowEnd = Math.min(filePieceEnd, currentPiece + piecesAhead)

      file.select()

      if (torrent.critical && currentPiece >= 0 && currentPiece < totalPieces) {
        try { 
          const criticalEnd = Math.min(
            windowEnd, 
            currentPiece + Math.ceil((10 * bytesPerSecond) / pieceLength)
          )
          torrent.critical(currentPiece, criticalEnd)
        } catch { /* ignore */ }
      }

      let bufferedStart = currentPiece
      let bufferedEnd = currentPiece
      
      if (torrent.bitfield) {
        for (let i = currentPiece; i <= windowEnd && i < totalPieces; i++) {
          if (torrent.bitfield.get(i)) bufferedEnd = i
          else break
        }
        for (let i = currentPiece; i >= windowStart && i >= 0; i--) {
          if (torrent.bitfield.get(i)) bufferedStart = i
          else break
        }
      }

      const bufferedAheadPieces = Math.max(0, bufferedEnd - currentPiece)
      const bufferedAheadBytes = bufferedAheadPieces * pieceLength
      const bufferedAheadSeconds = bufferedAheadBytes / bytesPerSecond
      const totalBufferedPieces = Math.max(1, bufferedEnd - bufferedStart + 1)
      const bufferSizeMB = (totalBufferedPieces * pieceLength) / (1024 * 1024)

      torrent._bufferInfo = {
        bufferedAheadSeconds: Math.round(bufferedAheadSeconds),
        bufferSizeMB: Math.min(bufferSizeMB, MAX_BUFFER_SIZE_MB),
        windowStart,
        windowEnd,
        currentPiece,
        bufferedStart,
        bufferedEnd,
        qualityTier: bufferConfig.tier
      }

      const now = Date.now()
      if (now - lastLogTime > 5000) {
        lastLogTime = now
        console.log(
          '[Buffer] ' + bufferSizeMB.toFixed(1) + 'MB/' + MAX_BUFFER_SIZE_MB + 'MB | ' +
          Math.round(bufferedAheadSeconds) + 's ahead | ' +
          'pieces ' + currentPiece + '/' + totalPieces + ' | ' +
          torrent.numPeers + ' peers | ' +
          formatBytes(torrent.downloadSpeed) + '/s | ' +
          bufferConfig.tier
        )
      }
    } catch (err) {
      // Silently handle errors during transition
    }
  }, SLIDING_WINDOW_INTERVAL)
}

function stopSlidingWindow(): void {
  if (slidingWindowInterval) {
    clearInterval(slidingWindowInterval)
    slidingWindowInterval = null
  }
}

// ============================================================================
// STATUS UPDATES TO RENDERER
// ============================================================================

function startStatusUpdates(): void {
  if (statusUpdateInterval) clearInterval(statusUpdateInterval)

  statusUpdateInterval = setInterval(() => {
    if (!currentTorrent || !currentFile) return

    const bufferInfo = currentTorrent._bufferInfo || {
      bufferedAheadSeconds: 0,
      bufferSizeMB: 0,
      qualityTier: 'unknown'
    }

    let progress = 0
    try { progress = currentFile.progress || 0 } catch { /* ignore */ }

    const windows = BrowserWindow.getAllWindows()
    if (windows.length > 0) {
      windows[0].webContents.send('torrent:status', {
        downloadSpeed: currentTorrent.downloadSpeed || 0,
        uploadSpeed: currentTorrent.uploadSpeed || 0,
        progress,
        numPeers: currentTorrent.numPeers || 0,
        downloaded: currentTorrent.downloaded || 0,
        ratio: currentTorrent.ratio || 0,
        bufferedAheadSeconds: bufferInfo.bufferedAheadSeconds,
        bufferSizeMB: bufferInfo.bufferSizeMB,
        qualityTier: bufferInfo.qualityTier
      })
    }
  }, STATUS_UPDATE_INTERVAL)
}

function stopStatusUpdates(): void {
  if (statusUpdateInterval) {
    clearInterval(statusUpdateInterval)
    statusUpdateInterval = null
  }
}

// ============================================================================
// CLEANUP
// ============================================================================

export function destroyTorrentEngine(): void {
  stopSlidingWindow()
  stopStatusUpdates()

  if (server) {
    server.close()
    server = null
  }

  if (client) {
    client.destroy()
    client = null
  }
  
  resetState()
  isInitialized = false
  console.log('[Engine] Destroyed')
}
