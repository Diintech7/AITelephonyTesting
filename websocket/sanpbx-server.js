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
  voiceId: process.env.ELEVEN_VOICE_ID || "Xb7hH8MSUJpSbSDYk0k2",
  modelId: process.env.ELEVEN_MODEL_ID || "eleven_flash_v2_5",
  inactivityTimeout: 180,
}

// Enhanced latency and interruption configuration
const LATENCY_CONFIG = {
  INTERIM_MIN_WORDS: 1,
  INTERIM_DEBOUNCE_MS: 50,        // Faster interruption detection
  CONFIDENCE_THRESHOLD: 0.5,       // Lower for faster detection
  WORD_ACCUMULATION_MS: 100,
  TTS_MIN_CHARS: 3,
  TTS_DEBOUNCE_MS: 60,            // Faster TTS response
  SILENCE_DETECTION_MS: 150,      // Faster silence detection
  INTERRUPTION_GRACE_MS: 300,     // Grace period after interruption
}

// History management configuration
const HISTORY_CONFIG = {
  MAX_HISTORY_LENGTH: 20,         // Keep more history for context
  TRANSCRIPT_MERGE_TIMEOUT: 2000, // Time to wait for transcript continuation
  MIN_TRANSCRIPT_WORDS: 1,        // Minimum words to save transcript
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

// Downsample raw PCM 16-bit mono from 16kHz to 8kHz by simple decimation
const downsamplePcm16kTo8kBase64 = (pcm16kBase64) => {
  const start = Date.now()
  try {
    const src = Buffer.from(pcm16kBase64, 'base64')
    const samples = Math.floor(src.length / 2)
    if (samples <= 0) return pcm16kBase64
    const dst = Buffer.alloc(Math.floor(src.length / 2))
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
    return pcm16kBase64
  }
}

// Downsample raw PCM 16-bit mono from 16kHz to 8kHz with simple low-pass prefilter
const downsamplePcm16kTo8k = (pcm16kBuf) => {
  const start = Date.now()
  try {
    const byteLen = pcm16kBuf.length - (pcm16kBuf.length % 2)
    if (byteLen <= 0) return pcm16kBuf
    const srcView = new Int16Array(pcm16kBuf.buffer, pcm16kBuf.byteOffset, byteLen / 2)

    const dstSamples = Math.floor(srcView.length / 2)
    const outView = new Int16Array(dstSamples)

    for (let i = 0, o = 0; o < dstSamples; o++, i += 2) {
      const xm1 = i - 1 >= 0 ? srcView[i - 1] : 0
      const x0 = srcView[i] || 0
      const x1 = i + 1 < srcView.length ? srcView[i + 1] : 0
      const x2 = i + 2 < srcView.length ? srcView[i + 2] : 0
      let y = (xm1 + (x0 << 1) + (x1 << 1) + x2) / 6
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
    // Check if session is still valid (interruption handling)
    if (sessionId && ws.currentTTSSession !== sessionId) {
      console.log(`[${ts()}] [SIP-AUDIO-INTERRUPTED] session=${sessionId} current=${ws.currentTTSSession}`)
      return false
    }
    
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
      for (let i = 0; i < 2; i++) {
        const silence = Buffer.alloc(CHUNK_SIZE).toString('base64')
        ws.send(JSON.stringify({ event: "reverse-media", payload: silence, streamId, channelId, callId }))
        await new Promise(r => setTimeout(r, 20))
      }
    } catch (_) {}
  }
  
  console.log(`[${ts()}] [SIP-AUDIO-END] session=${sessionId || 'n/a'} total_bytes=${totalBytes} total_chunks=${totalChunks}`)
  return true
}

// Enhanced SIP queue management with interruption support
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
    }
  } finally {
    ws.__sipSending = false
    if (ws.__sipQueue && ws.__sipQueue.length > 0 && ws.readyState === WebSocket.OPEN) {
      setImmediate(() => processSipQueue(ws))
    }
  }
}

const enqueuePcmToSip = (ws, ids, pcmBase64, sessionId) => {
  return new Promise((resolve) => {
    ensureSipQueue(ws)
    ws.__sipQueue.push({ ids, pcmBase64, sessionId, resolve })
    processSipQueue(ws)
  })
}

