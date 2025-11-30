import { createServer, IncomingMessage, ServerResponse, Server } from 'http'
import { ipcMain, BrowserWindow } from 'electron'
import { AddressInfo } from 'net'
import ffmpeg from 'fluent-ffmpeg'
import ffmpegPath from 'ffmpeg-static'
import ffprobePath from 'ffprobe-static'

// Fix FFmpeg and FFprobe paths for Electron build (asar unpacking)
const ffmpegBinaryPath = ffmpegPath ? ffmpegPath.replace('app.asar', 'app.asar.unpacked') : ''
const ffprobeBinaryPath = ffprobePath?.path ? ffprobePath.path.replace('app.asar', 'app.asar.unpacked') : ''
ffmpeg.setFfmpegPath(ffmpegBinaryPath)
ffmpeg.setFfprobePath(ffprobeBinaryPath)

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
const HARD_LIMIT_BUFFER_MB = 75  // Absolute maximum - pause download if exceeded

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
let actualVideoDuration = 0  // Actual duration from ffprobe (seconds)

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

// Get video duration using ffprobe from HTTP URL
async function getVideoDurationFromUrl(url: string): Promise<number> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(url, (err: Error | null, metadata: { format?: { duration?: number } }) => {
      if (err) {
        console.log('[FFprobe] Error getting duration:', err.message)
        resolve(0)
        return
      }
      const duration = metadata?.format?.duration || 0
      console.log('[FFprobe] Video duration:', duration, 'seconds')
      resolve(duration)
    })
  })
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

let isTranscoding = false   // Track if FFmpeg is active
let transcodeClientId = 0   // Track client connections

