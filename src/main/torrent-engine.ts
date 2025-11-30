import { createServer, IncomingMessage, ServerResponse, Server } from 'http'
import { ipcMain, BrowserWindow } from 'electron'
import { AddressInfo } from 'net'
import ffmpeg from 'fluent-ffmpeg'
import ffmpegPath from 'ffmpeg-static'

// Fix FFmpeg path for Electron build (asar unpacking)
const binaryPath = ffmpegPath ? ffmpegPath.replace('app.asar', 'app.asar.unpacked') : ''
ffmpeg.setFfmpegPath(binaryPath)

// ============================================================================
// CONFIGURATION
// ============================================================================

const DEFAULT_PORT = 9090
const TRANSCODE_PORT = 9091
const MAX_BUFFER_SIZE_MB = 70
const BUFFER_BEHIND_SECONDS = 10
const STATUS_UPDATE_INTERVAL = 500
const SLIDING_WINDOW_INTERVAL = 500
const CONNECTION_TIMEOUT = 60000

const BUFFER_CONFIG = {
  '4K': { minBufferSeconds: 15, maxBufferSeconds: 45, criticalBufferSeconds: 5, bitrateThreshold: 50 * 1024 * 1024 / 8 },
  '1080p_high': { minBufferSeconds: 20, maxBufferSeconds: 60, criticalBufferSeconds: 8, bitrateThreshold: 20 * 1024 * 1024 / 8 },
  '1080p': { minBufferSeconds: 30, maxBufferSeconds: 90, criticalBufferSeconds: 10, bitrateThreshold: 8 * 1024 * 1024 / 8 },
  '720p': { minBufferSeconds: 45, maxBufferSeconds: 120, criticalBufferSeconds: 15, bitrateThreshold: 0 }
}

// ============================================================================
// STATE
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any = null
let rawServer: Server | null = null
let transcodeServer: Server | null = null
let rawServerPort: number = DEFAULT_PORT
let transcodeServerPort: number = TRANSCODE_PORT
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ffmpegCommand: any = null
let useTranscoding = false

// ============================================================================
// MIME TYPES
// ============================================================================

const VIDEO_MIME_TYPES: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
  mov: 'video/mp4', avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv', asf: 'video/x-ms-asf',
  flv: 'video/x-flv', mpg: 'video/mpeg', mpeg: 'video/mpeg', mpe: 'video/mpeg',
  m2v: 'video/mpeg', ts: 'video/mp2t', m2ts: 'video/mp2t', mts: 'video/mp2t',
  '3gp': 'video/3gpp', '3g2': 'video/3gpp2', ogv: 'video/ogg', ogg: 'video/ogg',
  vob: 'video/x-ms-vob', divx: 'video/x-msvideo', xvid: 'video/x-msvideo',
  rm: 'application/vnd.rn-realmedia', rmvb: 'application/vnd.rn-realmedia-vbr'
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

function needsTranscoding(filename: string): boolean {
  const ext = filename.toLowerCase().split('.').pop() || ''
  // MKV, AVI, and other containers often have AC3/DTS audio that browsers can't play
  return ['mkv', 'avi', 'wmv', 'flv', 'ts', 'm2ts', 'vob', 'rm', 'rmvb'].includes(ext)
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
  const estimatedDuration = fileSizeBytes > 10e9 ? 7200 : fileSizeBytes > 5e9 ? 5400 : fileSizeBytes > 2e9 ? 3600 : fileSizeBytes > 500e6 ? 2400 : 1200
  const bytesPerSecond = fileSizeBytes / estimatedDuration
  const maxBufferBytes = MAX_BUFFER_SIZE_MB * 1024 * 1024
  const desiredAheadBytes = config.maxBufferSeconds * bytesPerSecond
  const behindBytes = BUFFER_BEHIND_SECONDS * bytesPerSecond
  const actualAheadBytes = Math.min(desiredAheadBytes, maxBufferBytes - behindBytes)
  const actualAheadSeconds = actualAheadBytes / bytesPerSecond
  return { tier, bytesPerSecond, behindBytes, aheadBytes: actualAheadBytes, behindSeconds: BUFFER_BEHIND_SECONDS, aheadSeconds: actualAheadSeconds, criticalBufferSeconds: config.criticalBufferSeconds, estimatedDuration }
}

