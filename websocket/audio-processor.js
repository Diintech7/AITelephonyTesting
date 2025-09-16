const EventEmitter = require("events")

class AudioProcessor extends EventEmitter {
  constructor() {
    super()
    this.sampleRate = 44100
    this.channels = 1
    this.bitDepth = 16
    this.bufferSize = 1024
    this.audioQueue = []
  }

  // Convert base64 audio to PCM buffer
  base64ToPCM(base64Audio) {
    try {
      const buffer = Buffer.from(base64Audio, "base64")
      return this.convertToLinear16(buffer)
    } catch (error) {
      console.error("❌ [AUDIO] Base64 conversion error:", error)
      return null
    }
  }

  // Convert audio buffer to LINEAR16 format for Deepgram
  convertToLinear16(buffer) {
    // Ensure buffer is in correct format for Deepgram
    // LINEAR16 = 16-bit signed little-endian PCM
    if (buffer.length % 2 !== 0) {
      // Pad buffer if odd length
      const paddedBuffer = Buffer.alloc(buffer.length + 1)
      buffer.copy(paddedBuffer)
      return paddedBuffer
    }
    return buffer
  }

  // Convert PCM buffer to base64 for transmission
  pcmToBase64(pcmBuffer) {
    try {
      return pcmBuffer.toString("base64")
    } catch (error) {
      console.error("❌ [AUDIO] PCM to base64 conversion error:", error)
      return null
    }
  }

  // Apply audio processing for better quality
  processAudioBuffer(buffer) {
    // Apply noise reduction and normalization
    const processedBuffer = this.normalizeAudio(buffer)
    return this.applyNoiseReduction(processedBuffer)
  }

  // Normalize audio levels
  normalizeAudio(buffer) {
    if (buffer.length < 2) return buffer

    const samples = []
    for (let i = 0; i < buffer.length; i += 2) {
      const sample = buffer.readInt16LE(i)
      samples.push(sample)
    }

    // Find peak amplitude
    const peak = Math.max(...samples.map(Math.abs))
    if (peak === 0) return buffer

    // Normalize to 80% of max amplitude to prevent clipping
    const normalizedBuffer = Buffer.alloc(buffer.length)
    const targetPeak = 32767 * 0.8
    const gain = targetPeak / peak

    for (let i = 0; i < samples.length; i++) {
      const normalizedSample = Math.round(samples[i] * gain)
      const clampedSample = Math.max(-32768, Math.min(32767, normalizedSample))
      normalizedBuffer.writeInt16LE(clampedSample, i * 2)
    }

    return normalizedBuffer
  }

  // Simple noise reduction
  applyNoiseReduction(buffer) {
    if (buffer.length < 6) return buffer

    const processedBuffer = Buffer.alloc(buffer.length)

    // Copy first and last samples as-is
    buffer.copy(processedBuffer, 0, 0, 2)
    buffer.copy(processedBuffer, buffer.length - 2, buffer.length - 2)

    // Apply simple moving average filter
    for (let i = 2; i < buffer.length - 2; i += 2) {
      const prev = buffer.readInt16LE(i - 2)
      const curr = buffer.readInt16LE(i)
      const next = buffer.readInt16LE(i + 2)

      // Simple 3-point moving average
      const filtered = Math.round((prev + curr * 2 + next) / 4)
      const clamped = Math.max(-32768, Math.min(32767, filtered))

      processedBuffer.writeInt16LE(clamped, i)
    }

    return processedBuffer
  }

  // Buffer audio chunks for processing - optimized for low latency
  bufferAudio(audioData) {
    this.audioQueue.push(audioData)

    // Reduced buffer size for lower latency (from 5 to 3 chunks)
    if (this.audioQueue.length >= 3) {
      const combinedBuffer = Buffer.concat(this.audioQueue)
      this.audioQueue = []

      const processedBuffer = this.processAudioBuffer(combinedBuffer)
      this.emit("audioProcessed", processedBuffer)
    }
  }

  // Low-latency audio processing for real-time applications
  processLowLatencyAudio(audioData) {
    try {
      // Skip buffering for immediate processing
      const processedBuffer = this.processAudioBuffer(audioData)
      this.emit("audioProcessed", processedBuffer)
      return processedBuffer
    } catch (error) {
      console.error("❌ [AUDIO] Low-latency processing error:", error)
      return audioData // Return original on error
    }
  }

  // Get audio format info
  getAudioFormat() {
    return {
      encoding: "LINEAR16",
      sampleRate: this.sampleRate,
      channels: this.channels,
      bitDepth: this.bitDepth,
    }
  }

  // Calculate latency metrics
  calculateLatency(startTime) {
    const endTime = Date.now()
    const latency = endTime - startTime

    return {
      latency,
      isLowLatency: latency < 100, // Target < 100ms
      quality: latency < 50 ? "excellent" : latency < 100 ? "good" : latency < 200 ? "fair" : "poor",
    }
  }
}

module.exports = AudioProcessor
