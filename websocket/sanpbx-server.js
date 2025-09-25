const WebSocket = require("ws")
require("dotenv").config()

const fetch = globalThis.fetch || require("node-fetch")

const API_KEYS = {
  deepgram: process.env.DEEPGRAM_API_KEY,
  sarvam: process.env.SARVAM_API_KEY,
  openai: process.env.OPENAI_API_KEY,
  elevenlabs: process.env.ELEVEN_API_KEY || process.env.ELEVENLABS_API_KEY,
}

if (!API_KEYS.deepgram || !API_KEYS.sarvam || !API_KEYS.openai) {
  console.error("Missing required API keys: DEEPGRAM_API_KEY, SARVAM_API_KEY, OPENAI_API_KEY")
  process.exit(1)
}

const STATIC = {
  language: "en",
  deepgramLanguage: "en",
  sarvamLanguage: "en-IN",
  sarvamVoice: "pavithra",
  systemPrompt: [
    "You are a concise, helpful voice assistant.",
    "Answer only with brief, friendly sentences.",
    "If you don't know, say so briefly.",
    "End with a short, relevant follow-up question.",
  ].join(" "),
  firstMessage: "Hello! How can I help you today?",
}

// ElevenLabs configuration (voice and model)
const ELEVEN_CONFIG = {
  voiceId: process.env.ELEVEN_VOICE_ID || "Xb7hH8MSUJpSbSDYk0k2", // default example voice id
  modelId: process.env.ELEVEN_MODEL_ID || "eleven_flash_v2_5",
  inactivityTimeout: 180, // seconds
}

// Latency optimization constants
const LATENCY_CONFIG = {
  INTERIM_MIN_WORDS: 1,           // Minimum words to trigger interim processing
  INTERIM_DEBOUNCE_MS: 100,       // Further reduced for faster response
  CONFIDENCE_THRESHOLD: 0.6,       // Lower confidence threshold for faster processing
  WORD_ACCUMULATION_MS: 150,      // Reduced time to accumulate words
  TTS_MIN_CHARS: 3,              // Further reduced for faster TTS
  TTS_DEBOUNCE_MS: 80,           // Much faster debounce
  SILENCE_DETECTION_MS: 200,      // Faster silence detection
}

// Timestamp helper with milliseconds
const ts = () => new Date().toISOString()

const extractPcmLinear16Mono8kBase64 = (audioBase64) => {
  try {
    const buf = Buffer.from(audioBase64, 'base64')
    if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
      let offset = 12
      let dataOffset = null
      let dataSize = null
      while (offset + 8 <= buf.length) {
        const chunkId = buf.toString('ascii', offset, offset + 4)
        const chunkSize = buf.readUInt32LE(offset + 4)
        const next = offset + 8 + chunkSize
        if (chunkId === 'data') {
          dataOffset = offset + 8
          dataSize = chunkSize
          break
        }
        offset = next
      }
      if (dataOffset != null && dataSize != null) {
        return buf.slice(dataOffset, dataOffset + dataSize).toString('base64')
      }
    }
    return audioBase64
  } catch (_) {
    return audioBase64
  }
}

// Downsample raw PCM 16-bit mono from 16kHz to 8kHz by simple decimation (every 2nd sample)
const downsamplePcm16kTo8kBase64 = (pcm16kBase64) => {
  const start = Date.now()
  try {
    const src = Buffer.from(pcm16kBase64, 'base64')
    const samples = Math.floor(src.length / 2)
    if (samples <= 0) return pcm16kBase64
    const dst = Buffer.alloc(Math.floor(src.length / 2))
    // Copy every other 16-bit sample (little-endian)
    let di = 0
    for (let si = 0; si < samples; si += 2) {
      const byteIndex = si * 2
      if (byteIndex + 1 < src.length && di + 1 < dst.length) {
        dst[di++] = src[byteIndex]
        dst[di++] = src[byteIndex + 1]
      }
    }
    const res = dst.toString('base64')
    const ms = Date.now() - start
    console.log(`[${ts()}] [RESAMPLE] from_16k_to_8k_ms=${ms} in_bytes=${src.length} out_bytes=${dst.length}`)
    return res
  } catch (e) {
    console.log(`[${ts()}] [RESAMPLE] error ${e.message}`)
    console.log(pcm16kBase64)
    return pcm16kBase64
  }
}

