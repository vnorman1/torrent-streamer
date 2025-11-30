declare module 'memory-chunk-store' {
  interface ChunkStore {
    new (chunkLength: number): ChunkStore
    put(index: number, buffer: Buffer, cb?: (err?: Error) => void): void
    get(index: number, opts: { offset?: number; length?: number }, cb: (err: Error | null, buffer?: Buffer) => void): void
    close(cb?: (err?: Error) => void): void
    destroy(cb?: (err?: Error) => void): void
  }
  
  const memoryChunkStore: ChunkStore
  export = memoryChunkStore
}
