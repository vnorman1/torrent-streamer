import { useState, useEffect, useRef } from 'react'
import type { TorrentStatus } from '../../../preload/index.d'

interface DebugModalProps {
  isOpen: boolean
  onClose: () => void
}

interface LogEntry {
  time: string
  message: string
  type: 'info' | 'warning' | 'error'
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

function formatSpeed(bytesPerSec: number): string {
  return formatBytes(bytesPerSec) + '/s'
}

function formatTime(seconds: number): string {
  if (seconds < 60) return Math.round(seconds) + 's'
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + Math.round(seconds % 60) + 's'
  return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm'
}

function getTimeString(): string {
  const now = new Date()
  return now.toLocaleTimeString('en-US', { hour12: false })
}

export default function DebugModal({ isOpen, onClose }: DebugModalProps) {
  const [stats, setStats] = useState<TorrentStatus | null>(null)
  const [processMemory, setProcessMemory] = useState<number>(0)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [lastDownloaded, setLastDownloaded] = useState<number>(0)
  const [realDownloadSpeed, setRealDownloadSpeed] = useState<number>(0)
  const logsEndRef = useRef<HTMLDivElement>(null)

  const addLog = (message: string, type: LogEntry['type'] = 'info') => {
    setLogs(prev => {
      const newLogs = [...prev, { time: getTimeString(), message, type }]
      // Keep only last 100 logs
      return newLogs.slice(-100)
    })
  }

  useEffect(() => {
    if (!isOpen) return

    addLog('Debug Modal opened', 'info')

    // Listen for status updates
    const unsubscribe = window.api.torrent.onStatus((status: TorrentStatus) => {
      setStats(prev => {
        // Calculate real download speed based on downloaded delta
        if (prev && status.downloaded !== prev.downloaded) {
          const delta = status.downloaded - prev.downloaded
          setRealDownloadSpeed(delta * 2) // multiply by 2 because updates are every 500ms
          
          // Log significant events
          if (status.paused && !prev.paused) {
            addLog('⏸️ Download PAUSED - buffer full', 'warning')
          } else if (!status.paused && prev.paused) {
            addLog('▶️ Download RESUMED', 'info')
          }
          
          // Log buffer warnings
          if ((status.bufferSizeMB ?? 0) > 65 && (prev.bufferSizeMB ?? 0) <= 65) {
            addLog('⚠️ Buffer near limit: ' + (status.bufferSizeMB ?? 0).toFixed(1) + 'MB', 'warning')
          }
        }
        
        return status
      })
      
      // Track last downloaded
      if (status.downloaded !== lastDownloaded) {
        setLastDownloaded(status.downloaded)
      }
    })

    // Poll process memory usage
    const memoryInterval = setInterval(() => {
      if ((performance as any).memory) {
        const mem = (performance as any).memory.usedJSHeapSize
        setProcessMemory(mem)
        
        // Log memory warnings
        if (mem > 200 * 1024 * 1024) { // Over 200MB
          addLog('⚠️ High JS heap: ' + formatBytes(mem), 'warning')
        }
      }
    }, 2000)

    // Log initial state
    setTimeout(() => {
      addLog('Monitoring started...', 'info')
    }, 100)

    return () => {
      unsubscribe()
      clearInterval(memoryInterval)
    }
  }, [isOpen])

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700 bg-zinc-800">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <span className="text-green-400">⚡</span>
            Debug Statistics
          </h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-zinc-700 rounded-lg transition-colors text-zinc-400 hover:text-white"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-3 max-h-[60vh] overflow-y-auto">
          {stats ? (
            <>
              {/* Buffer Section */}
              <div className="bg-zinc-800 rounded-lg p-3 space-y-2">
                <h3 className="text-sm font-medium text-zinc-400 uppercase tracking-wide">Buffer</h3>
                <div className="grid grid-cols-2 gap-2">
                  <StatItem 
                    label="RAM Buffer" 
                    value={`${(stats.bufferSizeMB ?? 0).toFixed(1)} / 70 MB`}
                    color={(stats.bufferSizeMB ?? 0) > 60 ? 'text-green-400' : (stats.bufferSizeMB ?? 0) > 30 ? 'text-yellow-400' : 'text-red-400'}
                  />
                  <StatItem 
                    label="Ahead" 
                    value={formatTime(stats.bufferedAheadSeconds || 0)}
                    color="text-blue-400"
                  />
                  <StatItem 
                    label="Quality" 
                    value={stats.qualityTier || 'N/A'}
                    color="text-purple-400"
                  />
                  <StatItem 
                    label="Status" 
                    value={stats.paused ? '⏸️ PAUSED' : '▶️ ACTIVE'}
                    color={stats.paused ? 'text-yellow-400' : 'text-green-400'}
                  />
                </div>
                {/* Buffer Bar */}
                <div className="mt-2">
                  <div className="h-2 bg-zinc-700 rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-gradient-to-r from-green-500 to-emerald-400 transition-all duration-300"
                      style={{ width: `${Math.min(100, ((stats.bufferSizeMB || 0) / 70) * 100)}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-xs text-zinc-500 mt-1">
                    <span>0 MB</span>
                    <span>70 MB limit</span>
                  </div>
                </div>
              </div>

              {/* Network Section */}
              <div className="bg-zinc-800 rounded-lg p-3 space-y-2">
                <h3 className="text-sm font-medium text-zinc-400 uppercase tracking-wide">Network</h3>
                <div className="grid grid-cols-2 gap-2">
                  <StatItem 
                    label="Download" 
                    value={formatSpeed(stats.downloadSpeed || 0)}
                    color="text-green-400"
                    icon="↓"
                  />
                  <StatItem 
                    label="Real Speed" 
                    value={formatSpeed(realDownloadSpeed)}
                    color="text-emerald-400"
                    icon="📊"
                  />
                  <StatItem 
                    label="Peers" 
                    value={String(stats.numPeers || 0)}
                    color="text-orange-400"
                    icon="👥"
                  />
                  <StatItem 
                    label="Upload" 
                    value={formatSpeed(stats.uploadSpeed || 0)}
                    color="text-blue-400"
                    icon="↑"
                  />
                </div>
              </div>

              {/* Memory Section */}
              <div className="bg-zinc-800 rounded-lg p-3 space-y-2">
                <h3 className="text-sm font-medium text-zinc-400 uppercase tracking-wide">Memory Analysis</h3>
                <div className="grid grid-cols-2 gap-2">
                  <StatItem 
                    label="Total Downloaded" 
                    value={formatBytes(stats.downloaded || 0)}
                    color="text-zinc-300"
                  />
                  <StatItem 
                    label="In RAM Buffer" 
                    value={`${(stats.bufferSizeMB || 0).toFixed(1)} MB`}
                    color="text-green-400"
                  />
                  <StatItem 
                    label="Discarded" 
                    value={formatBytes(Math.max(0, (stats.downloaded || 0) - (stats.bufferSizeMB || 0) * 1024 * 1024))}
                    color="text-red-400"
                  />
                  {processMemory > 0 && (
                    <StatItem 
                      label="JS Heap" 
                      value={formatBytes(processMemory)}
                      color={processMemory > 150 * 1024 * 1024 ? 'text-red-400' : 'text-yellow-400'}
                    />
                  )}
                </div>
              </div>

              {/* Transcoding Section */}
              <div className="bg-zinc-800 rounded-lg p-3">
                <div className="flex items-center gap-3">
                  <span className={`text-2xl ${stats.transcoded ? 'text-green-400' : 'text-zinc-500'}`}>
                    {stats.transcoded ? '🔄' : '📺'}
                  </span>
                  <div className="flex-1">
                    <p className={`font-medium ${stats.transcoded ? 'text-green-400' : 'text-zinc-300'}`}>
                      {stats.transcoded ? 'FFmpeg Active' : 'Direct Streaming'}
                    </p>
                    <p className="text-xs text-zinc-500">
                      {stats.transcoded ? 'Video: copy • Audio: AAC • Container: MP4' : 'No transcoding needed'}
                    </p>
                  </div>
                  <div className="text-right">
                    <span className="text-xs text-zinc-400">Progress</span>
                    <p className="font-mono text-white">{((stats.progress || 0) * 100).toFixed(1)}%</p>
                  </div>
                </div>
              </div>

              {/* Logs Section */}
              <div className="bg-zinc-800 rounded-lg p-3 space-y-2">
                <h3 className="text-sm font-medium text-zinc-400 uppercase tracking-wide flex items-center gap-2">
                  📋 Activity Log
                  <span className="text-xs font-normal text-zinc-500">({logs.length})</span>
                </h3>
                <div className="bg-black/30 rounded p-2 h-24 overflow-y-auto font-mono text-xs">
                  {logs.length === 0 ? (
                    <p className="text-zinc-500">No activity yet...</p>
                  ) : (
                    logs.map((log, i) => (
                      <div key={i} className={`${
                        log.type === 'error' ? 'text-red-400' : 
                        log.type === 'warning' ? 'text-yellow-400' : 
                        'text-zinc-400'
                      }`}>
                        <span className="text-zinc-600">[{log.time}]</span> {log.message}
                      </div>
                    ))
                  )}
                  <div ref={logsEndRef} />
                </div>
              </div>
            </>
          ) : (
            <div className="text-center py-8 text-zinc-500">
              <p>No torrent loaded</p>
              <p className="text-sm mt-1">Load a torrent to see statistics</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-zinc-700 bg-zinc-800/50">
          <p className="text-xs text-zinc-500 text-center">
            Buffer: 70MB max • Updates: 500ms • Logs: last 100
          </p>
        </div>
      </div>
    </div>
  )
}

interface StatItemProps {
  label: string
  value: string
  color?: string
  icon?: string
}

function StatItem({ label, value, color = 'text-white', icon }: StatItemProps) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-zinc-500">{label}</span>
      <span className={`font-mono font-medium ${color}`}>
        {icon && <span className="mr-1">{icon}</span>}
        {value}
      </span>
    </div>
  )
}