// Downsample raw PCM 16-bit mono from 16kHz to 8kHz with simple low-pass prefilter to reduce aliasing
const downsamplePcm16kTo8k = (pcm16kBuf) => {
  const start = Date.now()
  try {
    // Ensure even number of bytes
    const byteLen = pcm16kBuf.length - (pcm16kBuf.length % 2)
    if (byteLen <= 0) return pcm16kBuf
    const srcView = new Int16Array(pcm16kBuf.buffer, pcm16kBuf.byteOffset, byteLen / 2)

    // FIR low-pass prefilter: h = [1, 2, 2, 1] / 6 (simple halfband-ish)
    // Then decimate by 2
    const dstSamples = Math.floor(srcView.length / 2)
    const outView = new Int16Array(dstSamples)

    for (let i = 0, o = 0; o < dstSamples; o++, i += 2) {
      const xm1 = i - 1 >= 0 ? srcView[i - 1] : 0
      const x0 = srcView[i] || 0
      const x1 = i + 1 < srcView.length ? srcView[i + 1] : 0
      const x2 = i + 2 < srcView.length ? srcView[i + 2] : 0
      let y = (xm1 + (x0 << 1) + (x1 << 1) + x2) / 6
      // Clamp to int16
      if (y > 32767) y = 32767
      else if (y < -32768) y = -32768
      outView[o] = y | 0
    }

    const outBuf = Buffer.from(outView.buffer, outView.byteOffset, outView.byteLength)
    const ms = Date.now() - start
    console.log(`[${ts()}] [DOWNSAMPLE] 16k_to_8k_ms=${ms} in_bytes=${byteLen} out_bytes=${outBuf.length}`)
    return outBuf
  } catch (e) {
    console.log(`[${ts()}] [DOWNSAMPLE] error ${e.message}`)
    return pcm16kBuf
  }
}

const streamPcmToSanPBX = async (ws, { streamId, callId, channelId }, pcmBase64, sessionId) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  if (!streamId || !callId || !channelId) return false
  
  const CHUNK_SIZE = 320
  const audioBuffer = Buffer.from(pcmBase64, 'base64')
  const totalBytes = audioBuffer.length
  const totalChunks = Math.ceil(totalBytes / CHUNK_SIZE)
  console.log(`[${ts()}] [SIP-AUDIO-START] session=${sessionId || 'n/a'} format=PCM16 mono sample_rate=8000Hz chunk_bytes=${CHUNK_SIZE} total_bytes=${totalBytes} total_chunks=${totalChunks}`)
  let position = 0
  
  while (position < audioBuffer.length && ws.readyState === WebSocket.OPEN) {
    
    const chunk = audioBuffer.slice(position, position + CHUNK_SIZE)
    const padded = chunk.length < CHUNK_SIZE ? Buffer.concat([chunk, Buffer.alloc(CHUNK_SIZE - chunk.length)]) : chunk
    const message = { event: "reverse-media", payload: padded.toString('base64'), streamId, channelId, callId }

    try { 
      ws.send(JSON.stringify(message)) 
    } catch (_) { 
      return false 
    }
    
    position += CHUNK_SIZE
    if (position < audioBuffer.length) await new Promise(r => setTimeout(r, 20))
    if ((position / CHUNK_SIZE) % 50 === 0) {
      console.log(`[${ts()}] [SIP-AUDIO] sent_chunks=${Math.min(Math.ceil(position/CHUNK_SIZE), totalChunks)}/${totalChunks}`)
    }
  }
  
  // Send silence frames only if session is still valid
  if (!sessionId || ws.currentTTSSession === sessionId) {
    try {
      for (let i = 0; i < 2; i++) { // Reduced from 3
        const silence = Buffer.alloc(CHUNK_SIZE).toString('base64')
        // Debug: log silence base64 payload
        try {  } catch (_) {}
        ws.send(JSON.stringify({ event: "reverse-media", payload: silence, streamId, channelId, callId }))
        await new Promise(r => setTimeout(r, 20))
      }
    } catch (_) {}
  }
  
  console.log(`[${ts()}] [SIP-AUDIO-END] session=${sessionId || 'n/a'} total_bytes=${totalBytes} total_chunks=${totalChunks}`)
  return true
}

// Simple per-connection SIP send queue to ensure sequential audio playback
const ensureSipQueue = (ws) => {
  if (!ws.__sipQueue) {
    ws.__sipQueue = []
    ws.__sipSending = false
  }
}

const processSipQueue = async (ws) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  if (ws.__sipSending) return
  ws.__sipSending = true
  try {
    while (ws.readyState === WebSocket.OPEN && ws.__sipQueue && ws.__sipQueue.length > 0) {
      const item = ws.__sipQueue.shift()
      const { ids, pcmBase64, sessionId, resolve } = item
      let ok = false
      try {
        ok = await streamPcmToSanPBX(ws, ids, pcmBase64, sessionId)
      } catch (_) {}
      try { resolve(ok) } catch (_) {}
      // If cancelled mid-send, continue to next queued item
    }
  } finally {
    ws.__sipSending = false
    // If new items arrived while sending flag was true, loop again
    if (ws.__sipQueue && ws.__sipQueue.length > 0 && ws.readyState === WebSocket.OPEN) {
      setImmediate(() => processSipQueue(ws))
    }
  }
}

const enqueuePcmToSip = (ws, ids, pcmBase64, sessionId) => {
  return new Promise((resolve) => {
    ensureSipQueue(ws)
    ws.__sipQueue.push({ ids, pcmBase64, sessionId, resolve })
    // Kick processor
    processSipQueue(ws)
  })
}