async function findAvailablePort(startPort: number): Promise<number> {
  return new Promise((resolve) => {
    const testServer = createServer()
    testServer.listen(startPort, () => {
      const port = (testServer.address() as AddressInfo).port
      testServer.close(() => resolve(port))
    })
    testServer.on('error', () => resolve(findAvailablePort(startPort + 1)))
  })
}

// ============================================================================
// RAW HTTP STREAMING SERVER (for direct playback)
// ============================================================================

function handleRawRequest(req: IncomingMessage, res: ServerResponse): void {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Range, Content-Type', 'Access-Control-Max-Age': '86400' })
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
    'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    'Cache-Control': 'no-cache, no-store, must-revalidate', 'Connection': 'keep-alive', 'X-Content-Type-Options': 'nosniff'
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
        estimatedBitrate = estimatedBitrate > 0 ? estimatedBitrate * 0.7 + instantBitrate * 0.3 : instantBitrate
      }
    }
    lastBytePosition = start
    lastByteTime = now
    res.writeHead(206, { ...headers, 'Content-Range': 'bytes ' + start + '-' + end + '/' + fileSize, 'Content-Length': chunkSize })
    if (req.method === 'HEAD') { res.end(); return }
    try {
      const stream = file.createReadStream({ start, end })
      stream.on('error', (err: Error) => { if (!err.message.includes('prematurely')) console.error('[HTTP] Stream error:', err.message); res.end() })
      res.on('close', () => stream.destroy())
      stream.pipe(res)
    } catch { if (!res.headersSent) res.writeHead(500); res.end() }
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': fileSize })
    if (req.method === 'HEAD') { res.end(); return }
    try {
      const stream = file.createReadStream()
      stream.on('error', () => res.end())
      res.on('close', () => stream.destroy())
      stream.pipe(res)
    } catch { if (!res.headersSent) res.writeHead(500); res.end() }
  }
}

// ============================================================================
// TRANSCODING SERVER (FFmpeg converts to browser-compatible format)
// ============================================================================