// Enhanced ElevenLabs streaming with better interruption handling
const elevenLabsStreamTTS = async (text, ws, ids, sessionId) => {
  return new Promise(async (resolve) => {
    try {
      if (!API_KEYS.elevenlabs) throw new Error("Missing ELEVEN_API_KEY")
      const url = `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVEN_CONFIG.voiceId)}/stream-input?model_id=${encodeURIComponent(ELEVEN_CONFIG.modelId)}&inactivity_timeout=${ELEVEN_CONFIG.inactivityTimeout}&output_format=pcm_16000`
      const headers = { 'xi-api-key': API_KEYS.elevenlabs }
      const elWs = new WebSocket(url, { headers })

      let opened = false
      let resolved = false

      const safeResolve = (ok) => { 
        if (!resolved) { 
          resolved = true
          try { elWs.close() } catch (_) {}
          resolve(ok) 
        } 
      }

      let keepAlive = null

      elWs.on("open", () => {
        // Check if session is still valid before starting
        if (sessionId && ws.currentTTSSession !== sessionId) {
          console.log(`[${ts()}] [11L-WS] session_invalid_on_open session=${sessionId} current=${ws.currentTTSSession}`)
          safeResolve(false)
          return
        }
        
        opened = true
        console.log(`[${ts()}] [11L-WS] open session=${sessionId}`)
        const initMsg = {
          text: " ",
          xi_api_key: API_KEYS.elevenlabs,
          voice_settings: { stability: 0.3, similarity_boost: 0.7, style: 0.3 },
          generation_config: { chunk_length_schedule: [120, 200] },
        }
        try { elWs.send(JSON.stringify(initMsg)) } catch (_) {}
        try { elWs.send(JSON.stringify({ text })) } catch (_) {}
        try { elWs.send(JSON.stringify({ flush: true })) } catch (_) {}
        
        keepAlive = setInterval(() => {
          if (sessionId && ws.currentTTSSession !== sessionId) {
            console.log(`[${ts()}] [11L-WS] session_expired_keepalive session=${sessionId}`)
            safeResolve(false)
            return
          }
          try { elWs.send(JSON.stringify({ text: " " })) } catch (_) {}
        }, 10000)
      })

      let firstAudioAt = null
      let pcm8kAcc = Buffer.alloc(0)
      const FRAME_BYTES = 320
      let sentBytes = 0
      let lastEnqueuePromise = Promise.resolve(true)

      elWs.on("message", async (data) => {
        try {
          // Check session validity on every message
          if (sessionId && ws.currentTTSSession !== sessionId) {
            console.log(`[${ts()}] [11L-WS] session_invalid_on_message session=${sessionId} current=${ws.currentTTSSession}`)
            safeResolve(false)
            return
          }
          
          let asText = null
          if (Buffer.isBuffer(data)) {
            const firstByte = data[0]
            if (firstByte === 0x7B || firstByte === 0x5B) {
              asText = data.toString('utf8')
            } else {
              const pcm16kBuf = data
              if (!firstAudioAt) firstAudioAt = Date.now()
              const pcm8kBuf = downsamplePcm16kTo8k(pcm16kBuf)
              
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
              return
            }
          } else {
            asText = String(data)
          }
          
          try {
            const msg = JSON.parse(asText)
            if (!msg) return
            
            if (msg?.audio) {
              const base64Audio = msg.audio
              if (!base64Audio || typeof base64Audio !== 'string' || base64Audio.length === 0) {
                return
              }
              
              const pcm16kBuf = Buffer.from(base64Audio, 'base64')
              if (!firstAudioAt) firstAudioAt = Date.now()
              
              const pcm8kBuf = downsamplePcm16kTo8k(pcm16kBuf)
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
            }
          } catch (_) {}
        } catch (_) {}
      })

      elWs.on("error", (e) => {
        console.log(`[${ts()}] [11L-WS] error ${e?.message || ''}`)
        safeResolve(false)
      })

      elWs.on("close", async () => {
        console.log(`[${ts()}] [11L-WS] close session=${sessionId}`)
        try {
          if (pcm8kAcc.length > 0) {
            const fullFrames = Math.floor(pcm8kAcc.length / FRAME_BYTES)
            let toSendBuf
            if (fullFrames >= 1) {
              const sendLen = fullFrames * FRAME_BYTES
              toSendBuf = pcm8kAcc.slice(0, sendLen)
            } else {
              toSendBuf = Buffer.concat([pcm8kAcc, Buffer.alloc(FRAME_BYTES - pcm8kAcc.length)])
            }
            sentBytes += toSendBuf.length
            lastEnqueuePromise = enqueuePcmToSip(ws, ids, toSendBuf.toString('base64'), sessionId)
            await lastEnqueuePromise
          }
        } catch (_) {}
        
        if (keepAlive) { 
          clearInterval(keepAlive)
          keepAlive = null 
        }
        
        try { await lastEnqueuePromise } catch (_) {}
        
        if (sentBytes <= 0) {
          console.log(`[${ts()}] [11L-NO-AUDIO] session=${sessionId}`)
          safeResolve(false)
        } else {
          safeResolve(true)
        }
      })

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

// Enhanced OpenAI streaming with comprehensive history
const respondWithOpenAIStream = async (userMessage, fullHistory = [], onPartial = null, sessionId = null) => {
  // Use the full history but limit to recent entries for performance
  const recentHistory = fullHistory.slice(-10) // Use last 10 entries for context
  const messages = [
    { role: "system", content: STATIC.systemPrompt },
    ...recentHistory,
    { role: "user", content: userMessage },
  ]
  
  console.log(`[${ts()}] [LLM-STREAM] start session=${sessionId || 'none'} message="${userMessage}" history_entries=${recentHistory.length}`)
  
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEYS.openai}` },
    body: JSON.stringify({ 
      model: "gpt-4o-mini", 
      messages, 
      max_tokens: 100,
      temperature: 0.2,
      stream: true,
      presence_penalty: 0.1
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
  const url = new URL("wss://api.deepgram.com/v1/listen")
  url.searchParams.append("sample_rate", "44100")
  url.searchParams.append("channels", "1") 
  url.searchParams.append("encoding", "linear16")
  url.searchParams.append("language", language)
  url.searchParams.append("interim_results", "true")
  url.searchParams.append("model", "nova-2")
  url.searchParams.append("smart_format", "true")
  url.searchParams.append("punctuate", "true")
  
  const wsUrl = url.toString()
  console.log(`[${ts()}] [DEEPGRAM-CONNECT] ${wsUrl}`)
  
  return new WebSocket(wsUrl, { 
    headers: { 
      Authorization: `Token ${API_KEYS.deepgram}` 
    } 
  })
}

// Enhanced history manager class
class ConversationHistory {
  constructor() {
    this.entries = []
    this.pendingTranscript = ""
    this.lastTranscriptTime = 0
    this.transcriptMergeTimer = null
  }

  // Add a complete user transcript to history
  addUserTranscript(text, timestamp = Date.now()) {
    const clean = text.trim()
    if (!clean || clean.split(/\s+/).length < HISTORY_CONFIG.MIN_TRANSCRIPT_WORDS) return
    
    // Clear any pending merge timer
    if (this.transcriptMergeTimer) {
      clearTimeout(this.transcriptMergeTimer)
      this.transcriptMergeTimer = null
    }
    
    // Check if this should be merged with previous user entry
    const lastEntry = this.entries[this.entries.length - 1]
    const timeDiff = timestamp - this.lastTranscriptTime
    
    if (lastEntry && 
        lastEntry.role === "user" && 
        timeDiff < HISTORY_CONFIG.TRANSCRIPT_MERGE_TIMEOUT &&
        !lastEntry.content.endsWith('.') &&
        !lastEntry.content.endsWith('!') &&
        !lastEntry.content.endsWith('?')) {
      
      // Merge with previous transcript
      lastEntry.content += " " + clean
      lastEntry.timestamp = timestamp
      console.log(`[${ts()}] [HISTORY] merged_user_transcript="${lastEntry.content}"`)
    } else {
      // Add as new entry
      this.entries.push({
        role: "user",
        content: clean,
        timestamp: timestamp
      })
      console.log(`[${ts()}] [HISTORY] added_user_transcript="${clean}"`)
    }
    
    this.lastTranscriptTime = timestamp
    this.trimHistory()
  }

  // Add assistant response to history
  addAssistantResponse(text, timestamp = Date.now()) {
    const clean = text.trim()
    if (!clean) return
    
    this.entries.push({
      role: "assistant",
      content: clean,
      timestamp: timestamp
    })
    console.log(`[${ts()}] [HISTORY] added_assistant_response="${clean}"`)
    this.trimHistory()
  }

  // Handle interim transcripts for interruption detection
  handleInterimTranscript(text, timestamp = Date.now()) {
    const clean = text.trim()
    if (!clean) return false
    
    // Update pending transcript
    this.pendingTranscript = clean
    this.lastTranscriptTime = timestamp
    
    // Set timer to add to history if no final transcript comes
    if (this.transcriptMergeTimer) {
      clearTimeout(this.transcriptMergeTimer)
    }
    
    this.transcriptMergeTimer = setTimeout(() => {
      if (this.pendingTranscript) {
        this.addUserTranscript(this.pendingTranscript, this.lastTranscriptTime)
        this.pendingTranscript = ""
      }
    }, HISTORY_CONFIG.TRANSCRIPT_MERGE_TIMEOUT)
    
    // Return true if this looks like the start of user speech (interruption)
    const wordCount = clean.split(/\s+/).length
    return wordCount >= 1 // Even single words can indicate interruption
  }

  // Get conversation history for AI context
  getConversationHistory() {
    return this.entries.map(entry => ({
      role: entry.role,
      content: entry.content
    }))
  }

  // Get full history with timestamps
  getFullHistory() {
    return [...this.entries]
  }

  // Trim history to maintain performance
  trimHistory() {
    if (this.entries.length > HISTORY_CONFIG.MAX_HISTORY_LENGTH) {
      const removed = this.entries.splice(0, this.entries.length - HISTORY_CONFIG.MAX_HISTORY_LENGTH)
      console.log(`[${ts()}] [HISTORY] trimmed ${removed.length} old entries`)
    }
  }

  // Clear all history
  clear() {
    this.entries = []
    this.pendingTranscript = ""
    if (this.transcriptMergeTimer) {
      clearTimeout(this.transcriptMergeTimer)
      this.transcriptMergeTimer = null
    }
    console.log(`[${ts()}] [HISTORY] cleared`)
  }
}

const setupSanPbxWebSocketServer = (ws) => {
  let ids = { streamId: null, callId: null, channelId: null }
  let deepgramWs = null
  let deepgramReady = false
  let dgQueue = []
  
  // Enhanced history management
  const conversationHistory = new ConversationHistory()
  
  // Enhanced session management
  let currentLLMSession = 0
  let currentTTSSession = 0
  ws.currentTTSSession = 0
  
  // STT latency markers
  let sttStartTs = null
  let firstMediaTs = null
  let firstForwardToDgTs = null
  let firstDgMsgTs = null
  
  // Enhanced user speech detection
  let userSpeechDetected = false
  let lastUserInputTime = 0
  let silenceTimer = null
  
  const sendGreeting = async () => {
    try {
      const sessionId = ++currentTTSSession
      ws.currentTTSSession = sessionId
      const ok = await elevenLabsStreamTTS(STATIC.firstMessage, ws, ids, sessionId)
      if (ok) {
        conversationHistory.addAssistantResponse(STATIC.firstMessage)
      }
    } catch (_) {}
  }

  // Enhanced TTS queue with aggressive interruption handling
  let ttsQueue = []
  let ttsBusy = false
  let speakBuffer = ""
  let speakDebounceTimer = null
  const PUNCTUATION_FLUSH = /([.!?]\s?$|[;:，。！？]$|\n\s*$)/
  
  const clearAllTTSOperations = () => {
    // Clear TTS queue
    ttsQueue = []
    ttsBusy = false
    
    // Clear speak buffer and timer
    speakBuffer = ""
    if (speakDebounceTimer) {
      clearTimeout(speakDebounceTimer)
      speakDebounceTimer = null
    }
    
    // Increment session to invalidate any ongoing TTS
    const oldSession = currentTTSSession
    currentTTSSession += 2
    ws.currentTTSSession = currentTTSSession
    
    console.log(`[${ts()}] [INTERRUPTION] cleared_all_tts old_session=${oldSession} new_session=${currentTTSSession}`)
  }
  
  const flushSpeakBuffer = (reason = "debounce") => {
    const chunk = speakBuffer.trim()
    speakBuffer = ""
    if (!chunk) return
    
    if (chunk.length < 3 && reason !== "punct" && reason !== "force") {
      console.log(`[${ts()}] [TTS-SKIP-FLUSH] too_short="${chunk}" reason=${reason}`)
      speakBuffer = chunk
      return
    }
    
    if (ttsQueue.length >= 3) { // Reduced queue size for faster interruption
      console.log(`[${ts()}] [TTS-QUEUE-LIMIT] dropping chunk="${chunk}" queue_size=${ttsQueue.length}`)
      return
    }
    
    ttsQueue.push(chunk)
    console.log(`[${ts()}] [TTS-QUEUE] flush(${reason}) len=${chunk.length} text="${chunk}" queue=${ttsQueue.length}`)
    if (!ttsBusy) processTTSQueue().catch(() => {})
  }
  
  const queueSpeech = (text, force = false) => {
    if (!text || !text.trim()) return
    
    // Check for active user speech - more aggressive cancellation
    if (userSpeechDetected && Date.now() - lastUserInputTime < LATENCY_CONFIG.INTERRUPTION_GRACE_MS) {
      console.log(`[${ts()}] [TTS-SKIP] user_speaking grace_period=${Date.now() - lastUserInputTime}ms`)
      return
    }
    
    const cleanText = text.trim()
    if (cleanText.length < 2 && !force) {
      console.log(`[${ts()}] [TTS-SKIP] too_short="${cleanText}"`)
      return
    }
    
    const incoming = cleanText
    speakBuffer += (speakBuffer ? " " : "") + incoming
    const bufLen = speakBuffer.length
    const wordCount = speakBuffer.trim().split(/\s+/).filter(Boolean).length
    const punctNow = PUNCTUATION_FLUSH.test(speakBuffer)
    
    const shouldImmediate = force || 
                           punctNow || 
                           bufLen >= 40 ||  // Shorter threshold for faster response
                           wordCount >= 6   // Fewer words for faster response
    
    if (shouldImmediate) {
      if (speakDebounceTimer) { 
        clearTimeout(speakDebounceTimer)
        speakDebounceTimer = null 
      }
      flushSpeakBuffer(punctNow ? "punct" : (force ? "force" : "threshold"))
      return
    }
    
    if (speakDebounceTimer) clearTimeout(speakDebounceTimer)
    speakDebounceTimer = setTimeout(() => flushSpeakBuffer("debounce"), 100) // Even faster debounce
  }
  
  const processTTSQueue = async () => {
    if (ttsBusy) return
    ttsBusy = true
    
    try {
      while (ttsQueue.length > 0 && ws.readyState === WebSocket.OPEN) {
        // Check for user interruption before processing each item
        if (userSpeechDetected && Date.now() - lastUserInputTime < LATENCY_CONFIG.INTERRUPTION_GRACE_MS) {
          console.log(`[${ts()}] [TTS-QUEUE-INTERRUPTED] clearing_queue user_speech_detected`)
          ttsQueue = []
          break
        }
        
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
        
        // Small delay between TTS items to allow for interruption detection
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    } catch (e) {
      console.log(`[${ts()}] [TTS-QUEUE-ERROR] ${e.message}`)
    } finally {
      ttsBusy = false
      
      if (ttsQueue.length > 0 && ws.readyState === WebSocket.OPEN) {
        setTimeout(() => processTTSQueue(), 50)
      }
    }
  }

  // Enhanced transcript handling with comprehensive history management
  const handleTranscript = async (text, isFinal = false, confidence = 1.0) => {
    try {
      const clean = (text || "").trim()
      if (!clean) return
      
      const wordCount = clean.split(/\s+/).filter(Boolean).length
      const timestamp = Date.now()
      
      console.log(`[${ts()}] [TRANSCRIPT-${isFinal ? 'FINAL' : 'INTERIM'}] words=${wordCount} conf=${confidence.toFixed(2)} text="${clean}"`)
      
      if (!isFinal) {
        // Handle interim transcript for interruption detection
        const isInterruption = conversationHistory.handleInterimTranscript(clean, timestamp)
        
        if (isInterruption) {
          // Immediately stop all TTS operations
          clearAllTTSOperations()
          userSpeechDetected = true
          lastUserInputTime = timestamp
          
          // Clear any silence timer
          if (silenceTimer) {
            clearTimeout(silenceTimer)
            silenceTimer = null
          }
          
          console.log(`[${ts()}] [INTERRUPTION-DETECTED] interim_text="${clean}"`)
        }
        
        // Process high-quality interim transcripts for faster response
        if (wordCount >= 3 && confidence >= 0.7) {
          // Don't process interim if user is still speaking
          return
        }
      } else {
        // Handle final transcript
        conversationHistory.addUserTranscript(clean, timestamp)
        
        // Reset user speech detection after a brief delay
        userSpeechDetected = false
        
        // Set silence timer to detect when user stops speaking
        if (silenceTimer) clearTimeout(silenceTimer)
        silenceTimer = setTimeout(() => {
          userSpeechDetected = false
          console.log(`[${ts()}] [SILENCE-DETECTED] user_stopped_speaking`)
        }, LATENCY_CONFIG.SILENCE_DETECTION_MS)
        
        // Process the final transcript
        await processUserInput(clean)
      }
      
    } catch (e) {
      console.log(`[${ts()}] [TRANSCRIPT-ERROR] ${e.message}`)
    }
  }

  // Enhanced user input processing
  const processUserInput = async (userText) => {
    try {
      const sessionId = ++currentLLMSession
      let responseText = ""
      let lastLen = 0
      
      console.log(`[${ts()}] [USER-INPUT] processing session=${sessionId} text="${userText}"`)
      
      // Get full conversation history for better context
      const fullHistory = conversationHistory.getConversationHistory()
      
      const shouldFlush = (prevLen, currText) => {
        const newContent = currText.slice(prevLen).trim()
        const words = newContent.split(/\s+/).filter(Boolean).length
        
        // More aggressive flushing for lower latency
        if (words >= 3) return true
        if (/[.!?]\s*$/.test(newContent)) return true
        if (/[,;:]\s*$/.test(newContent)) return true
        if (newContent.length >= 25) return true
        
        return false
      }
      
      const finalText = await respondWithOpenAIStream(userText, fullHistory, async (accum, delta, llmSessionId) => {
        // Skip if this session is outdated
        if (llmSessionId !== sessionId) {
          console.log(`[${ts()}] [LLM-OUTDATED] session=${llmSessionId} current=${sessionId}`)
          return
        }
        
        // Skip if user is speaking
        if (userSpeechDetected && Date.now() - lastUserInputTime < LATENCY_CONFIG.INTERRUPTION_GRACE_MS) {
          console.log(`[${ts()}] [LLM-SKIP] user_still_speaking`)
          return
        }
        
        responseText = accum
        
        if (!accum || accum.length <= lastLen) return
        if (!shouldFlush(lastLen, accum)) return
        
        const chunk = accum.slice(lastLen).trim()
        if (!chunk) return
        
        lastLen = accum.length
        console.log(`[${ts()}] [LLM-FLUSH] session=${sessionId} chunk_len=${chunk.length} chunk="${chunk}"`)
        queueSpeech(chunk, false)
      }, sessionId)
      
      // Handle final chunk
      if (finalText && finalText.length > lastLen && sessionId === currentLLMSession) {
        const tail = finalText.slice(lastLen).trim()
        if (tail) {
          console.log(`[${ts()}] [LLM-FINAL] session=${sessionId} tail_len=${tail.length} tail="${tail}"`)
          queueSpeech(tail, true)
        }
      }
      
      // Add response to history if successful
      if (finalText && sessionId === currentLLMSession) {
        conversationHistory.addAssistantResponse(finalText)
        console.log(`[${ts()}] [RESPONSE-COMPLETE] session=${sessionId} response_len=${finalText.length}`)
      }
      
    } catch (e) {
      console.log(`[${ts()}] [USER-INPUT-ERROR] ${e.message}`)
    }
  }

  const bootDeepgram = (retryCount = 0) => {
    const MAX_RETRIES = 3
    const RETRY_DELAY = 1000 * Math.pow(2, retryCount)
    
    console.log(`[${ts()}] [DEEPGRAM-BOOT] attempt=${retryCount + 1}/${MAX_RETRIES + 1}`)
    
    deepgramWs = connectDeepgram()
    
    deepgramWs.onopen = () => {
      deepgramReady = true
      console.log(`[${ts()}] 🎤 [DEEPGRAM] connected successfully; queued_packets=${dgQueue.length}`)
      
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
            await handleTranscript(transcript, msg.is_final, confidence)
          }
        } else if (msg.type === "Metadata") {
          console.log(`[${ts()}] [DEEPGRAM-META] ${JSON.stringify(msg)}`)
        } else if (msg.type === "UtteranceEnd") {
          console.log(`[${ts()}] [DEEPGRAM-UTTERANCE-END] user_finished_speaking`)
          // Additional signal that user has stopped speaking
          userSpeechDetected = false
        }
      } catch (e) {
        console.log(`[${ts()}] [DEEPGRAM-MSG-ERROR] ${e.message}`)
      }
    }
    
    deepgramWs.onerror = (e) => { 
      deepgramReady = false
      console.log(`[${ts()}] ⚠ [DEEPGRAM] error: ${e?.message || e?.type || 'unknown'}`) 
    }
    
    deepgramWs.onclose = (e) => { 
      deepgramReady = false
      console.log(`[${ts()}] 🔌 [DEEPGRAM] closed code=${e?.code} reason="${e?.reason || 'none'}"`)
      
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
          
          // Clear all previous state
          conversationHistory.clear()
          clearAllTTSOperations()
          
          // Reset session counters
          currentLLMSession = 0
          currentTTSSession = 0
          ws.currentTTSSession = 0
          userSpeechDetected = false
          lastUserInputTime = 0
          
          // Reset latency markers
          sttStartTs = Date.now()
          firstMediaTs = null
          firstForwardToDgTs = null
          firstDgMsgTs = null
          
          // Clear any timers
          if (silenceTimer) {
            clearTimeout(silenceTimer)
            silenceTimer = null
          }
          
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
              if (dgQueue.length % 100 === 0) {
                console.log(`[${ts()}] ⏳ [DEEPGRAM-QUEUE] queued_packets=${dgQueue.length}`)
              }
            }
          }
          break
          
        case "stop":
          console.log(`[${ts()}] 🛑 [SANPBX] stop`)
          
          // Clean shutdown
          clearAllTTSOperations()
          if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) deepgramWs.close()
          if (silenceTimer) {
            clearTimeout(silenceTimer)
            silenceTimer = null
          }
          
          // Log final conversation history
          const finalHistory = conversationHistory.getFullHistory()
          console.log(`[${ts()}] [CONVERSATION-END] total_entries=${finalHistory.length}`)
          finalHistory.forEach((entry, idx) => {
            console.log(`[${ts()}] [HISTORY-${idx + 1}] ${entry.role}: "${entry.content}"`)
          })
          
          break
          
        default:
          console.log(`[${ts()}] [SANPBX] unknown_event=${data.event}`)
          break
      }
    } catch (e) {
      console.log(`[${ts()}] [SANPBX-MSG-ERROR] ${e.message}`)
    }
  })

  ws.on("close", () => {
    console.log(`[${ts()}] 🔌 [SANPBX] ws closed`)
    
    // Cleanup
    clearAllTTSOperations()
    if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) deepgramWs.close()
    if (silenceTimer) {
      clearTimeout(silenceTimer)
      silenceTimer = null
    }
  })

  ws.on("error", (e) => {
    console.log(`[${ts()}] [SANPBX-WS-ERROR] ${e.message}`)
  })
}

module.exports = { setupSanPbxWebSocketServer }