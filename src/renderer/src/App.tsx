import { useState, useEffect, useRef, useCallback } from 'react'
import type { TorrentStatus } from '../../preload/index.d'

// Test magnet - Big Buck Bunny
const TEST_MAGNET = 'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.coppersurfer.tk%3A6969&tr=udp%3A%2F%2Ftracker.empire-js.us%3A1337&tr=udp%3A%2F%2Ftracker.leechers-paradise.org%3A6969&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=wss%3A%2F%2Ftracker.btorrent.xyz&tr=wss%3A%2F%2Ftracker.fastcast.nz&tr=wss%3A%2F%2Ftracker.openwebtorrent.com&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fbig-buck-bunny.torrent'

// Minimum buffer progress before attempting playback
const MIN_BUFFER_PERCENT = 2

function App(): React.JSX.Element {
  const [magnetInput, setMagnetInput] = useState(TEST_MAGNET)
  const [isLoading, setIsLoading] = useState(false)
  const [isBuffering, setIsBuffering] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [currentMovie, setCurrentMovie] = useState<{
    name: string
    infoHash: string
  } | null>(null)
  const [status, setStatus] = useState<TorrentStatus | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [canPlayVideo, setCanPlayVideo] = useState(false)
  const [isVideoStarted, setIsVideoStarted] = useState(false) // User clicked play
  const [isVideoReady, setIsVideoReady] = useState(false) // Video loaded and ready

  const videoRef = useRef<HTMLVideoElement>(null)

  // Subscribe to torrent status updates
  useEffect(() => {
    if (!window.api?.torrent?.onStatus) {
      console.error('Torrent API not available')
      return
    }
    const unsubscribe = window.api.torrent.onStatus((data) => {
      setStatus(data)
      
      // Once we have enough buffer, enable video playback
      const progressPercent = data.progress * 100
      
      if (progressPercent >= MIN_BUFFER_PERCENT) {
        setCanPlayVideo(true)
      }
    })
    return unsubscribe
  }, []) // Remove canPlayVideo dependency - we use setCanPlayVideo which always has latest state

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
  }

  const startStream = useCallback(async (magnetOrPath: string): Promise<void> => {
    setIsLoading(true)
    setIsBuffering(true)
    setCanPlayVideo(false)
    setIsVideoStarted(false)
    setIsVideoReady(false)
    setError(null)

    try {
      const result = await window.api.torrent.start(magnetOrPath)
      console.log('Stream started:', result)
      setVideoUrl(result.url)
      setCurrentMovie({
        name: result.name,
        infoHash: result.infoHash
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start stream')
      console.error('Stream error:', err)
      setIsBuffering(false)
    } finally {
      setIsLoading(false)
    }
  }, [])

  const handlePlay = (): void => {
    if (magnetInput.trim()) {
      startStream(magnetInput.trim())
    }
  }

  const handleTimeUpdate = (): void => {
    if (!videoRef.current || !currentMovie) return

    const currentTime = videoRef.current.currentTime

    // Send playback position to main process for sliding window
    window.api.torrent.updatePlayback(currentTime)
  }

  const handleDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setIsDragging(false)

    const files = e.dataTransfer.files
    if (files.length > 0) {
      const file = files[0]
      if (file.name.endsWith('.torrent')) {
        // Get file path from Electron's File object
        const electronFile = file as File & { path?: string }
        const filePath = electronFile.path
        console.log('Dropped torrent file:', file.name, 'Path:', filePath)
        if (filePath) {
          startStream(filePath)
        } else {
          // Fallback: read file as buffer
          const reader = new FileReader()
          reader.onload = () => {
            const buffer = reader.result as ArrayBuffer
            const uint8 = new Uint8Array(buffer)
            // Convert to base64 for transfer
            const base64 = btoa(String.fromCharCode(...uint8))
            startStream(`data:application/x-bittorrent;base64,${base64}`)
          }
          reader.readAsArrayBuffer(file)
        }
      } else {
        setError('Please drop a .torrent file')
      }
    }
  }

  const handleDragOver = (e: React.DragEvent): void => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = (): void => {
    setIsDragging(false)
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-white p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-white">
            Peer<span className="text-blue-500">.</span> Desktop
          </h1>
          <p className="text-zinc-400 mt-1">P2P Streaming Client</p>
        </header>

        {/* Input Section */}
        <div
          className={`mb-6 p-6 rounded-xl border-2 border-dashed transition-colors ${
            isDragging
              ? 'border-blue-500 bg-blue-500/10'
              : 'border-zinc-700 bg-zinc-900/50'
          }`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          <div className="flex gap-4">
            <input
              type="text"
              value={magnetInput}
              onChange={(e) => setMagnetInput(e.target.value)}
              placeholder="Paste magnet link here..."
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-3 text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500 transition-colors"
              onKeyDown={(e) => e.key === 'Enter' && handlePlay()}
            />
            <button
              onClick={handlePlay}
              disabled={isLoading || !magnetInput.trim()}
              className="px-8 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-zinc-700 disabled:cursor-not-allowed rounded-lg font-semibold transition-colors"
            >
              {isLoading ? 'Loading...' : 'Play'}
            </button>
          </div>
          <p className="text-zinc-500 text-sm mt-3 text-center">
            Or drag and drop a <span className="text-zinc-400">.torrent</span> file here
          </p>
        </div>

        {/* Error Message */}
        {error && (
          <div className="mb-6 p-4 bg-red-900/30 border border-red-700 rounded-lg text-red-300">
            {error}
          </div>
        )}

        {/* Video Player */}
        <div className="mb-6 rounded-xl overflow-hidden bg-black aspect-video relative">
          {/* Buffering overlay during playback */}
          {isBuffering && videoUrl && isVideoStarted && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-10">
              <div className="animate-spin w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full"></div>
            </div>
          )}
          
          {/* Video ready - waiting for user to click play */}
          {videoUrl && canPlayVideo && !isVideoStarted && (
            <div className="w-full h-full flex items-center justify-center bg-zinc-900 relative">
              {/* Background video preview (muted) */}
              <video
                src={videoUrl}
                muted
                preload="metadata"
                className="absolute inset-0 w-full h-full object-contain opacity-30"
              />
              {/* Big Play Button */}
              <button
                onClick={() => {
                  setIsVideoStarted(true)
                  // Video will be shown and play() called with audio
                }}
                className="relative z-10 group cursor-pointer"
              >
                <div className="w-32 h-32 rounded-full bg-blue-600 hover:bg-blue-500 flex items-center justify-center shadow-2xl transition-all group-hover:scale-110">
                  <svg className="w-16 h-16 text-white ml-2" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z"/>
                  </svg>
                </div>
                <p className="text-white text-xl font-semibold mt-6 text-center">Click to Play</p>
                <p className="text-zinc-400 text-sm mt-1 text-center">with audio</p>
              </button>
            </div>
          )}

          {/* Video playing */}
          {videoUrl && canPlayVideo && isVideoStarted ? (
            <video
              ref={videoRef}
              src={videoUrl}
              controls
              playsInline
              preload="auto"
              onTimeUpdate={handleTimeUpdate}
              onError={(e) => {
                const video = e.currentTarget
                console.error('Video error:', video.error?.message, video.error?.code)
                setError(`Video playback error: ${video.error?.message || 'Unknown error'}`)
              }}
              onLoadStart={() => {
                console.log('Video load started')
                setIsBuffering(true)
              }}
              onLoadedMetadata={() => {
                console.log('Video metadata loaded')
                setIsVideoReady(true)
              }}
              onCanPlay={() => {
                console.log('Video can play')
                setIsBuffering(false)
                // User initiated playback - this WILL have audio!
                if (videoRef.current) {
                  videoRef.current.muted = false
                  videoRef.current.volume = 1.0
                  videoRef.current.play().then(() => {
                    console.log('Playing with audio!')
                  }).catch((err) => console.warn('Play failed:', err))
                }
              }}
              onWaiting={() => {
                console.log('Video waiting for data...')
                setIsBuffering(true)
              }}
              onPlaying={() => {
                console.log('Video playing')
                setIsBuffering(false)
              }}
              onStalled={() => console.log('Video stalled')}
              className="w-full h-full"
            />
          ) : videoUrl && !canPlayVideo ? (
            // Buffering state - waiting for enough data
            <div className="w-full h-full flex items-center justify-center text-zinc-400 bg-zinc-900">
              <div className="text-center">
                <div className="animate-spin w-16 h-16 mx-auto mb-4 border-4 border-blue-500 border-t-transparent rounded-full"></div>
                <p className="text-lg font-semibold mb-2">Buffering...</p>
                <p className="text-sm">
                  {status ? `${(status.progress * 100).toFixed(1)}% - ${formatBytes(status.downloadSpeed)}/s` : 'Connecting to peers...'}
                </p>
                {status && (
                  <p className="text-xs text-zinc-500 mt-2">
                    {status.numPeers} peers connected
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="w-full h-full flex items-center justify-center text-zinc-600">
              <div className="text-center">
                <svg
                  className="w-16 h-16 mx-auto mb-4 opacity-50"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <p>Enter a magnet link to start streaming</p>
              </div>
            </div>
          )}
        </div>

        {/* Status Bar */}
        {status && videoUrl && (
          <div className="p-4 bg-zinc-900 rounded-lg">
            <div className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-6">
                <span className="text-zinc-400">
                  <span className="text-green-500">↓</span> {formatBytes(status.downloadSpeed)}/s
                </span>
                <span className="text-zinc-400">
                  <span className="text-blue-500">↑</span> {formatBytes(status.uploadSpeed)}/s
                </span>
                <span className="text-zinc-400">
                  Peers: <span className="text-white">{status.numPeers}</span>
                </span>
              </div>
              <div className="flex items-center gap-4">
                {/* Quality tier badge */}
                {status.qualityTier && status.qualityTier !== 'unknown' && (
                  <span className={`px-2 py-0.5 rounded text-xs font-bold ${
                    status.qualityTier === '4K' ? 'bg-purple-600 text-white' :
                    status.qualityTier === '1080p_high' ? 'bg-blue-600 text-white' :
                    status.qualityTier === '1080p' ? 'bg-green-600 text-white' :
                    'bg-zinc-600 text-white'
                  }`}>
                    {status.qualityTier === '1080p_high' ? '1080p+' : status.qualityTier}
                  </span>
                )}
                {/* Show buffer ahead in seconds */}
                <span className="text-zinc-400">
                  Buffer: <span className="text-white">
                    {status.bufferedAheadSeconds !== undefined 
                      ? `${Math.floor(status.bufferedAheadSeconds)}s ahead`
                      : `${(status.progress * 100).toFixed(1)}%`}
                  </span>
                </span>
                {/* Show buffer size in MB */}
                {status.bufferSizeMB !== undefined && (
                  <span className="text-zinc-400">
                    RAM: <span className="text-white">{status.bufferSizeMB.toFixed(1)} MB / 70 MB</span>
                  </span>
                )}
                <span className="text-zinc-400">
                  {formatBytes(status.downloaded)} downloaded
                </span>
              </div>
            </div>
            {currentMovie && (
              <p className="text-zinc-500 text-sm mt-2 truncate">
                Playing: {currentMovie.name}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default App