// ElevenLabs WebSocket TTS streaming (optimized for 8kHz PCM output)
const elevenLabsStreamTTS = async (text, ws, ids, sessionId) => {
  return new Promise(async (resolve) => {
    try {
      if (!API_KEYS.elevenlabs) throw new Error("Missing ELEVEN_API_KEY")
      // Request PCM 8k directly to avoid resampling
      const url = `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVEN_CONFIG.voiceId)}/stream-input?model_id=${encodeURIComponent(ELEVEN_CONFIG.modelId)}&inactivity_timeout=${ELEVEN_CONFIG.inactivityTimeout}&output_format=pcm_16000`
      const headers = { 'xi-api-key': API_KEYS.elevenlabs }
      const elWs = new WebSocket(url, { headers })
      console.log(elWs)

      let opened = false
      let resolved = false

      const safeResolve = (ok) => { if (!resolved) { resolved = true; try { elWs.close() } catch (_) {}; resolve(ok) } }

      let keepAlive = null

      elWs.on("open", () => {
        opened = true
        console.log(`[${ts()}] [11L-WS] open session=${sessionId}`)
        // Initialize connection with a single-space text and api key per ElevenLabs guidance
        const initMsg = {
          text: " ",
          xi_api_key: API_KEYS.elevenlabs,
          voice_settings: { stability: 0.3, similarity_boost: 0.7, style: 0.3 },
          generation_config: { chunk_length_schedule: [120, 200] },
        }
        try { elWs.send(JSON.stringify(initMsg)) } catch (_) {}
        // Send the text
        try { elWs.send(JSON.stringify({ text })) } catch (_) {}
        // Flush to force generation
        try { elWs.send(JSON.stringify({ flush: true })) } catch (_) {}
        // Keep alive (space) every 10s
        keepAlive = setInterval(() => {
          try { elWs.send(JSON.stringify({ text: " " })) } catch (_) {}
        }, 10000)
      })

      let firstAudioAt = null
      let pcm8kAcc = Buffer.alloc(0)
      const FRAME_BYTES = 320 // 20ms @ 8kHz mono 16-bit
      let sentBytes = 0
      // Track last queued promise so we resolve TTS only after final chunk is sent
      let lastEnqueuePromise = Promise.resolve(true)
      let audioWatch = setTimeout(() => {
        if (!firstAudioAt) {
          console.log(`[${ts()}] [11L-WS] no_audio_yet 1500ms after open session=${sessionId}`)
        }
      }, 1500)

      elWs.on("message", async (data) => {
        try {
          // Messages can be binary audio or JSON. For simplicity, detect JSON first
          let asText = null
          if (Buffer.isBuffer(data)) {
            // Some ElevenLabs control messages may arrive as binary JSON; detect and parse
            const firstByte = data[0]
            if (firstByte === 0x7B || firstByte === 0x5B) { // '{' or '['
              asText = data.toString('utf8')
            } else {
              // Binary path: treat as raw PCM16k mono from ElevenLabs, downsample to 8k
              const pcm16kBuf = data
              if (!firstAudioAt) firstAudioAt = Date.now()
              const b64 = pcm16kBuf.toString('base64')
              console.log(`[${ts()}] [11L-AUDIO-BIN] bytes=${pcm16kBuf.length} (16kHz) preview_base64=${b64.slice(0,64)}...`)
              
              // Downsample 16kHz to 8kHz by taking every 2nd sample
              const pcm8kBuf = downsamplePcm16kTo8k(pcm16kBuf)
              console.log(`[${ts()}] [11L-DOWNSAMPLE] 16k_bytes=${pcm16kBuf.length} 8k_bytes=${pcm8kBuf.length}`)
              
              // Accumulate until we have enough for multiple 20ms frames (320 bytes @ 8kHz)
              pcm8kAcc = Buffer.concat([pcm8kAcc, pcm8kBuf])
              if (pcm8kAcc.length >= FRAME_BYTES * 5) { // ~100ms
                const fullFrames = Math.floor(pcm8kAcc.length / FRAME_BYTES)
                const sendLen = fullFrames * FRAME_BYTES
                const toSend = pcm8kAcc.slice(0, sendLen)
                const remainder = pcm8kAcc.slice(sendLen)
                pcm8kAcc = remainder
                sentBytes += toSend.length
                lastEnqueuePromise = enqueuePcmToSip(ws, ids, toSend.toString('base64'), sessionId)
                await lastEnqueuePromise
              }
              return
            }
          } else {
            asText = String(data)
          }
          try {
            const msg = JSON.parse(asText)
            if (!msg) return
            // Log control/meta messages from ElevenLabs
            if (!msg.audio && !msg.isFinal && !msg.normalizedAlignment && !msg.alignment) {
              console.log(`[${ts()}] [11L-WS-MSG] keys=${Object.keys(msg).join(',')} `)
            }
            if (msg?.audio) {
              // audio is base64 PCM at 16000 Hz from ElevenLabs, downsample to 8k
              const base64Audio = msg.audio
              if (!base64Audio || typeof base64Audio !== 'string' || base64Audio.length === 0) {
                console.log(`[${ts()}] [11L-AUDIO-EMPTY] received empty/invalid audio field`)
                return
              }
              console.log(`[${ts()}] [11L-AUDIO-JSON] base64_len=${base64Audio.length} preview=${base64Audio.slice(0,64)}...`)
              const pcm16kBuf = Buffer.from(base64Audio, 'base64')
              const sampleCount16k = Math.floor(pcm16kBuf.length / 2)
              if (!firstAudioAt) firstAudioAt = Date.now()
              console.log(`[${ts()}] [11L-AUDIO-PCM16] sr=16000Hz ch=1 bytes=${pcm16kBuf.length} samples=${sampleCount16k}`)
              
              // Downsample 16kHz to 8kHz by taking every 2nd sample
              const pcm8kBuf = downsamplePcm16kTo8k(pcm16kBuf)
              const sampleCount8k = Math.floor(pcm8kBuf.length / 2)
              console.log(`[${ts()}] [11L-DOWNSAMPLE-JSON] 16k_samples=${sampleCount16k} 8k_samples=${sampleCount8k}`)
              
              // Accumulate 8k audio
              pcm8kAcc = Buffer.concat([pcm8kAcc, pcm8kBuf])
              if (pcm8kAcc.length >= FRAME_BYTES * 5) {
                const fullFrames = Math.floor(pcm8kAcc.length / FRAME_BYTES)
                const sendLen = fullFrames * FRAME_BYTES
                const toSend = pcm8kAcc.slice(0, sendLen)
                const remainder = pcm8kAcc.slice(sendLen)
                pcm8kAcc = remainder
                sentBytes += toSend.length
                lastEnqueuePromise = enqueuePcmToSip(ws, ids, toSend.toString('base64'), sessionId)
                await lastEnqueuePromise
              }
            } else if (msg?.isFinal) {
              console.log(`[${ts()}] [11L-WS] final session=${sessionId}`)
            } else if (msg && (msg.audio === null || msg.audio === undefined)) {
              console.log(`[${ts()}] [11L-AUDIO-NULL] audio field is null/undefined; skipping`)
            }
          } catch (_) {
            // Not JSON, ignore
          }
        } catch (_) {}
      })

      elWs.on("error", (e) => {
        console.log(`[${ts()}] [11L-WS] error ${e?.message || ''}`)
        safeResolve(false)
      })
      elWs.on("unexpected-response", (req, res) => {
        try {
          let body = ""
          res.on('data', (c) => body += c.toString())
          res.on('end', () => {
            console.log(`[${ts()}] [11L-WS] unexpected_response status=${res.statusCode} headers=${JSON.stringify(res.headers)} body=${body.slice(0,300)}...`)
          })
        } catch (_) {}
      })
      elWs.on("close", async () => {
        console.log(`[${ts()}] [11L-WS] close session=${sessionId}`)
        // Flush any remaining audio (pad to one frame)
        try {
          if (pcm8kAcc.length > 0) {
            const fullFrames = Math.floor(pcm8kAcc.length / FRAME_BYTES)
            let toSendBuf
            if (fullFrames >= 1) {
              const sendLen = fullFrames * FRAME_BYTES
              toSendBuf = pcm8kAcc.slice(0, sendLen)
            } else {
              // pad to one frame
              toSendBuf = Buffer.concat([pcm8kAcc, Buffer.alloc(FRAME_BYTES - pcm8kAcc.length)])
            }
            sentBytes += toSendBuf.length
            lastEnqueuePromise = enqueuePcmToSip(ws, ids, toSendBuf.toString('base64'), sessionId)
            await lastEnqueuePromise
          }
        } catch (_) {}
        if (keepAlive) { clearInterval(keepAlive); keepAlive = null }
      // Ensure queue drained before resolving
      try { await lastEnqueuePromise } catch (_) {}
      if (sentBytes <= 0) {
          console.log(`[${ts()}] [11L-NO-AUDIO] session=${sessionId} no_bytes_sent`)
          safeResolve(false)
        } else {
          safeResolve(true)
        }
      })

      // Safety timeout
      setTimeout(() => {
        if (!opened) {
          console.log(`[${ts()}] [11L-WS] timeout opening`)
          safeResolve(false)
        }
      }, 5000)
    } catch (e) {
      console.log(`[${ts()}] [11L-WS] setup_error ${e.message}`)
      resolve(false)
    }
  })
}

