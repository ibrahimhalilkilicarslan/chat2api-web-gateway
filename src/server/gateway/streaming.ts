import { Readable } from 'node:stream'

export interface PrimedStream {
  stream: Readable
  firstChunk: Buffer
}

export async function primeStream(
  stream: NodeJS.ReadableStream,
  timeoutMs: number,
): Promise<PrimedStream> {
  const readable = stream as Readable
  readable.pause()

  return new Promise<PrimedStream>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      readable.destroy(new Error('Upstream first-byte timeout'))
      reject(new Error('Upstream first-byte timeout'))
    }, timeoutMs)
    timeout.unref()

    const cleanup = () => {
      clearTimeout(timeout)
      readable.off('data', onData)
      readable.off('error', onError)
      readable.off('end', onEnd)
    }
    const onData = (chunk: Buffer | string) => {
      readable.pause()
      cleanup()
      resolve({
        stream: readable,
        firstChunk: Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      })
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onEnd = () => {
      cleanup()
      reject(new Error('Upstream stream ended before producing data'))
    }

    readable.once('data', onData)
    readable.once('error', onError)
    readable.once('end', onEnd)
    readable.resume()
  })
}
