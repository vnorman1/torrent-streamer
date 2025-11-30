import { createServer, IncomingMessage, ServerResponse, Server } from 'http'
import { ipcMain, BrowserWindow } from 'electron'

const PORT = 9090
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any = null
let server: Server | null = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let currentTorrent: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let currentFile: any = null
let currentPlaybackTime = 0
let slidingWindowInterval: NodeJS.Timeout | null = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let memoryStore: any = null

export async function initTorrentEngine(): Promise<void> {
  // Dynamic import for ESM-only webtorrent
  const WebTorrent = (await import('webtorrent')).default
  memoryStore = (await import('memory-chunk-store')).default

  // Initialize WebTorrent with memory store for RAM-only buffering
  client = new WebTorrent({
    store: memoryStore
  })

  // Create local HTTP server for streaming
  server = createServer(handleRequest)
  server.listen(PORT, () => {
    console.log(`Streaming server running on http://localhost:${PORT}`)
  })

  setupIPCHandlers()
}

function getContentType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop()
  const mimeTypes: Record<string, string> = {
    mp4: 'video/mp4',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    webm: 'video/webm',
    mov: 'video/quicktime',
    m4v: 'video/x-m4v',
    flv: 'video/x-flv',
    wmv: 'video/x-ms-wmv',
    ts: 'video/mp2t',
    m2ts: 'video/mp2t'
  }
  return mimeTypes[ext || ''] || 'application/octet-stream'
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  if (!currentFile) {
    res.writeHead(404)
    res.end('No file loaded')
    return
  }

  const file = currentFile
  const fileSize = file.length
  const contentType = getContentType(file.name)

  // Parse Range header for seeking support
  const range = req.headers.range

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-')
    const start = parseInt(parts[0], 10)
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1
    const chunkSize = end - start + 1

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*'
    })

    const stream = file.createReadStream({ start, end })
    stream.pipe(res)
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*'
    })

    const stream = file.createReadStream()
    stream.pipe(res)
  }
}

function setupIPCHandlers(): void {
  // Start torrent from magnet or file path
  ipcMain.handle('torrent:start', async (_event, magnetOrPath: string) => {
    return new Promise((resolve, reject) => {
      if (!magnetOrPath || typeof magnetOrPath !== 'string' || magnetOrPath.trim() === '') {
        reject(new Error('Invalid magnet link or torrent path'))
        return
      }

      if (!client) {
        reject(new Error('Torrent client not initialized'))
        return
      }

      // Remove existing torrent if any
      if (currentTorrent) {
        stopSlidingWindow()
        client.remove(currentTorrent.infoHash, {}, () => {
          console.log('Previous torrent removed')
        })
        currentTorrent = null
        currentFile = null
      }

      // Handle base64 encoded torrent file
      let torrentInput: string | Buffer = magnetOrPath
      if (magnetOrPath.startsWith('data:application/x-bittorrent;base64,')) {
        const base64Data = magnetOrPath.replace('data:application/x-bittorrent;base64,', '')
        torrentInput = Buffer.from(base64Data, 'base64')
        console.log('Adding torrent from base64 buffer')
      } else {
        console.log('Adding torrent:', magnetOrPath.substring(0, 100))
      }

      client.add(
        torrentInput,
        {
          store: memoryStore
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (torrent: any) => {
          currentTorrent = torrent
          console.log('Torrent added:', torrent.name)
          console.log('Files:', torrent.files.length)

          // Handle torrent-specific errors
          torrent.on('error', (err: Error) => {
            console.error('Torrent-specific error:', err)
          })

          // Find the largest video file
          const videoExtensions = ['.mp4', '.mkv', '.avi', '.webm', '.mov', '.m4v', '.flv', '.wmv', '.ts', '.m2ts']
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let videoFile = torrent.files.reduce((largest: any, file: any) => {
            const isVideo = videoExtensions.some((ext) =>
              file.name.toLowerCase().endsWith(ext)
            )
            if (isVideo && file.length > (largest?.length || 0)) {
              return file
            }
            return largest
          }, null)

          // If no video found, use the largest file
          if (!videoFile) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            videoFile = torrent.files.reduce((largest: any, file: any) => {
              return file.length > (largest?.length || 0) ? file : largest
            }, torrent.files[0])
          }

          if (!videoFile) {
            reject(new Error('No suitable file found in torrent'))
            return
          }

          currentFile = videoFile
          console.log('Selected file:', videoFile.name, 'Size:', videoFile.length)

          // Deselect all files first
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          torrent.files.forEach((f: any) => f.deselect())

          // Select only the video file with high priority for first pieces
          videoFile.select()

          // Start sliding window logic
          startSlidingWindow()

          // Start sending status updates
          startStatusUpdates()

          resolve({
            url: `http://localhost:${PORT}/`,
            name: videoFile.name,
            size: videoFile.length,
            infoHash: torrent.infoHash
          })
        }
      )

      // Handle add error (invalid torrent, etc.)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const errorHandler = (err: Error): void => {
        console.error('Client error:', err)
        reject(err)
        client.removeListener('error', errorHandler)
      }
      client.on('error', errorHandler)

      // Timeout after 60 seconds if no torrent added
      setTimeout(() => {
        if (!currentTorrent) {
          client.removeListener('error', errorHandler)
          reject(new Error('Timeout: Could not connect to torrent'))
        }
      }, 60000)
    })
  })

  // Update playback position for sliding window
  ipcMain.on('torrent:update-playback', (_event, time: number) => {
    currentPlaybackTime = time
  })

  // Stop torrent
  ipcMain.handle('torrent:stop', async () => {
    if (currentTorrent && client) {
      stopSlidingWindow()
      return new Promise<void>((resolve) => {
        client!.remove(currentTorrent!.infoHash, {}, () => {
          currentTorrent = null
          currentFile = null
          currentPlaybackTime = 0
          resolve()
        })
      })
    }
  })

  // Get torrent info
  ipcMain.handle('torrent:get-info', async () => {
    if (!currentTorrent || !currentFile) {
      return null
    }

    return {
      name: currentFile.name,
      size: currentFile.length,
      downloaded: currentTorrent.downloaded,
      downloadSpeed: currentTorrent.downloadSpeed,
      uploadSpeed: currentTorrent.uploadSpeed,
      progress: currentFile.progress,
      numPeers: currentTorrent.numPeers,
      infoHash: currentTorrent.infoHash
    }
  })
}