function handleTranscodeRequest(req: IncomingMessage, res: ServerResponse): void {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Range, Content-Type', 'Access-Control-Max-Age': '86400' })
    res.end()
    return
  }

  if (!currentFile) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('No file loaded')
    return
  }

  // Parse seek time from query string
  const url = new URL(req.url || '/', 'http://localhost')
  const seekTime = parseFloat(url.searchParams.get('t') || '0')

  console.log('[Transcode] Request, seek:', seekTime, 's')

  // Kill previous FFmpeg command if exists
  if (ffmpegCommand) {
    try {
      ffmpegCommand.kill('SIGKILL')
    } catch { /* ignore */ }
    ffmpegCommand = null
  }

  // Output MP4 format - remux with AAC audio
  const headers = {
    'Content-Type': 'video/mp4',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Connection': 'keep-alive',
    'Transfer-Encoding': 'chunked'
  }

  res.writeHead(200, headers)

  if (req.method === 'HEAD') {
    res.end()
    return
  }

  console.log('[FFmpeg] Starting transcoding with fluent-ffmpeg...')
  console.log('[FFmpeg] Path:', binaryPath)

  // Create transcoding pipeline using fluent-ffmpeg (as per todo.md)
  // Video: copy (0 CPU usage)
  // Audio: AAC (browser compatible)
  const command = ffmpeg(currentFile.createReadStream())
    .videoCodec('copy')               // Copy video - no re-encoding (0 CPU)
    .audioCodec('aac')                // Transcode audio to AAC
    .audioChannels(2)                 // Stereo
    .audioBitrate('192k')             // Audio bitrate
    .format('mp4')                    // MP4 container
    .outputOptions([
      '-movflags frag_keyframe+empty_moov+default_base_moof'  // Streaming-friendly fragmented MP4
    ])
    .on('start', (cmd: string) => {
      console.log('[FFmpeg] Command:', cmd)
    })
    .on('error', (err: Error) => {
      // Ignore EPIPE errors (client disconnected)
      if (!err.message.includes('EPIPE') && !err.message.includes('Readable stream closed') && !err.message.includes('Output stream closed')) {
        console.log('[FFmpeg] Error:', err.message)
      }
      if (!res.writableEnded) res.end()
      ffmpegCommand = null
    })
    .on('end', () => {
      console.log('[FFmpeg] Transcoding finished')
      if (!res.writableEnded) res.end()
      ffmpegCommand = null
    })

  // Add seek if requested
  if (seekTime > 0) {
    command.seekInput(seekTime)
  }

  // Save reference for cleanup
  ffmpegCommand = command

  // Cleanup on client disconnect
  res.on('close', () => {
    console.log('[Transcode] Client disconnected')
    if (ffmpegCommand) {
      try {
        ffmpegCommand.kill('SIGKILL')
      } catch { /* ignore */ }
      ffmpegCommand = null
    }
  })

  // Pipe FFmpeg output to HTTP response
  command.pipe(res, { end: true })
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

    client = new WebTorrent({ maxConns: 100, uploadLimit: 5 * 1024 * 1024, downloadLimit: -1 })
    client.on('error', (err: Error) => console.error('[Engine] WebTorrent error:', err.message))

    // Raw server (direct streaming)
    rawServerPort = await findAvailablePort(DEFAULT_PORT)
    rawServer = createServer(handleRawRequest)
    rawServer.keepAliveTimeout = 60000
    rawServer.headersTimeout = 65000
    rawServer.on('error', (err: Error) => console.error('[HTTP Raw] Server error:', err.message))
    await new Promise<void>((resolve, reject) => {
      rawServer!.listen(rawServerPort, 'localhost', () => {
        console.log('[HTTP Raw] Server on http://localhost:' + rawServerPort)
        resolve()
      })
      rawServer!.on('error', reject)
    })

    // Transcode server (FFmpeg streaming)
    transcodeServerPort = await findAvailablePort(TRANSCODE_PORT)
    transcodeServer = createServer(handleTranscodeRequest)
    transcodeServer.keepAliveTimeout = 120000
    transcodeServer.headersTimeout = 125000
    transcodeServer.on('error', (err: Error) => console.error('[HTTP Transcode] Server error:', err.message))
    await new Promise<void>((resolve, reject) => {
      transcodeServer!.listen(transcodeServerPort, 'localhost', () => {
        console.log('[HTTP Transcode] Server on http://localhost:' + transcodeServerPort)
        resolve()
      })
      transcodeServer!.on('error', reject)
    })

    setupIPCHandlers()
    isInitialized = true
    console.log('[Engine] Initialized successfully')
    console.log('[FFmpeg] Binary:', ffmpegPath)
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
      if (!magnetOrPath?.trim()) { reject(new Error('Invalid magnet link or torrent path')); return }
      if (!client) { reject(new Error('Torrent client not initialized')); return }

      const cleanup = (): Promise<void> => {
        return new Promise((resolveCleanup) => {
          // Kill FFmpeg if running
          if (ffmpegCommand) { ffmpegCommand.kill('SIGKILL'); ffmpegCommand = null }
          if (currentTorrent) {
            stopSlidingWindow(); stopStatusUpdates()
            try { client.remove(currentTorrent.infoHash, { destroyStore: true }, () => { console.log('[Torrent] Previous torrent removed'); resetState(); resolveCleanup() }) }
            catch { resetState(); resolveCleanup() }
          } else { resolveCleanup() }
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
        const timeout = setTimeout(() => { if (!resolved) { resolved = true; reject(new Error('Connection timeout')) } }, CONNECTION_TIMEOUT)

        const errorHandler = (err: Error): void => {
          if (!resolved) { resolved = true; clearTimeout(timeout); reject(err); client.removeListener('error', errorHandler) }
        }
        client.on('error', errorHandler)

        try {
          client.add(torrentInput, {
            store: memoryStore, maxWebConns: 10,
            announce: ['wss://tracker.openwebtorrent.com', 'wss://tracker.btorrent.xyz', 'wss://tracker.fastcast.nz',
              'udp://tracker.opentrackr.org:1337/announce', 'udp://tracker.openbittorrent.com:6969/announce',
              'udp://open.stealth.si:80/announce', 'udp://exodus.desync.com:6969/announce',
              'udp://tracker.torrent.eu.org:451/announce', 'udp://tracker.tiny-vps.com:6969/announce', 'udp://tracker.moeking.me:6969/announce']
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          }, (torrent: any) => {
            if (resolved) return
            resolved = true; clearTimeout(timeout); client.removeListener('error', errorHandler)
            currentTorrent = torrent
            console.log('[Torrent] Added:', torrent.name)
            console.log('[Torrent] InfoHash:', torrent.infoHash)
            console.log('[Torrent] Files:', torrent.files.length)
            console.log('[Torrent] Piece length:', formatBytes(torrent.pieceLength))

            torrent.on('error', (err: Error) => console.error('[Torrent] Error:', err.message))
            torrent.on('warning', (warn: Error) => console.warn('[Torrent] Warning:', warn.message))

            const videoFile = findBestVideoFile(torrent.files)
            if (!videoFile) { reject(new Error('No video file found')); return }

            currentFile = videoFile
            const bufferConfig = getBufferConfig(videoFile.length)
            
            // Check if transcoding is needed
            useTranscoding = needsTranscoding(videoFile.name)
            
            console.log('[Torrent] Selected:', videoFile.name)
            console.log('[Torrent] Size:', formatBytes(videoFile.length))
            console.log('[Torrent] Quality tier:', bufferConfig.tier)
            console.log('[Torrent] Needs transcoding:', useTranscoding)
            console.log('[Torrent] Est. duration:', Math.round(bufferConfig.estimatedDuration / 60), 'min')

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            torrent.files.forEach((f: any) => { if (f !== videoFile) f.deselect() })
            videoFile.select()

            const pieceLength = torrent.pieceLength
            const startPiece = Math.floor(videoFile.offset / pieceLength)
            const quickStartPieces = Math.min(30, Math.ceil((bufferConfig.criticalBufferSeconds * bufferConfig.bytesPerSecond) / pieceLength))
            const endPiece = Math.min(startPiece + quickStartPieces, torrent.pieces.length - 1)
            console.log('[Torrent] Quick start: pieces ' + startPiece + '-' + endPiece)
            if (torrent.critical) { try { torrent.critical(startPiece, endPiece) } catch { /* ignore */ } }

            torrent._bufferConfig = bufferConfig
            startSlidingWindow()
            startStatusUpdates()

            // Use transcode server if needed, otherwise raw server
            const streamUrl = useTranscoding 
              ? 'http://localhost:' + transcodeServerPort + '/'
              : 'http://localhost:' + rawServerPort + '/'
            
            console.log('[Torrent] Stream URL:', streamUrl)
            console.log('[Torrent] Mode:', useTranscoding ? 'TRANSCODED (FFmpeg)' : 'DIRECT')

            resolve({
              url: streamUrl,
              name: videoFile.name,
              size: videoFile.length,
              contentType: useTranscoding ? 'video/mp4' : getContentType(videoFile.name),
              infoHash: torrent.infoHash,
              transcoded: useTranscoding
            })
          })
        } catch (err) {
          if (!resolved) { resolved = true; clearTimeout(timeout); client.removeListener('error', errorHandler); reject(err) }
        }
      })
    })
  })

  ipcMain.on('torrent:update-playback', (_event, time: number) => { currentPlaybackTime = time })

  ipcMain.handle('torrent:stop', async () => {
    if (ffmpegCommand) { ffmpegCommand.kill('SIGKILL'); ffmpegCommand = null }
    stopSlidingWindow(); stopStatusUpdates()
    if (currentTorrent && client) {
      return new Promise<void>((resolve) => {
        try { client.remove(currentTorrent.infoHash, { destroyStore: true }, () => { resetState(); resolve() }) }
        catch { resetState(); resolve() }
      })
    }
  })

  ipcMain.handle('torrent:get-info', async () => {
    if (!currentTorrent || !currentFile) return null
    let progress = 0
    try { progress = currentFile.progress || 0 } catch { /* ignore */ }
    return {
      name: currentFile.name, size: currentFile.length, contentType: getContentType(currentFile.name),
      downloaded: currentTorrent.downloaded || 0, downloadSpeed: currentTorrent.downloadSpeed || 0,
      uploadSpeed: currentTorrent.uploadSpeed || 0, progress, numPeers: currentTorrent.numPeers || 0,
      infoHash: currentTorrent.infoHash, ratio: currentTorrent.ratio || 0, transcoded: useTranscoding
    }
  })
}