function handleTranscodeRequest(req: IncomingMessage, res: ServerResponse): void {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Range, Content-Type', 'Access-Control-Max-Age': '86400' })
    res.end()
    return
  }

  if (!currentFile || !currentTorrent) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('No file loaded')
    return
  }

  // Parse seek time from query string
  const url = new URL(req.url || '/', 'http://localhost')
  const seekTime = parseFloat(url.searchParams.get('t') || '0')
  const clientId = ++transcodeClientId

  console.log('[Transcode #' + clientId + '] New request, seek:', seekTime, 's')

  // Kill previous FFmpeg command if exists
  if (ffmpegCommand) {
    console.log('[Transcode #' + clientId + '] Killing previous FFmpeg')
    try {
      ffmpegCommand.kill('SIGKILL')
    } catch { /* ignore */ }
    ffmpegCommand = null
    isTranscoding = false
  }

  // Use fragmented MP4 for browser compatibility and seeking
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

  console.log('[FFmpeg #' + clientId + '] Starting transcoding...')
  console.log('[FFmpeg #' + clientId + '] File size:', formatBytes(currentFile.length))

  // Calculate byte offset for seek
  // Estimate bitrate from file size and estimated duration
  const bufferConfig = currentTorrent._bufferConfig || getBufferConfig(currentFile.length)
  const estimatedBytesPerSecond = currentFile.length / bufferConfig.estimatedDuration
  const seekByteOffset = seekTime > 0 ? Math.floor(seekTime * estimatedBytesPerSecond) : 0
  
  console.log('[FFmpeg #' + clientId + '] Seek time:', seekTime, 's, byte offset:', formatBytes(seekByteOffset))

  // Create read stream with byte offset for seeking
  // WebTorrent will start reading from this position, skipping unavailable chunks
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const streamOpts: any = seekByteOffset > 0 ? { start: seekByteOffset } : {}
  const inputStream = currentFile.createReadStream(streamOpts)
  
  inputStream.on('error', (err: Error) => {
    console.log('[FFmpeg #' + clientId + '] Input stream error:', err.message)
  })

  // Create transcoding pipeline using fluent-ffmpeg
  // Video: copy (no re-encoding - 0 CPU)
  // Audio: AAC (browser compatible)
  // Container: Fragmented MP4 (seekable in browser)
  const command = ffmpeg(inputStream)
    .inputOptions([
      '-probesize 50M',               // Analyze more data for format detection  
      '-analyzeduration 20M',         // Analyze longer for stream info
      '-fflags +genpts+discardcorrupt+igndts'  // Handle corrupt/missing data gracefully
    ])
    .videoCodec('copy')               // Copy video - no re-encoding (0 CPU)
    .audioCodec('aac')                // Transcode audio to AAC (browser compatible)
    .audioChannels(2)                 // Stereo
    .audioBitrate('192k')             // Audio bitrate
    .format('mp4')                    // MP4 container
    .outputOptions([
      '-movflags frag_keyframe+empty_moov+default_base_moof+faststart',  // Fragmented MP4 for streaming
      '-max_muxing_queue_size 9999',     // Prevent muxing queue overflow
      '-avoid_negative_ts make_zero'     // Fix timestamp issues after seek
    ])
    .on('start', (cmd: string) => {
      console.log('[FFmpeg #' + clientId + '] Command:', cmd)
      isTranscoding = true
    })
    .on('progress', (progress: any) => {
      if (progress.timemark) {
        console.log('[FFmpeg #' + clientId + '] Progress:', progress.timemark)
      }
    })
    .on('error', (err: Error) => {
      isTranscoding = false
      // Ignore common disconnect errors
      if (err.message.includes('EPIPE') || 
          err.message.includes('Readable stream closed') || 
          err.message.includes('Output stream closed') ||
          err.message.includes('SIGKILL')) {
        console.log('[FFmpeg #' + clientId + '] Stopped (client disconnected)')
      } else {
        console.log('[FFmpeg #' + clientId + '] Error:', err.message)
      }
      if (!res.writableEnded) res.end()
      ffmpegCommand = null
    })
    .on('end', () => {
      console.log('[FFmpeg #' + clientId + '] Transcoding finished')
      isTranscoding = false
      if (!res.writableEnded) res.end()
      ffmpegCommand = null
    })

  // NOTE: We're NOT using FFmpeg -ss seek anymore!
  // Instead, we start the WebTorrent stream from the correct byte offset.
  // This is more reliable because:
  // 1. FFmpeg -ss on pipe input requires reading from start anyway
  // 2. WebTorrent can skip missing chunks at the beginning
  // 3. The byte-level seek is more accurate for our use case

  // Save reference for cleanup
  ffmpegCommand = command

  // Cleanup on client disconnect
  res.on('close', () => {
    console.log('[Transcode #' + clientId + '] Client disconnected')
    try {
      inputStream.destroy()
    } catch { /* ignore */ }
    if (ffmpegCommand) {
      try {
        ffmpegCommand.kill('SIGKILL')
      } catch { /* ignore */ }
      ffmpegCommand = null
      isTranscoding = false
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
  // Add torrent and return file list for user selection
  ipcMain.handle('torrent:add', async (_event, magnetOrPath: string) => {
    return new Promise((resolve, reject) => {
      if (!magnetOrPath?.trim()) { reject(new Error('Invalid magnet link or torrent path')); return }
      if (!client) { reject(new Error('Torrent client not initialized')); return }

      const cleanup = (): Promise<void> => {
        return new Promise((resolveCleanup) => {
          if (ffmpegCommand) { try { ffmpegCommand.kill('SIGKILL') } catch { /* */ }; ffmpegCommand = null }
          if (currentTorrent) {
            stopSlidingWindow(); stopStatusUpdates()
            try { client.remove(currentTorrent.infoHash, { destroyStore: true }, () => { resetState(); resolveCleanup() }) }
            catch { resetState(); resolveCleanup() }
          } else { resolveCleanup() }
        })
      }

      cleanup().then(() => {
        let torrentInput: string | Buffer = magnetOrPath
        if (magnetOrPath.startsWith('data:application/x-bittorrent;base64,')) {
          const base64Data = magnetOrPath.replace('data:application/x-bittorrent;base64,', '')
          torrentInput = Buffer.from(base64Data, 'base64')
        }

        let resolved = false
        const timeout = setTimeout(() => { if (!resolved) { resolved = true; reject(new Error('Connection timeout')) } }, CONNECTION_TIMEOUT)

        const errorHandler = (err: Error): void => {
          if (!resolved) { resolved = true; clearTimeout(timeout); reject(err); client.removeListener('error', errorHandler) }
        }
        client.on('error', errorHandler)

        try {
          client.add(torrentInput, {
            store: memoryStore, 
            maxWebConns: 10,
            storeCacheSlots: 0,  // Disable cache to prevent memory duplication
            announce: ['wss://tracker.openwebtorrent.com', 'wss://tracker.btorrent.xyz', 'wss://tracker.fastcast.nz',
              'udp://tracker.opentrackr.org:1337/announce', 'udp://tracker.openbittorrent.com:6969/announce',
              'udp://open.stealth.si:80/announce', 'udp://exodus.desync.com:6969/announce']
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          }, (torrent: any) => {
            if (resolved) return
            resolved = true; clearTimeout(timeout); client.removeListener('error', errorHandler)
            currentTorrent = torrent

            // IMPORTANT: Deselect ALL files initially - don't download anything yet!
            // But DON'T pause the torrent - keep peer connections alive
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            torrent.files.forEach((f: any) => f.deselect())
            torrent._paused = false  // Track our own state, not actual pause

            // Get list of video files for user selection
            // IMPORTANT: Use torrent.files index, not filtered array index!
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const videoFiles = torrent.files
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .map((f: any, index: number) => ({ file: f, torrentIndex: index }))
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .filter((item: any) => isVideoFile(item.file.name))
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .map((item: any) => ({
                index: item.torrentIndex,  // Use original torrent.files index!
                name: item.file.name,
                size: item.file.length,
                sizeFormatted: formatBytes(item.file.length),
                isVideo: true
              }))

            console.log('[Torrent] Added:', torrent.name)
            console.log('[Torrent] Files:', torrent.files.length, '(', videoFiles.length, 'video)')
            console.log('[Torrent] Peers:', torrent.numPeers, 'connected')

            resolve({
              name: torrent.name,
              infoHash: torrent.infoHash,
              files: videoFiles,
              totalSize: torrent.length
            })
          })
        } catch (err) {
          if (!resolved) { resolved = true; clearTimeout(timeout); client.removeListener('error', errorHandler); reject(err) }
        }
      })
    })
  })

  // Select a file from the torrent and start streaming
  ipcMain.handle('torrent:select-file', async (_event, fileIndex: number) => {
    return new Promise((resolve, reject) => {
      if (!currentTorrent) { reject(new Error('No torrent loaded')); return }

      const torrent = currentTorrent
      const file = torrent.files[fileIndex]
      if (!file) { reject(new Error('Invalid file index')); return }

      // Deselect ALL files first
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      torrent.files.forEach((f: any) => f.deselect())

      // Select only the chosen file
      currentFile = file
      file.select()

      const bufferConfig = getBufferConfig(file.length)
      useTranscoding = needsTranscoding(file.name)

      console.log('[Torrent] User selected:', file.name)
      console.log('[Torrent] Size:', formatBytes(file.length))
      console.log('[Torrent] Needs transcoding:', useTranscoding)

      // Setup initial pieces for quick start
      const pieceLength = torrent.pieceLength
      const startPiece = Math.floor((file.offset || 0) / pieceLength)
      const quickStartPieces = Math.min(30, Math.ceil((bufferConfig.criticalBufferSeconds * bufferConfig.bytesPerSecond) / pieceLength))
      const endPiece = Math.min(startPiece + quickStartPieces, torrent.pieces.length - 1)
      
      console.log('[Torrent] File offset:', file.offset, 'Piece range:', startPiece, '-', endPiece)
      
      // Mark critical pieces
      if (torrent.critical) { 
        try { 
          torrent.critical(startPiece, endPiece)
          console.log('[Torrent] Marked critical pieces:', startPiece, '-', endPiece)
        } catch (e) { 
          console.error('[Torrent] Failed to mark critical:', e)
        } 
      }

      torrent._bufferConfig = bufferConfig
      torrent._paused = false
      
      // Resume torrent for the selected file
      try { 
        torrent.resume()
        console.log('[Torrent] Resumed torrent, paused:', torrent.paused)
      } catch (e) { 
        console.error('[Torrent] Failed to resume:', e)
      }
      
      startSlidingWindow()
      startStatusUpdates()

      const streamUrl = useTranscoding 
        ? 'http://localhost:' + transcodeServerPort + '/'
        : 'http://localhost:' + rawServerPort + '/'

      // Calculate estimated duration based on file size and quality
      const estimatedDuration = bufferConfig.estimatedDuration
      actualVideoDuration = estimatedDuration  // Store for status updates
      
      // BEST PRACTICE: Try multiple times to get actual duration from ffprobe
      // First attempt after 1.5s, then retry at 5s and 10s if needed
      const tryGetDuration = async (attempt: number): Promise<void> => {
        try {
          const rawUrl = 'http://localhost:' + rawServerPort + '/'
          const duration = await getVideoDurationFromUrl(rawUrl)
          if (duration > 0) {
            actualVideoDuration = duration
            console.log('[Torrent] ✓ Got actual duration (attempt ' + attempt + '):', Math.round(duration), 's (' + Math.round(duration / 60) + ' min)')
          } else if (attempt < 3) {
            // Retry with exponential backoff
            const delays = [1500, 5000, 10000]
            setTimeout(() => tryGetDuration(attempt + 1), delays[attempt])
          }
        } catch (e) {
          console.log('[Torrent] Could not get duration (attempt ' + attempt + '):', e)
          if (attempt < 3) {
            const delays = [1500, 5000, 10000]
            setTimeout(() => tryGetDuration(attempt + 1), delays[attempt])
          }
        }
      }
      
      // Start trying to get duration after initial buffer
      setTimeout(() => tryGetDuration(1), 1500)

      resolve({
        url: streamUrl,
        name: file.name,
        size: file.length,
        contentType: useTranscoding ? 'video/mp4' : getContentType(file.name),
        infoHash: torrent.infoHash,
        transcoded: useTranscoding,
        estimatedDuration: estimatedDuration
      })
    })
  })

  // Legacy start handler - auto-selects best file (for backward compatibility)
  ipcMain.handle('torrent:start', async (_event, magnetOrPath: string) => {
    return new Promise((resolve, reject) => {
      if (!magnetOrPath?.trim()) { reject(new Error('Invalid magnet link or torrent path')); return }
      if (!client) { reject(new Error('Torrent client not initialized')); return }

      const cleanup = (): Promise<void> => {
        return new Promise((resolveCleanup) => {
          // Kill FFmpeg if running
          if (ffmpegCommand) { try { ffmpegCommand.kill('SIGKILL') } catch { /* */ }; ffmpegCommand = null }
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
            store: memoryStore, 
            maxWebConns: 10,
            storeCacheSlots: 0,  // Disable cache to prevent memory duplication
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

            // IMPORTANT: Deselect ALL files first!
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            torrent.files.forEach((f: any) => f.deselect())

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

            // Select ONLY the video file
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

  // Track playback position for sliding window
  // BEST PRACTICE: Also track seek events to trigger immediate cleanup
  ipcMain.on('torrent:update-playback', (_event, time: number) => { 
    const wasSeek = Math.abs(time - currentPlaybackTime) > 5  // Detect seek (> 5 second jump)
    currentPlaybackTime = time
    
    // If this was a seek, immediately trigger cleanup and prioritize new position
    if (wasSeek && currentTorrent && currentFile) {
      console.log('[Buffer] 🔄 Seek detected to', Math.round(time), 's - prioritizing new position')
      
      // Reset hard pause on seek so we can buffer new position
      if (currentTorrent._hardPaused) {
        currentTorrent._hardPaused = false
        try { currentTorrent.resume() } catch { /* ignore */ }
      }
      if (currentTorrent._paused) {
        currentTorrent._paused = false
        try { currentTorrent.resume() } catch { /* ignore */ }
      }
      
      // Calculate new position and mark critical pieces
      const pieceLength = currentTorrent.pieceLength
      const fileOffset = currentFile.offset || 0
      const bufferConfig = currentTorrent._bufferConfig || getBufferConfig(currentFile.length)
      const bytesPerSecond = bufferConfig.bytesPerSecond
      const seekBytePos = Math.floor(time * bytesPerSecond)
      const seekPiece = Math.floor((fileOffset + seekBytePos) / pieceLength)
      const criticalPieces = Math.min(20, Math.ceil((15 * bytesPerSecond) / pieceLength))  // 15 seconds of critical
      
      console.log('[Buffer] Seek byte position:', seekBytePos, 'piece:', seekPiece)
      
      // Mark pieces as critical starting from seek position
      if (currentTorrent.critical && seekPiece >= 0) {
        const totalPieces = currentTorrent.pieces?.length || 0
        const endPiece = Math.min(seekPiece + criticalPieces, totalPieces - 1)
        try {
          currentTorrent.critical(seekPiece, endPiece)
          console.log('[Buffer] Marked critical pieces:', seekPiece, '-', endPiece)
        } catch { /* ignore */ }
      }
    }
  })

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
      
      // BEST PRACTICE: Dynamic buffer sizing based on playback position
      // Only keep a small window behind (already watched) and focus on what's ahead
      const behindBytes = Math.min(BUFFER_BEHIND_SECONDS * bytesPerSecond, maxBufferBytes * 0.1)  // Max 10% for behind
      const aheadBytes = Math.min(maxBufferBytes * 0.9, bufferConfig.aheadBytes)  // 90% for ahead
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
      // 
      // STORE STRUCTURE (with storeCacheSlots: 0):
      //   torrent.store = ImmediateChunkStore
      //     -> .store = MemoryChunkStore (direct, no cache)
      //     -> .mem = [] (immediate buffer)
      //     -> .store.chunks = [] (actual stored chunks)
      
      let freedCount = 0
      let storedChunksBytes = 0
      
      // Navigate to the actual memory-chunk-store
      const immediateStore = torrent.store
      const memoryStore = immediateStore?.store  // Direct to memory-chunk-store (no cache wrapper)
      const chunks = memoryStore?.chunks || []
      const immediateMem = immediateStore?.mem || []
      
      // Count stored chunks
      for (let i = 0; i < chunks.length; i++) {
        if (chunks[i]) {
          storedChunksBytes += chunks[i].length || pieceLength
        }
      }
      
      // Count immediate buffer
      for (let i = 0; i < immediateMem.length; i++) {
        if (immediateMem[i]) {
          storedChunksBytes += immediateMem[i].length || pieceLength
        }
      }
      
      const storedChunksMB = storedChunksBytes / (1024 * 1024)
      const processMemMB = process.memoryUsage().heapUsed / (1024 * 1024)
      const hardLimitBytes = HARD_LIMIT_BUFFER_MB * 1024 * 1024
      
      // ALWAYS CLEAN pieces outside window - don't wait for limit
      // This is the key to preventing memory bloat!
      if (chunks.length > 0) {
        // Delete ALL pieces BEFORE the window
        for (let i = 0; i < windowStart; i++) {
          if (chunks[i]) {
            chunks[i] = null
            freedCount++
          }
          if (immediateMem[i]) {
            immediateMem[i] = null
          }
        }
        
        // Delete ALL pieces AFTER the window
        for (let i = windowEnd + 1; i < chunks.length; i++) {
          if (chunks[i]) {
            chunks[i] = null
            freedCount++
          }
          if (immediateMem[i]) {
            immediateMem[i] = null
          }
        }
      }
      
      // HARD LIMIT CHECK using process memory as fallback
      if (storedChunksBytes > hardLimitBytes || processMemMB > 500) {
        console.log('[Buffer] ⚠️ MEMORY WARNING! Chunks: ' + storedChunksMB.toFixed(1) + 'MB, Process heap: ' + processMemMB.toFixed(0) + 'MB')
        
        // Pause torrent to stop downloading
        if (!torrent._hardPaused) {
          try {
            torrent.pause()
            torrent._hardPaused = true
            console.log('[Buffer] 🛑 HARD PAUSED torrent')
          } catch { /* ignore */ }
        }
        
        // EMERGENCY: Clear everything except current window
        for (let i = 0; i < chunks.length; i++) {
          if (i < windowStart || i > windowEnd) {
            if (chunks[i]) {
              chunks[i] = null
              freedCount++
            }
            if (immediateMem[i]) {
              immediateMem[i] = null
            }
          }
        }
        
        // Try to trigger garbage collection
        if (global.gc) {
          try { global.gc() } catch { /* ignore */ }
        }
      }
      
      // Recount after cleanup
      let actualMemoryBytes = 0
      for (let i = 0; i < chunks.length; i++) {
        if (chunks[i]) {
          actualMemoryBytes += chunks[i].length || pieceLength
        }
      }
      const actualMemoryMB = actualMemoryBytes / (1024 * 1024)
      
      // Resume if we were hard paused and now under limit
      if (torrent._hardPaused && actualMemoryBytes < maxBufferBytes * 0.8) {
        console.log('[Buffer] ✅ Memory under limit, resuming from hard pause')
        try {
          torrent.resume()
          torrent._hardPaused = false
        } catch { /* ignore */ }
      }

      let bufferedStart = currentPiece, bufferedEnd = currentPiece
      if (torrent.bitfield) {
        for (let i = currentPiece; i <= windowEnd && i < totalPieces; i++) { if (torrent.bitfield.get(i)) bufferedEnd = i; else break }
        for (let i = currentPiece; i >= windowStart && i >= 0; i--) { if (torrent.bitfield.get(i)) bufferedStart = i; else break }
      }

      const bufferedAheadPieces = Math.max(0, bufferedEnd - currentPiece)
      const bufferedAheadBytes = bufferedAheadPieces * pieceLength
      const bufferedAheadSeconds = bufferedAheadBytes / bytesPerSecond
      
      // Calculate buffer size from ACTUAL memory usage (accurate tracking)
      const bufferSizeMB = actualMemoryMB

      // BUFFER CONTROL: Pause/Resume download based on buffer state
      // If buffer is full (enough data ahead), pause downloading to save memory & bandwidth
      // BUT: Don't pause if FFmpeg is actively transcoding - it needs continuous data!
      const targetBufferSeconds = bufferConfig.aheadSeconds || 60
      const resumeThreshold = targetBufferSeconds * 0.5  // Resume at 50% of target
      const isBufferFull = bufferedAheadSeconds >= targetBufferSeconds

      // Don't allow resume if hard paused
      if (isBufferFull && !torrent._paused && !isTranscoding && !torrent._hardPaused) {
        console.log('[Buffer] PAUSING download - buffer full (' + Math.round(bufferedAheadSeconds) + 's ahead, target: ' + Math.round(targetBufferSeconds) + 's)')
        try {
          torrent.pause()
          torrent._paused = true
        } catch { /* ignore */ }
      } else if (torrent._paused && !torrent._hardPaused && (bufferedAheadSeconds < resumeThreshold || isTranscoding)) {
        console.log('[Buffer] RESUMING download - ' + (isTranscoding ? 'transcoding active' : 'buffer below threshold') + ' (' + Math.round(bufferedAheadSeconds) + 's ahead)')
        try {
          torrent.resume()
          torrent._paused = false
        } catch { /* ignore */ }
      }

      torrent._bufferInfo = { bufferedAheadSeconds: Math.round(bufferedAheadSeconds), bufferSizeMB: Math.min(bufferSizeMB, MAX_BUFFER_SIZE_MB), windowStart, windowEnd, currentPiece, bufferedStart, bufferedEnd, qualityTier: bufferConfig.tier, paused: torrent._paused || false, hardPaused: torrent._hardPaused || false }

      const now = Date.now()
      if (now - lastLogTime > 5000) {
        lastLogTime = now
        const heapMB = Math.round(process.memoryUsage().heapUsed / (1024 * 1024))
        const freedMsg = freedCount > 0 ? ' | freed ' + freedCount : ''
        const pausedMsg = torrent._hardPaused ? ' | 🛑 HARD' : (torrent._paused ? ' | PAUSED' : '')
        const limitWarning = heapMB > 400 ? ' ⚠️' : ''
        console.log('[Buffer] chunks:' + bufferSizeMB.toFixed(1) + 'MB heap:' + heapMB + 'MB' + limitWarning + ' | ' + Math.round(bufferedAheadSeconds) + 's | p' + currentPiece + '/' + totalPieces + ' w[' + windowStart + '-' + windowEnd + '] | ' + torrent.numPeers + 'p | ' + formatBytes(torrent.downloadSpeed) + '/s' + (useTranscoding ? ' | TC' : '') + freedMsg + pausedMsg)
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
        transcoded: useTranscoding,
        actualDuration: actualVideoDuration
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
