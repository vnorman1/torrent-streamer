import { useState, useEffect, useRef, useCallback } from 'react'

interface VideoPlayerProps {
  src: string
  estimatedDuration: number  // Becsült időtartam másodpercben
  onTimeUpdate?: (currentTime: number) => void
  onSeek?: (seekTime: number) => void
}

function formatTime(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  }
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function VideoPlayer({ src, estimatedDuration, onTimeUpdate, onSeek }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const progressRef = useRef<HTMLDivElement>(null)
  
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [volume, setVolume] = useState(1)
  const [isMuted, setIsMuted] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showControls, setShowControls] = useState(true)
  const [isBuffering, setIsBuffering] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [seekTargetTime, setSeekTargetTime] = useState(0)  // Track target time after seek
  
  // BEST PRACTICE: Track duration changes from props
  const [internalDuration, setInternalDuration] = useState(estimatedDuration)
  
  // Update internal duration when prop changes (e.g., when ffprobe returns actual duration)
  useEffect(() => {
    if (estimatedDuration > 0 && estimatedDuration !== internalDuration) {
      console.log('[VideoPlayer] Duration updated from props:', estimatedDuration, 's')
      setInternalDuration(estimatedDuration)
    }
  }, [estimatedDuration, internalDuration])

  // Use internal duration for display
  const duration = internalDuration

  // When src changes (after seek), keep showing the target time and start playing
  const prevSrcRef = useRef(src)
  useEffect(() => {
    if (prevSrcRef.current !== src) {
      console.log('[VideoPlayer] Source changed, keeping time at:', seekTargetTime)
      prevSrcRef.current = src
      setIsBuffering(true)
      // Keep the current time at the seek target
      setCurrentTime(seekTargetTime)
    }
  }, [src, seekTargetTime])

  // Hide controls after 3 seconds of inactivity
  useEffect(() => {
    let timeout: NodeJS.Timeout
    const resetTimeout = () => {
      setShowControls(true)
      clearTimeout(timeout)
      if (isPlaying) {
        timeout = setTimeout(() => setShowControls(false), 3000)
      }
    }
    
    window.addEventListener('mousemove', resetTimeout)
    return () => {
      window.removeEventListener('mousemove', resetTimeout)
      clearTimeout(timeout)
    }
  }, [isPlaying])

  // Handle time updates - add seekTargetTime since stream starts from 0 after seek
  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current
    if (!video || isDragging) return
    
    // After seeking, the stream starts from 0 but we need to show correct total time
    const actualTime = seekTargetTime + video.currentTime
    setCurrentTime(actualTime)
    onTimeUpdate?.(actualTime)
  }, [isDragging, onTimeUpdate, seekTargetTime])

  // Play/Pause toggle
  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    
    if (video.paused) {
      video.play().catch(console.warn)
    } else {
      video.pause()
    }
  }, [])

  // Volume control
  const handleVolumeChange = useCallback((newVolume: number) => {
    const video = videoRef.current
    if (!video) return
    
    video.volume = newVolume
    setVolume(newVolume)
    setIsMuted(newVolume === 0)
  }, [])

  // Mute toggle
  const toggleMute = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    
    video.muted = !video.muted
    setIsMuted(video.muted)
  }, [])

  // Fullscreen toggle
  const toggleFullscreen = useCallback(() => {
    const container = videoRef.current?.parentElement?.parentElement
    if (!container) return
    
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      container.requestFullscreen()
    }
  }, [])

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement)
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  // Seek handling
  const handleSeek = useCallback((seekTime: number) => {
    console.log('[VideoPlayer] Seeking to:', seekTime)
    setCurrentTime(seekTime)
    setSeekTargetTime(seekTime)  // Remember target for when src changes
    setIsBuffering(true)
    
    // Notify parent to restart stream at new position
    onSeek?.(seekTime)
  }, [onSeek])

  // Progress bar click/drag
  const handleProgressClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const bar = progressRef.current
    if (!bar || duration <= 0) return
    
    const rect = bar.getBoundingClientRect()
    const x = e.clientX - rect.left
    const percent = Math.max(0, Math.min(1, x / rect.width))
    const seekTime = percent * duration
    
    handleSeek(seekTime)
  }, [duration, handleSeek])

  // Progress bar drag
  const handleProgressDrag = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDragging) return
    handleProgressClick(e)
  }, [isDragging, handleProgressClick])

  // Skip forward/backward
  const skip = useCallback((seconds: number) => {
    const newTime = Math.max(0, Math.min(duration, currentTime + seconds))
    handleSeek(newTime)
  }, [currentTime, duration, handleSeek])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing in input
      if (e.target instanceof HTMLInputElement) return
      
      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault()
          togglePlay()
          break
        case 'ArrowLeft':
          e.preventDefault()
          skip(-10)
          break
        case 'ArrowRight':
          e.preventDefault()
          skip(10)
          break
        case 'ArrowUp':
          e.preventDefault()
          handleVolumeChange(Math.min(1, volume + 0.1))
          break
        case 'ArrowDown':
          e.preventDefault()
          handleVolumeChange(Math.max(0, volume - 0.1))
          break
        case 'm':
          e.preventDefault()
          toggleMute()
          break
        case 'f':
          e.preventDefault()
          toggleFullscreen()
          break
      }
    }
    
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [togglePlay, skip, handleVolumeChange, volume, toggleMute, toggleFullscreen])

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0

  return (
    <div className="relative w-full h-full bg-black group">
      {/* Video element */}
      <video
        ref={videoRef}
        src={src}
        className="w-full h-full"
        onClick={togglePlay}
        onTimeUpdate={handleTimeUpdate}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onWaiting={() => setIsBuffering(true)}
        onPlaying={() => setIsBuffering(false)}
        onCanPlay={() => setIsBuffering(false)}
        onLoadedMetadata={() => {
          const video = videoRef.current
          if (video) {
            video.volume = volume
            video.muted = isMuted
          }
        }}
        onError={(e) => console.error('Video error:', e)}
        playsInline
        autoPlay
      />

      {/* Buffering indicator */}
      {isBuffering && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/30">
          <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* Play button overlay (when paused) */}
      {!isPlaying && !isBuffering && (
        <div 
          className="absolute inset-0 flex items-center justify-center cursor-pointer"
          onClick={togglePlay}
        >
          <div className="w-20 h-20 rounded-full bg-blue-600/80 flex items-center justify-center hover:bg-blue-500/80 transition-colors">
            <svg className="w-10 h-10 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>
      )}

      {/* Controls overlay */}
      <div 
        className={`absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-4 transition-opacity duration-300 ${
          showControls ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {/* Progress bar */}
        <div 
          ref={progressRef}
          className="relative h-2 bg-zinc-600 rounded-full cursor-pointer mb-4 group/progress"
          onClick={handleProgressClick}
          onMouseDown={() => setIsDragging(true)}
          onMouseUp={() => setIsDragging(false)}
          onMouseLeave={() => setIsDragging(false)}
          onMouseMove={handleProgressDrag}
        >
          {/* Progress fill */}
          <div 
            className="absolute h-full bg-blue-500 rounded-full transition-all"
            style={{ width: `${progressPercent}%` }}
          />
          {/* Progress handle */}
          <div 
            className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white rounded-full shadow-lg opacity-0 group-hover/progress:opacity-100 transition-opacity"
            style={{ left: `calc(${progressPercent}% - 8px)` }}
          />
        </div>

        {/* Control buttons */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            {/* Play/Pause */}
            <button onClick={togglePlay} className="text-white hover:text-blue-400 transition-colors">
              {isPlaying ? (
                <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                </svg>
              ) : (
                <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>

            {/* Skip backward */}
            <button onClick={() => skip(-10)} className="text-white hover:text-blue-400 transition-colors">
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12.5 3C17.15 3 21.08 6.03 22.47 10.22L20.1 11C19.05 7.81 16.04 5.5 12.5 5.5C10.54 5.5 8.77 6.22 7.38 7.38L10 10H3V3L5.6 5.6C7.45 4 9.85 3 12.5 3M10 12V22H8V14H6V12H10M18 14V20C18 21.11 17.11 22 16 22H14C12.9 22 12 21.11 12 20V14C12 12.9 12.9 12 14 12H16C17.11 12 18 12.9 18 14M14 14V20H16V14H14Z" />
              </svg>
            </button>

            {/* Skip forward */}
            <button onClick={() => skip(10)} className="text-white hover:text-blue-400 transition-colors">
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                <path d="M11.5 3C6.85 3 2.92 6.03 1.53 10.22L3.9 11C4.95 7.81 7.96 5.5 11.5 5.5C13.46 5.5 15.23 6.22 16.62 7.38L14 10H21V3L18.4 5.6C16.55 4 14.15 3 11.5 3M10 12V22H8V14H6V12H10M18 14V20C18 21.11 17.11 22 16 22H14C12.9 22 12 21.11 12 20V14C12 12.9 12.9 12 14 12H16C17.11 12 18 12.9 18 14M14 14V20H16V14H14Z" />
              </svg>
            </button>

            {/* Volume */}
            <div className="flex items-center gap-2">
              <button onClick={toggleMute} className="text-white hover:text-blue-400 transition-colors">
                {isMuted || volume === 0 ? (
                  <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                  </svg>
                ) : (
                  <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                  </svg>
                )}
              </button>
              <input
                type="range"
                min="0"
                max="1"
                step="0.1"
                value={volume}
                onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
                className="w-20 h-1 accent-blue-500"
              />
            </div>

            {/* Time display */}
            <span className="text-white text-sm font-mono">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>

          <div className="flex items-center gap-4">
            {/* Fullscreen */}
            <button onClick={toggleFullscreen} className="text-white hover:text-blue-400 transition-colors">
              {isFullscreen ? (
                <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
                </svg>
              ) : (
                <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
