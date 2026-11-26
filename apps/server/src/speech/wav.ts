import { readFileSync } from 'node:fs'

/** Reads a WAV file and returns its PCM data, checking it is what G2 sends: s16le, 16 kHz, mono. */
export function readPcmWav(path: string): Buffer {
  const buf = readFileSync(path)
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${path} is not a WAV file`)
  let offset = 12
  let format: { audioFormat: number; channels: number; sampleRate: number; bits: number } | undefined
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      format = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      if (!format) throw new Error(`${path}: data chunk before fmt chunk`)
      const { audioFormat, channels, sampleRate, bits } = format
      if (audioFormat !== 1 || channels !== 1 || sampleRate !== 16000 || bits !== 16) {
        throw new Error(
          `${path} must be 16-bit PCM, 16 kHz, mono (got format ${audioFormat}, ${channels} ch, ${sampleRate} Hz, ${bits} bit). ` +
            'Convert with: sox in.wav -r 16000 -c 1 -b 16 -e signed-integer out.wav',
        )
      }
      return buf.subarray(body, body + Math.min(size, buf.length - body))
    }
    offset = body + size + (size % 2)
  }
  throw new Error(`${path} has no data chunk`)
}