const respondWithOpenAI = async (userMessage, history = []) => {
  const messages = [
    { role: "system", content: STATIC.systemPrompt },
    ...history.slice(-6),
    { role: "user", content: userMessage },
  ]
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEYS.openai}` },
    body: JSON.stringify({ model: "gpt-4o-mini", messages, max_tokens: 100, temperature: 0.2 }), // Reduced tokens and temp
  })
  if (!res.ok) throw new Error(`OpenAI error: ${res.status}`)
  const data = await res.json()
  return (data.choices?.[0]?.message?.content || "").trim()
}

// Optimized OpenAI streaming with better session management
const respondWithOpenAIStream = async (userMessage, history = [], onPartial = null, sessionId = null) => {
  const messages = [
    { role: "system", content: STATIC.systemPrompt },
    ...history.slice(-4), // Reduced context for faster processing
    { role: "user", content: userMessage },
  ]
  
  console.log(`[${ts()}] [LLM-STREAM] start session=${sessionId || 'none'} message="${userMessage}"`)
  
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEYS.openai}` },
    body: JSON.stringify({ 
      model: "gpt-4o-mini", 
      messages, 
      max_tokens: 80,    // Reduced for faster responses
      temperature: 0.1,  // Lower for more consistent responses
      stream: true,
      presence_penalty: 0.1  // Slight penalty for repetition
    }),
  })
  
  if (!res.ok || !res.body) {
    console.log(`[${ts()}] [LLM-STREAM] http_error status=${res.status}`)
    return null
  }
  
  const reader = res.body.getReader()
  const decoder = new TextDecoder("utf-8")
  let buffer = ""
  let accumulated = ""
  let firstTokenLogged = false
  let tokenCount = 0
  
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ""
      
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        if (trimmed === "data: [DONE]") {
          console.log(`[${ts()}] [LLM-STREAM] done session=${sessionId || 'none'} tokens=${tokenCount}`)
          break
        }
        if (trimmed.startsWith("data:")) {
          try {
            const json = JSON.parse(trimmed.slice(5).trim())
            const delta = json.choices?.[0]?.delta?.content || ""
            if (delta) {
              if (!firstTokenLogged) { 
                firstTokenLogged = true
                console.log(`[${ts()}] [LLM-STREAM] first_token session=${sessionId || 'none'}`) 
              }
              accumulated += delta
              tokenCount++
              
              if (typeof onPartial === "function") {
                try { 
                  await onPartial(accumulated, delta, sessionId) 
                } catch (_) {}
              }
            }
          } catch (_) {}
        }
      }
    }
  } catch (e) {
    console.log(`[${ts()}] [LLM-STREAM] read_error session=${sessionId} ${e.message}`)
  } finally {
    try { reader.releaseLock() } catch (_) {}
  }
  
  console.log(`[${ts()}] [LLM-STREAM] completed session=${sessionId} chars=${accumulated.length} tokens=${tokenCount}`)
  return accumulated || null
}