function startSlidingWindow(): void {
  if (slidingWindowInterval) {
    clearInterval(slidingWindowInterval)
  }

  slidingWindowInterval = setInterval(() => {
    if (!currentTorrent || !currentFile) return

    const torrent = currentTorrent
    const file = currentFile

    // Calculate piece info
    const pieceLength = torrent.pieceLength
    const totalPieces = torrent.pieces.length

    // Calculate current piece based on playback position
    // Estimate: assume ~1MB/second for video bitrate calculation
    const bytesPerSecond = 500000 // ~4Mbps bitrate estimate
    const currentByte = Math.floor(currentPlaybackTime * bytesPerSecond)
    const currentPiece = Math.floor(currentByte / pieceLength)

    // Define sliding window: [currentPiece - 2] to [currentPiece + 15]
    const windowStart = Math.max(0, currentPiece - 2)
    const windowEnd = Math.min(totalPieces - 1, currentPiece + 15)

    // Calculate byte ranges for the file
    const fileOffset = file.offset
    const fileEnd = file.offset + file.length

    // Convert piece indices to file byte ranges
    const startByte = Math.max(fileOffset, windowStart * pieceLength)
    const endByte = Math.min(fileEnd, (windowEnd + 1) * pieceLength)

    // Select pieces within the window (high priority)
    if (startByte < endByte) {
      // Select the window range
      file.select(undefined, undefined, 1) // Keep file selected

      // Prioritize current pieces by creating read streams
      // This signals to WebTorrent which pieces we need
      if (currentPiece >= 0 && currentPiece < totalPieces) {
        torrent.critical(windowStart, windowEnd)
      }
    }

    // Log status periodically
    console.log(
      `Window: pieces ${windowStart}-${windowEnd}, playback: ${currentPlaybackTime.toFixed(1)}s, ` +
        `progress: ${(file.progress * 100).toFixed(1)}%, peers: ${torrent.numPeers}`
    )
  }, 1000)
}

function stopSlidingWindow(): void {
  if (slidingWindowInterval) {
    clearInterval(slidingWindowInterval)
    slidingWindowInterval = null
  }
}

function startStatusUpdates(): void {
  const updateInterval = setInterval(() => {
    if (!currentTorrent || !currentFile) {
      clearInterval(updateInterval)
      return
    }

    const windows = BrowserWindow.getAllWindows()
    if (windows.length > 0) {
      windows[0].webContents.send('torrent:status', {
        downloadSpeed: currentTorrent.downloadSpeed,
        uploadSpeed: currentTorrent.uploadSpeed,
        progress: currentFile.progress,
        numPeers: currentTorrent.numPeers,
        downloaded: currentTorrent.downloaded
      })
    }
  }, 500)
}

export function destroyTorrentEngine(): void {
  stopSlidingWindow()

  if (server) {
    server.close()
    server = null
  }

  if (client) {
    client.destroy()
    client = null
  }
}