function resetState(): void {
  currentTorrent = null; currentFile = null; currentPlaybackTime = 0; currentPlaybackBytes = 0
  estimatedBitrate = 0; lastBytePosition = 0; lastByteTime = 0; useTranscoding = false
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findBestVideoFile(files: any[]): any {
  const sortedFiles = [...files].sort((a, b) => b.length - a.length)
  for (const file of sortedFiles) { if (isVideoFile(file.name)) return file }
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
      const bytesPerSecond = estimatedBitrate > 0 ? estimatedBitrate : bufferConfig.bytesPerSecond

      let currentByte = 0
      if (currentPlaybackBytes > 0) { currentByte = currentPlaybackBytes - fileOffset }
      else if (currentPlaybackTime > 0) { currentByte = Math.floor(currentPlaybackTime * bytesPerSecond) }
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

      // IMPORTANT: Ensure ONLY the selected video file is being downloaded
      // Deselect all other files on every tick to prevent memory leaks
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      torrent.files.forEach((f: any) => {
        if (f !== file) {
          try { f.deselect() } catch { /* ignore */ }
        }
      })
      
      // Select only pieces within our buffer window
      file.select()
      if (torrent.critical && currentPiece >= 0 && currentPiece < totalPieces) {
        try { const criticalEnd = Math.min(windowEnd, currentPiece + Math.ceil((10 * bytesPerSecond) / pieceLength)); torrent.critical(currentPiece, criticalEnd) } catch { /* ignore */ }
      }

      // ACTIVE MEMORY CLEANUP: Delete pieces outside the buffer window
      // This enforces the 70MB limit by removing old pieces from memory
      // memory-chunk-store uses a simple array: store.chunks[index]
      let freedCount = 0
      if (torrent.store && torrent.store.chunks) {
        const chunks = torrent.store.chunks
        
        // Delete pieces before the window (already watched)
        for (let i = filePieceStart; i < windowStart; i++) {
          if (chunks[i]) {
            chunks[i] = null  // Free memory
            freedCount++
            // Also update bitfield
            if (torrent.bitfield && torrent.bitfield.set) {
              try { torrent.bitfield.set(i, false) } catch { /* ignore */ }
            }
          }
        }
        
        // Delete pieces after the window (too far ahead - shouldn't happen normally)
        for (let i = windowEnd + 1; i <= filePieceEnd; i++) {
          if (chunks[i]) {
            chunks[i] = null  // Free memory  
            freedCount++
            if (torrent.bitfield && torrent.bitfield.set) {
              try { torrent.bitfield.set(i, false) } catch { /* ignore */ }
            }
          }
        }
      }

      let bufferedStart = currentPiece, bufferedEnd = currentPiece
      if (torrent.bitfield) {
        for (let i = currentPiece; i <= windowEnd && i < totalPieces; i++) { if (torrent.bitfield.get(i)) bufferedEnd = i; else break }
        for (let i = currentPiece; i >= windowStart && i >= 0; i--) { if (torrent.bitfield.get(i)) bufferedStart = i; else break }
      }

      const bufferedAheadPieces = Math.max(0, bufferedEnd - currentPiece)
      const bufferedAheadBytes = bufferedAheadPieces * pieceLength
      const bufferedAheadSeconds = bufferedAheadBytes / bytesPerSecond
      const totalBufferedPieces = Math.max(1, bufferedEnd - bufferedStart + 1)
      const bufferSizeMB = (totalBufferedPieces * pieceLength) / (1024 * 1024)

      // BUFFER CONTROL: Pause/Resume download based on buffer state
      // If buffer is full (enough data ahead), pause downloading to save memory & bandwidth
      const targetBufferSeconds = bufferConfig.aheadSeconds || 60
      const resumeThreshold = targetBufferSeconds * 0.5  // Resume at 50% of target
      const isBufferFull = bufferedAheadSeconds >= targetBufferSeconds

      if (isBufferFull && !torrent._paused) {
        console.log('[Buffer] PAUSING download - buffer full (' + Math.round(bufferedAheadSeconds) + 's ahead, target: ' + Math.round(targetBufferSeconds) + 's)')
        try {
          torrent.pause()
          torrent._paused = true
        } catch { /* ignore */ }
      } else if (torrent._paused && bufferedAheadSeconds < resumeThreshold) {
        console.log('[Buffer] RESUMING download - buffer below threshold (' + Math.round(bufferedAheadSeconds) + 's ahead)')
        try {
          torrent.resume()
          torrent._paused = false
        } catch { /* ignore */ }
      }

      torrent._bufferInfo = { bufferedAheadSeconds: Math.round(bufferedAheadSeconds), bufferSizeMB: Math.min(bufferSizeMB, MAX_BUFFER_SIZE_MB), windowStart, windowEnd, currentPiece, bufferedStart, bufferedEnd, qualityTier: bufferConfig.tier, paused: torrent._paused || false }

      const now = Date.now()
      if (now - lastLogTime > 5000) {
        lastLogTime = now
        const freedMsg = freedCount > 0 ? ' | freed ' + freedCount + ' pieces' : ''
        const pausedMsg = torrent._paused ? ' | PAUSED' : ''
        console.log('[Buffer] ' + bufferSizeMB.toFixed(1) + 'MB/' + MAX_BUFFER_SIZE_MB + 'MB | ' + Math.round(bufferedAheadSeconds) + 's ahead | pieces ' + currentPiece + '/' + totalPieces + ' | ' + torrent.numPeers + ' peers | ' + formatBytes(torrent.downloadSpeed) + '/s | ' + bufferConfig.tier + (useTranscoding ? ' | TRANSCODING' : '') + freedMsg + pausedMsg)
      }
    } catch { /* ignore */ }
  }, SLIDING_WINDOW_INTERVAL)
}