const connectDeepgram = (language = STATIC.deepgramLanguage) => {
  // Use the most basic, reliable configuration first
  const url = new URL("wss://api.deepgram.com/v1/listen")
  url.searchParams.append("sample_rate", "44100")
  url.searchParams.append("channels", "1") 
  url.searchParams.append("encoding", "linear16")
  url.searchParams.append("language", language)
  url.searchParams.append("interim_results", "true")
  
  // Only add parameters that are definitely supported
  url.searchParams.append("model", "nova-2")
  url.searchParams.append("smart_format", "true")
  url.searchParams.append("punctuate", "true")
  
  const wsUrl = url.toString()
  console.log(`[${ts()}] [DEEPGRAM-CONNECT] ${wsUrl}`)
  console.log(`[${ts()}] [DEEPGRAM-AUTH] Using API key: ${API_KEYS.deepgram ? `${API_KEYS.deepgram.substring(0, 8)}...` : 'MISSING'}`)
  
  return new WebSocket(wsUrl, { 
    headers: { 
      Authorization: `Token ${API_KEYS.deepgram}` 
    } 
  })
}

const setupSanPbxWebSocketServer = (ws) => {
  let ids = { streamId: null, callId: null, channelId: null }
  let deepgramWs = null
  let deepgramReady = false
  let dgQueue = []
  let history = []
  
  // Enhanced session management
  let currentLLMSession = 0
  let currentTTSSession = 0
  ws.currentTTSSession = 0
  
  // STT latency markers
  let sttStartTs = null
  let firstMediaTs = null
  let firstForwardToDgTs = null
  let firstDgMsgTs = null
  
  // Interim processing state
  let interimBuffer = ""
  let interimWordCount = 0
  let lastInterimTime = 0
  let interimProcessingActive = false
  let wordAccumulationTimer = null
  
  // User speech detection
  let userSpeechDetected = false
  let lastUserInputTime = 0
  
  const sendGreeting = async () => {
    try {
      const sessionId = ++currentTTSSession
      ws.currentTTSSession = sessionId
      const pcm = await ttsWithSarvam(STATIC.firstMessage)
      await streamPcmToSanPBX(ws, ids, pcm, sessionId)
      history.push({ role: "assistant", content: STATIC.firstMessage })
    } catch (_) {}
  }

  // Enhanced TTS queue with better cancellation
  let ttsQueue = []
  let ttsBusy = false
  let speakBuffer = ""
  let speakDebounceTimer = null
  const PUNCTUATION_FLUSH = /([.!?]\s?$|[;:，。！？]$|\n\s*$)/
  
  const flushSpeakBuffer = (reason = "debounce") => {
    const chunk = speakBuffer.trim()
    speakBuffer = ""
    if (!chunk) return
    
    // More lenient minimum length for better word flow
    if (chunk.length < 3 && reason !== "punct" && reason !== "force") {
      console.log(`[${ts()}] [TTS-SKIP-FLUSH] too_short="${chunk}" reason=${reason}`)
      speakBuffer = chunk // Put it back for accumulation
      return
    }
    
    // Increase TTS queue size for better buffering
    if (ttsQueue.length >= 5) {
      console.log(`[${ts()}] [TTS-QUEUE-LIMIT] dropping chunk="${chunk}" queue_size=${ttsQueue.length}`)
      return
    }
    
    ttsQueue.push(chunk)
    console.log(`[${ts()}] [TTS-QUEUE] flush(${reason}) len=${chunk.length} text="${chunk}" queue=${ttsQueue.length}`)
    if (!ttsBusy) processTTSQueue().catch(() => {})
  }
  
  const queueSpeech = (text, force = false) => {
    if (!text || !text.trim()) return
    
    // Cancel if user is speaking
    if (userSpeechDetected && Date.now() - lastUserInputTime < LATENCY_CONFIG.SILENCE_DETECTION_MS) {
      console.log(`[${ts()}] [TTS-SKIP] user_speaking`)
      return
    }
    
    // More lenient filtering for better word flow
    const cleanText = text.trim()
    if (cleanText.length < 2 && !force) {
      console.log(`[${ts()}] [TTS-SKIP] too_short="${cleanText}"`)
      return
    }
    
    // Clear previous buffer if starting fresh
    const incoming = cleanText
    speakBuffer += (speakBuffer ? " " : "") + incoming
    const bufLen = speakBuffer.length
    const wordCount = speakBuffer.trim().split(/\s+/).filter(Boolean).length
    const punctNow = PUNCTUATION_FLUSH.test(speakBuffer)
    
    // More aggressive flushing for lower latency
    const shouldImmediate = force || 
                           punctNow || 
                           bufLen >= 60 ||  // Reduced threshold for faster response
                           wordCount >= 8   // Fewer words before flushing
    
    if (shouldImmediate) {
      if (speakDebounceTimer) { 
        clearTimeout(speakDebounceTimer)
        speakDebounceTimer = null 
      }
      flushSpeakBuffer(punctNow ? "punct" : (force ? "force" : "threshold"))
      return
    }
    
    // Shorter debounce for lower latency
    if (speakDebounceTimer) clearTimeout(speakDebounceTimer)
    speakDebounceTimer = setTimeout(() => flushSpeakBuffer("debounce"), 150) // Reduced from 300ms
  }
  
  const processTTSQueue = async () => {
    if (ttsBusy) return
    ttsBusy = true
    
    try {
      while (ttsQueue.length > 0 && ws.readyState === WebSocket.OPEN) {
        const item = ttsQueue.shift()
        const sessionId = ++currentTTSSession
        ws.currentTTSSession = sessionId
        console.log(`[${ts()}] [TTS-PLAY] start len=${item.length} session=${sessionId} text="${item}"`)
        const ok = await elevenLabsStreamTTS(item, ws, ids, sessionId)
        if (ok) {
          console.log(`[${ts()}] [TTS-PLAY] success len=${item.length} session=${sessionId}`)
        } else {
          console.log(`[${ts()}] [TTS-PLAY] cancelled_or_error len=${item.length} session=${sessionId}`)
          ttsQueue = []
          break
        }
      }
    } catch (e) {
      console.log(`[${ts()}] [TTS-QUEUE-ERROR] ${e.message}`)
    } finally {
      ttsBusy = false
      
      // Process any remaining items that were added during processing
      if (ttsQueue.length > 0 && ws.readyState === WebSocket.OPEN) {
        setTimeout(() => processTTSQueue(), 100)
      }
    }
  }

  // Enhanced transcript handling with better session management
  const handleIncrementalTranscript = async (text, isFinal = false, confidence = 1.0) => {
    try {
      const clean = (text || "").trim()
      if (!clean) return
      
      const wordCount = clean.split(/\s+/).filter(Boolean).length
      
      // Cancel any ongoing operations when user speaks
      if (!isFinal) {
        userSpeechDetected = true
        lastUserInputTime = Date.now()
        
        // Cancel current TTS and LLM sessions aggressively
        const oldTTSSession = currentTTSSession
        const oldLLMSession = currentLLMSession
        currentTTSSession += 2  // Skip ahead to ensure cancellation
        currentLLMSession += 2
        ws.currentTTSSession = currentTTSSession
        
        // Clear TTS queue to prevent backup
        ttsQueue = []
        ttsBusy = false
        if (speakDebounceTimer) {
          clearTimeout(speakDebounceTimer)
          speakDebounceTimer = null
        }
        speakBuffer = ""
        
        console.log(`[${ts()}] [USER-SPEECH] detected, cancelling TTS=${oldTTSSession}→${currentTTSSession} LLM=${oldLLMSession}→${currentLLMSession}`)
      }
      
      console.log(`[${ts()}] [TRANSCRIPT-${isFinal ? 'FINAL' : 'INTERIM'}] words=${wordCount} conf=${confidence.toFixed(2)} text="${clean}"`)
      
      // Process final transcripts OR high-quality interim transcripts for faster response
      const shouldProcess = isFinal || 
                           (wordCount >= 2 && confidence >= 0.6 && !isFinal) // More aggressive interim processing
      
      if (!shouldProcess) return
      
      // Update history only for final transcripts
      if (isFinal) {
        history.push({ role: "user", content: clean })
        userSpeechDetected = false // Reset after final transcript
      }
      
      const sessionId = ++currentLLMSession
      let lastLen = 0
      let responseText = ""
      
      // More aggressive flushing for lower latency while preserving word boundaries
      const shouldFlush = (prev, curr) => {
        const diff = curr.slice(prev).trim()
        const words = diff.split(/\s+/).filter(Boolean).length
        
        // Flush on natural breakpoints for better responsiveness
        if (words >= 4) return true // Shorter chunks for faster response
        if (/[.!?]\s*$/.test(diff)) return true // Sentence endings
        if (/[,;:]\s*$/.test(diff)) return true // Comma/semicolon breaks
        if (diff.length >= 30) return true // Shorter chunks
        
        return false
      }
      
      const finalText = await respondWithOpenAIStream(clean, history, async (accum, delta, llmSessionId) => {
        // Skip if this session is outdated
        if (llmSessionId !== sessionId) return
        
        responseText = accum
        
        if (!accum || accum.length <= lastLen) return
        if (!shouldFlush(lastLen, accum)) return
        
        const chunk = accum.slice(lastLen).trim()
        if (!chunk) return
        
        lastLen = accum.length
        console.log(`[${ts()}] [LLM-FLUSH] session=${sessionId} chunk_len=${chunk.length} chunk="${chunk}"`)
        queueSpeech(chunk, false)
      }, sessionId)
      
      // Handle final chunk - ensure we speak the complete response
      if (finalText && finalText.length > lastLen) {
        const tail = finalText.slice(lastLen).trim()
        if (tail) {
          console.log(`[${ts()}] [LLM-FINAL] session=${sessionId} tail_len=${tail.length} tail="${tail}"`)
          queueSpeech(tail, true)
        }
      }
      
      // Update history only for final transcripts and successful LLM responses
      if (isFinal && finalText && sessionId === currentLLMSession) {
        history.push({ role: "assistant", content: finalText })
        console.log(`[${ts()}] [HISTORY-UPDATE] session=${sessionId} response_len=${finalText.length}`)
      }
      
    } catch (e) {
      console.log(`[${ts()}] [TRANSCRIPT-ERROR] ${e.message}`)
    }
  }

  const bootDeepgram = (retryCount = 0) => {
    const MAX_RETRIES = 3
    const RETRY_DELAY = 1000 * Math.pow(2, retryCount) // Exponential backoff
    
    console.log(`[${ts()}] [DEEPGRAM-BOOT] attempt=${retryCount + 1}/${MAX_RETRIES + 1}`)
    
    deepgramWs = connectDeepgram()
    
    deepgramWs.onopen = () => {
      deepgramReady = true
      console.log(`[${ts()}] 🎤 [DEEPGRAM] connected successfully; queued_packets=${dgQueue.length}`)
      
      // Send queued audio packets
      if (dgQueue.length) { 
        console.log(`[${ts()}] [DEEPGRAM] sending ${dgQueue.length} queued packets`)
        dgQueue.forEach((b) => {
          if (deepgramWs.readyState === WebSocket.OPEN) {
            deepgramWs.send(b)
          }
        })
        dgQueue = [] 
      }
    }
    
    deepgramWs.onmessage = async (evt) => {
      try {
        const msg = JSON.parse(evt.data)
        if (msg.type === "Results") {
          if (!firstDgMsgTs) {
            firstDgMsgTs = Date.now()
            const latFromStart = sttStartTs ? (firstDgMsgTs - sttStartTs) : null
            const latFromFirstForward = firstForwardToDgTs ? (firstDgMsgTs - firstForwardToDgTs) : null
            console.log(`[${ts()}] [DEEPGRAM-LAT] first_result_ms_from_start=${latFromStart || 'n/a'} from_first_forward_ms=${latFromFirstForward || 'n/a'}`)
          }
          
          const alternative = msg.channel?.alternatives?.[0]
          const transcript = alternative?.transcript || ""
          const confidence = alternative?.confidence || 0
          
          if (transcript) {
            await handleIncrementalTranscript(transcript, msg.is_final, confidence)
          }
        } else if (msg.type === "Metadata") {
          console.log(`[${ts()}] [DEEPGRAM-META] ${JSON.stringify(msg)}`)
        }
      } catch (e) {
        console.log(`[${ts()}] [DEEPGRAM-MSG-ERROR] ${e.message}`)
      }
    }
    
    deepgramWs.onerror = (e) => { 
      deepgramReady = false
      console.log(`[${ts()}] ⚠ [DEEPGRAM] error: ${e?.message || e?.type || 'unknown'}`) 
      console.log(`[${ts()}] [DEEPGRAM] error details:`, e)
    }
    
    deepgramWs.onclose = (e) => { 
      deepgramReady = false
      console.log(`[${ts()}] 🔌 [DEEPGRAM] closed code=${e?.code} reason="${e?.reason || 'none'}"`)
      
      // Retry connection if it was not a normal close and we have retries left
      if (e?.code !== 1000 && retryCount < MAX_RETRIES && ids.streamId) {
        console.log(`[${ts()}] [DEEPGRAM-RETRY] retrying in ${RETRY_DELAY}ms...`)
        setTimeout(() => {
          bootDeepgram(retryCount + 1)
        }, RETRY_DELAY)
      } else if (e?.code !== 1000) {
        console.log(`[${ts()}] [DEEPGRAM-FAILED] max retries exceeded or call ended`)
      }
    }
  }

  ws.on("message", async (message) => {
    try {
      const text = Buffer.isBuffer(message) ? message.toString() : String(message)
      const data = JSON.parse(text)
      
      switch (data.event) {
        case "connected":
          console.log(`[${ts()}] 🔗 [SANPBX] connected`)
          break
          
        case "start":
          console.log(`[${ts()}] 📞 [SANPBX] start ${JSON.stringify({ streamId: data.streamId, callId: data.callId, channelId: data.channelId })}`)
          ids.streamId = data.streamId
          ids.callId = data.callId
          ids.channelId = data.channelId
          history = []
          
          // Reset session counters
          currentLLMSession = 0
          currentTTSSession = 0
          ws.currentTTSSession = 0
          userSpeechDetected = false
          
          // Reset latency markers
          sttStartTs = Date.now()
          firstMediaTs = null
          firstForwardToDgTs = null
          firstDgMsgTs = null
          
          bootDeepgram()
          await sendGreeting()
          break
          
        case "media":
          if (data.payload) {
            const audioBuffer = Buffer.from(data.payload, 'base64')
            if (!ws.mediaPacketCount) ws.mediaPacketCount = 0
            ws.mediaPacketCount++
            
            if (ws.mediaPacketCount % 1000 === 0) {
              console.log(`[${ts()}] 🎵 [SANPBX-MEDIA] packets=${ws.mediaPacketCount}`)
            }
            
            if (!firstMediaTs) {
              firstMediaTs = Date.now()
              const latFromStart = sttStartTs ? (firstMediaTs - sttStartTs) : null
              console.log(`[${ts()}] [STT-LAT] first_media_recv_ms_from_start=${latFromStart || 'n/a'}`)
            }
            
            if (deepgramWs && deepgramReady && deepgramWs.readyState === WebSocket.OPEN) {
              if (!firstForwardToDgTs) {
                firstForwardToDgTs = Date.now()
                const latMediaToForward = firstMediaTs ? (firstForwardToDgTs - firstMediaTs) : null
                console.log(`[${ts()}] [STT-LAT] first_forward_to_deepgram_ms_from_first_media=${latMediaToForward || 'n/a'}`)
              }
              deepgramWs.send(audioBuffer)
            } else {
              dgQueue.push(audioBuffer)
              if (dgQueue.length % 50 === 0) { // Reduced logging frequency
                console.log(`[${ts()}] ⏳ [DEEPGRAM-QUEUE] queued_packets=${dgQueue.length}`)
              }
            }
          }
          break
          
        case "stop":
          console.log(`[${ts()}] 🛑 [SANPBX] stop`)
          if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) deepgramWs.close()
          break
          
        default:
          break
      }
    } catch (e) {
      console.log(`[${ts()}] [SANPBX-MSG-ERROR] ${e.message}`)
    }
  })

  ws.on("close", () => {
    console.log(`[${ts()}] 🔌 [SANPBX] ws closed`)
    if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) deepgramWs.close()
  })

  ws.on("error", (e) => {
    console.log(`[${ts()}] [SANPBX-WS-ERROR] ${e.message}`)
  })
}

module.exports = { setupSanPbxWebSocketServer }