function stopSlidingWindow(): void { if (slidingWindowInterval) { clearInterval(slidingWindowInterval); slidingWindowInterval = null } }

function startStatusUpdates(): void {
  if (statusUpdateInterval) clearInterval(statusUpdateInterval)
  statusUpdateInterval = setInterval(() => {
    if (!currentTorrent || !currentFile) return
    const bufferInfo = currentTorrent._bufferInfo || { bufferedAheadSeconds: 0, bufferSizeMB: 0, qualityTier: 'unknown' }
    let progress = 0
    try { progress = currentFile.progress || 0 } catch { /* ignore */ }
    const windows = BrowserWindow.getAllWindows()
    if (windows.length > 0) {
      windows[0].webContents.send('torrent:status', {
        downloadSpeed: currentTorrent.downloadSpeed || 0, uploadSpeed: currentTorrent.uploadSpeed || 0, progress,
        numPeers: currentTorrent.numPeers || 0, downloaded: currentTorrent.downloaded || 0, ratio: currentTorrent.ratio || 0,
        bufferedAheadSeconds: bufferInfo.bufferedAheadSeconds, bufferSizeMB: bufferInfo.bufferSizeMB, qualityTier: bufferInfo.qualityTier,
        transcoded: useTranscoding
      })
    }
  }, STATUS_UPDATE_INTERVAL)
}

function stopStatusUpdates(): void { if (statusUpdateInterval) { clearInterval(statusUpdateInterval); statusUpdateInterval = null } }

// ============================================================================
// CLEANUP
// ============================================================================

export function destroyTorrentEngine(): void {
  if (ffmpegCommand) { ffmpegCommand.kill('SIGKILL'); ffmpegCommand = null }
  stopSlidingWindow(); stopStatusUpdates()
  if (rawServer) { rawServer.close(); rawServer = null }
  if (transcodeServer) { transcodeServer.close(); transcodeServer = null }
  if (client) { client.destroy(); client = null }
  resetState()
  isInitialized = false
  console.log('[Engine] Destroyed')
}
