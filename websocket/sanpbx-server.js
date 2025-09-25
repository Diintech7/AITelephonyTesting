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
  inactivityTimeout: 120, // Reduced timeout
}

// OPTIMIZED latency configuration - much more aggressive
const LATENCY_CONFIG = {
  INTERIM_MIN_WORDS: 1,
  INTERIM_DEBOUNCE_MS: 25,        // Faster interruption detection
  CONFIDENCE_THRESHOLD: 0.3,       // Lower for faster detection
  WORD_ACCUMULATION_MS: 50,
  TTS_MIN_CHARS: 8,               // Longer minimum for complete sentences
  TTS_DEBOUNCE_MS: 200,           // Allow more time for complete phrases
  SILENCE_DETECTION_MS: 500,      // Longer silence detection to avoid premature interruption
  INTERRUPTION_GRACE_MS: 800,     // Longer grace period to finish current sentence
  MAX_CONCURRENT_TTS: 1,          // Only one TTS at a time
  SENTENCE_COMPLETION_MS: 1000,   // Time to allow sentence completion
}

// History management configuration
const HISTORY_CONFIG = {
  MAX_HISTORY_LENGTH: 20,
  TRANSCRIPT_MERGE_TIMEOUT: 2000,
  MIN_TRANSCRIPT_WORDS: 1,
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

// Optimized downsample function
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

// IMPROVED: Sequential SIP audio streaming to prevent overlap
const streamPcmToSanPBX = async (ws, { streamId, callId, channelId }, pcmBase64, sessionId, priority = 'normal') => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  if (!streamId || !callId || !channelId) return false
  
  const CHUNK_SIZE = 320
  const audioBuffer = Buffer.from(pcmBase64, 'base64')
  const totalBytes = audioBuffer.length
  const totalChunks = Math.ceil(totalBytes / CHUNK_SIZE)
  
  console.log(`[${ts()}] [SIP-AUDIO-START] session=${sessionId || 'n/a'} priority=${priority} format=PCM16 mono sample_rate=8000Hz chunk_bytes=${CHUNK_SIZE} total_bytes=${totalBytes} total_chunks=${totalChunks}`)
  
  let position = 0
  let sentChunks = 0
  
  while (position < audioBuffer.length && ws.readyState === WebSocket.OPEN) {
    // More lenient session checking - allow completion if already started
    if (sessionId && ws.currentTTSSession !== sessionId && priority !== 'high') {
      const remainingMs = ((audioBuffer.length - position) / CHUNK_SIZE) * 20
      if (remainingMs > LATENCY_CONFIG.SENTENCE_COMPLETION_MS) {
        console.log(`[${ts()}] [SIP-AUDIO-INTERRUPTED] session=${sessionId} current=${ws.currentTTSSession} remaining_ms=${remainingMs}`)
        return false
      } else {
        console.log(`[${ts()}] [SIP-AUDIO-COMPLETING] session=${sessionId} remaining_ms=${remainingMs}`)
      }
    }
    
    const chunk = audioBuffer.slice(position, position + CHUNK_SIZE)
    const padded = chunk.length < CHUNK_SIZE ? Buffer.concat([chunk, Buffer.alloc(CHUNK_SIZE - chunk.length)]) : chunk
    const message = { event: "reverse-media", payload: padded.toString('base64'), streamId, channelId, callId }

    try { 
      ws.send(JSON.stringify(message)) 
      sentChunks++
    } catch (_) { 
      return false 
    }
    
    position += CHUNK_SIZE
    
    // Adaptive delay based on priority
    if (position < audioBuffer.length) {
      const delay = priority === 'high' ? 15 : 20
      await new Promise(r => setTimeout(r, delay))
    }
    
    if (sentChunks % 50 === 0) {
      console.log(`[${ts()}] [SIP-AUDIO] sent_chunks=${sentChunks}/${totalChunks}`)
    }
  }
  
  // Send silence frames for clean audio ending
  if (!sessionId || ws.currentTTSSession === sessionId || priority === 'high') {
    try {
      for (let i = 0; i < 3; i++) {
        const silence = Buffer.alloc(CHUNK_SIZE).toString('base64')
        ws.send(JSON.stringify({ event: "reverse-media", payload: silence, streamId, channelId, callId }))
        await new Promise(r => setTimeout(r, 20))
      }
    } catch (_) {}
  }
  
  console.log(`[${ts()}] [SIP-AUDIO-END] session=${sessionId || 'n/a'} total_bytes=${totalBytes} total_chunks=${totalChunks} sent_chunks=${sentChunks}`)
  return true
}

// IMPROVED: Better queue management with completion tracking
const ensureSipQueue = (ws) => {
  if (!ws.__sipQueue) {
    ws.__sipQueue = []
    ws.__sipSending = false
    ws.__activeSipSessions = new Set()
  }
}

const processSipQueue = async (ws) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  if (ws.__sipSending) return
  ws.__sipSending = true
  
  try {
    while (ws.readyState === WebSocket.OPEN && ws.__sipQueue && ws.__sipQueue.length > 0) {
      const item = ws.__sipQueue.shift()
      const { ids, pcmBase64, sessionId, resolve, priority } = item
      
      ws.__activeSipSessions.add(sessionId)
      let ok = false
      try {
        ok = await streamPcmToSanPBX(ws, ids, pcmBase64, sessionId, priority)
      } catch (_) {}
      
      ws.__activeSipSessions.delete(sessionId)
      try { resolve(ok) } catch (_) {}
    }
  } finally {
    ws.__sipSending = false
    if (ws.__sipQueue && ws.__sipQueue.length > 0 && ws.readyState === WebSocket.OPEN) {
      setImmediate(() => processSipQueue(ws))
    }
  }
}

const enqueuePcmToSip = (ws, ids, pcmBase64, sessionId, priority = 'normal') => {
  return new Promise((resolve) => {
    ensureSipQueue(ws)
    ws.__sipQueue.push({ ids, pcmBase64, sessionId, resolve, priority })
    processSipQueue(ws)
  })
}

// OPTIMIZED: ElevenLabs streaming with better buffering and completion
const elevenLabsStreamTTS = async (text, ws, ids, sessionId, priority = 'normal') => {
  return new Promise(async (resolve) => {
    try {
      if (!API_KEYS.elevenlabs) throw new Error("Missing ELEVEN_API_KEY")
      const url = `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVEN_CONFIG.voiceId)}/stream-input?model_id=${encodeURIComponent(ELEVEN_CONFIG.modelId)}&inactivity_timeout=${ELEVEN_CONFIG.inactivityTimeout}&output_format=pcm_16000`
      const headers = { 'xi-api-key': API_KEYS.elevenlabs }
      const elWs = new WebSocket(url, { headers })

      let opened = false
      let resolved = false
      let audioStarted = false
      let totalSentBytes = 0

      const safeResolve = (ok) => { 
        if (!resolved) { 
          resolved = true
          try { elWs.close() } catch (_) {}
          resolve(ok) 
        } 
      }

      let keepAlive = null

      elWs.on("open", () => {
        // Less aggressive session checking for completion
        if (sessionId && ws.currentTTSSession !== sessionId && priority !== 'high') {
          console.log(`[${ts()}] [11L-WS] session_invalid_on_open session=${sessionId} current=${ws.currentTTSSession}`)
          safeResolve(false)
          return
        }
        
        opened = true
        console.log(`[${ts()}] [11L-WS] open session=${sessionId} priority=${priority}`)
        const initMsg = {
          text: " ",
          xi_api_key: API_KEYS.elevenlabs,
          voice_settings: { 
            stability: 0.4, 
            similarity_boost: 0.75, 
            style: 0.2 
          },
          generation_config: { 
            chunk_length_schedule: [100, 160, 250] // Smaller chunks for faster streaming
          },
        }
        try { elWs.send(JSON.stringify(initMsg)) } catch (_) {}
        try { elWs.send(JSON.stringify({ text: text + " " })) } catch (_) {}
        try { elWs.send(JSON.stringify({ flush: true })) } catch (_) {}
        
        keepAlive = setInterval(() => {
          // More lenient keepalive checking
          if (sessionId && ws.currentTTSSession !== sessionId && priority !== 'high' && !audioStarted) {
            console.log(`[${ts()}] [11L-WS] session_expired_keepalive session=${sessionId}`)
            safeResolve(false)
            return
          }
          try { elWs.send(JSON.stringify({ text: " " })) } catch (_) {}
        }, 8000)
      })

      let firstAudioAt = null
      let pcm8kAcc = Buffer.alloc(0)
      const FRAME_BYTES = 320
      let lastEnqueuePromise = Promise.resolve(true)

      elWs.on("message", async (data) => {
        try {
          // More lenient session checking during playback
          if (sessionId && ws.currentTTSSession !== sessionId && priority !== 'high' && !audioStarted) {
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
              if (!firstAudioAt) {
                firstAudioAt = Date.now()
                audioStarted = true
              }
              const pcm8kBuf = downsamplePcm16kTo8k(pcm16kBuf)
              
              pcm8kAcc = Buffer.concat([pcm8kAcc, pcm8kBuf])
              
              // Smaller buffer for lower latency
              if (pcm8kAcc.length >= FRAME_BYTES * 3) {
                const fullFrames = Math.floor(pcm8kAcc.length / FRAME_BYTES)
                const sendLen = fullFrames * FRAME_BYTES
                const toSend = pcm8kAcc.slice(0, sendLen)
                const remainder = pcm8kAcc.slice(sendLen)
                pcm8kAcc = remainder
                totalSentBytes += toSend.length
                lastEnqueuePromise = enqueuePcmToSip(ws, ids, toSend.toString('base64'), sessionId, priority)
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
              if (!firstAudioAt) {
                firstAudioAt = Date.now()
                audioStarted = true
              }
              
              const pcm8kBuf = downsamplePcm16kTo8k(pcm16kBuf)
              pcm8kAcc = Buffer.concat([pcm8kAcc, pcm8kBuf])
              
              if (pcm8kAcc.length >= FRAME_BYTES * 3) {
                const fullFrames = Math.floor(pcm8kAcc.length / FRAME_BYTES)
                const sendLen = fullFrames * FRAME_BYTES
                const toSend = pcm8kAcc.slice(0, sendLen)
                const remainder = pcm8kAcc.slice(sendLen)
                pcm8kAcc = remainder
                totalSentBytes += toSend.length
                lastEnqueuePromise = enqueuePcmToSip(ws, ids, toSend.toString('base64'), sessionId, priority)
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
        console.log(`[${ts()}] [11L-WS] close session=${sessionId} audio_started=${audioStarted} sent_bytes=${totalSentBytes}`)
        try {
          // Send remaining audio
          if (pcm8kAcc.length > 0) {
            const fullFrames = Math.floor(pcm8kAcc.length / FRAME_BYTES)
            let toSendBuf
            if (fullFrames >= 1) {
              const sendLen = fullFrames * FRAME_BYTES
              toSendBuf = pcm8kAcc.slice(0, sendLen)
            } else {
              toSendBuf = Buffer.concat([pcm8kAcc, Buffer.alloc(FRAME_BYTES - pcm8kAcc.length)])
            }
            totalSentBytes += toSendBuf.length
            lastEnqueuePromise = enqueuePcmToSip(ws, ids, toSendBuf.toString('base64'), sessionId, priority)
          }
        } catch (_) {}
        
        if (keepAlive) { 
          clearInterval(keepAlive)
          keepAlive = null 
        }
        
        try { await lastEnqueuePromise } catch (_) {}
        
        if (totalSentBytes <= 0) {
          console.log(`[${ts()}] [11L-NO-AUDIO] session=${sessionId}`)
          safeResolve(false)
        } else {
          console.log(`[${ts()}] [11L-COMPLETED] session=${sessionId} bytes=${totalSentBytes}`)
          safeResolve(true)
        }
      })

      setTimeout(() => {
        if (!opened) {
          console.log(`[${ts()}] [11L-WS] timeout opening`)
          safeResolve(false)
        }
      }, 8000)
    } catch (e) {
      console.log(`[${ts()}] [11L-WS] setup_error ${e.message}`)
      resolve(false)
    }
  })
}

// OPTIMIZED: OpenAI streaming with faster response
const respondWithOpenAIStream = async (userMessage, fullHistory = [], onPartial = null, sessionId = null) => {
  const recentHistory = fullHistory.slice(-8) // Reduced for faster processing
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
      max_tokens: 80,  // Reduced for faster response
      temperature: 0.1,
      stream: true,
      presence_penalty: 0.2,
      frequency_penalty: 0.1
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
  url.searchParams.append("endpointing", "300") // Faster endpointing
  
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

  addUserTranscript(text, timestamp = Date.now()) {
    const clean = text.trim()
    if (!clean || clean.split(/\s+/).length < HISTORY_CONFIG.MIN_TRANSCRIPT_WORDS) return
    
    if (this.transcriptMergeTimer) {
      clearTimeout(this.transcriptMergeTimer)
      this.transcriptMergeTimer = null
    }
    
    const lastEntry = this.entries[this.entries.length - 1]
    const timeDiff = timestamp - this.lastTranscriptTime
    
    if (lastEntry && 
        lastEntry.role === "user" && 
        timeDiff < HISTORY_CONFIG.TRANSCRIPT_MERGE_TIMEOUT &&
        !lastEntry.content.endsWith('.') &&
        !lastEntry.content.endsWith('!') &&
        !lastEntry.content.endsWith('?')) {
      
      lastEntry.content += " " + clean
      lastEntry.timestamp = timestamp
      console.log(`[${ts()}] [HISTORY] merged_user_transcript="${lastEntry.content}"`)
    } else {
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

  handleInterimTranscript(text, timestamp = Date.now()) {
    const clean = text.trim()
    if (!clean) return false
    
    this.pendingTranscript = clean
    this.lastTranscriptTime = timestamp
    
    if (this.transcriptMergeTimer) {
      clearTimeout(this.transcriptMergeTimer)
    }
    
    this.transcriptMergeTimer = setTimeout(() => {
      if (this.pendingTranscript) {
        this.addUserTranscript(this.pendingTranscript, this.lastTranscriptTime)
        this.pendingTranscript = ""
      }
    }, HISTORY_CONFIG.TRANSCRIPT_MERGE_TIMEOUT)
    
    const wordCount = clean.split(/\s+/).length
    return wordCount >= 2 // Require at least 2 words for interruption
  }

  getConversationHistory() {
    return this.entries.map(entry => ({
      role: entry.role,
      content: entry.content
    }))
  }

  getFullHistory() {
    return [...this.entries]
  }

  trimHistory() {
    if (this.entries.length > HISTORY_CONFIG.MAX_HISTORY_LENGTH) {
      const removed = this.entries.splice(0, this.entries.length - HISTORY_CONFIG.MAX_HISTORY_LENGTH)
      console.log(`[${ts()}] [HISTORY] trimmed ${removed.length} old entries`)
    }
  }

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
  
  const conversationHistory = new ConversationHistory()
  
  // Improved session management
  let currentLLMSession = 0
  let currentTTSSession = 0
  ws.currentTTSSession = 0
  
  // STT latency markers
  let sttStartTs = null
  let firstMediaTs = null
  let firstForwardToDgTs = null
  let firstDgMsgTs = null
  
  // User speech detection with completion tracking
  let userSpeechDetected = false
  let lastUserInputTime = 0
  let silenceTimer = null
  let activeTTSSessions = new Set()
  
  const sendGreeting = async () => {
    try {
      const sessionId = ++currentTTSSession
      ws.currentTTSSession = sessionId
      activeTTSSessions.add(sessionId)
      
      const ok = await elevenLabsStreamTTS(STATIC.firstMessage, ws, ids, sessionId, 'high')
      if (ok) {
        conversationHistory.addAssistantResponse(STATIC.firstMessage)
      }
      activeTTSSessions.delete(sessionId)
    } catch (_) {}
  }

  // IMPROVED: Smarter TTS queue with sentence completion
  let ttsQueue = []
  let ttsBusy = false
  let speakBuffer = ""
  let speakDebounceTimer = null
  const PUNCTUATION_FLUSH = /([.!?]\s?$|[;:，。！？]$|\n\s*$)/
  const SENTENCE_BOUNDARIES = /([.!?]+\s+|[.!?]+$)/
  
  // Smart interruption handling - only interrupt between sentences
  const clearTTSOperations = (forceAll = false) => {
    if (forceAll) {
      // Emergency stop - clear everything
      ttsQueue = []
      ttsBusy = false
      speakBuffer = ""
      if (speakDebounceTimer) {
        clearTimeout(speakDebounceTimer)
        speakDebounceTimer = null
      }
      const oldSession = currentTTSSession
      currentTTSSession += 2
      ws.currentTTSSession = currentTTSSession
      activeTTSSessions.clear()
      console.log(`[${ts()}] [INTERRUPTION] force_cleared_all_tts old_session=${oldSession} new_session=${currentTTSSession}`)
    } else {
      // Gentle stop - let current sentence finish
      ttsQueue = []
      const oldSession = currentTTSSession
      currentTTSSession += 1
      console.log(`[${ts()}] [INTERRUPTION] cleared_queue_only old_session=${oldSession} new_session=${currentTTSSession}`)
    }
  }
  
  const isCompleteSentence = (text) => {
    const trimmed = text.trim()
    return /[.!?]$/.test(trimmed) || 
           /[.!?]\s+\w/.test(trimmed) ||
           trimmed.split(/[.!?]+/).length > 1
  }
  
  const flushSpeakBuffer = (reason = "debounce") => {
    const chunk = speakBuffer.trim()
    speakBuffer = ""
    if (!chunk) return
    
    // More intelligent minimum length based on sentence completeness
    const minLength = isCompleteSentence(chunk) ? 3 : LATENCY_CONFIG.TTS_MIN_CHARS
    
    if (chunk.length < minLength && reason !== "punct" && reason !== "force") {
      console.log(`[${ts()}] [TTS-SKIP-FLUSH] too_short="${chunk}" reason=${reason} min_length=${minLength}`)
      speakBuffer = chunk + " "
      return
    }
    
    // Limit queue size but allow sentence completion
    if (ttsQueue.length >= 2) {
      console.log(`[${ts()}] [TTS-QUEUE-LIMIT] dropping chunk="${chunk}" queue_size=${ttsQueue.length}`)
      return
    }
    
    ttsQueue.push({ 
      text: chunk, 
      isComplete: isCompleteSentence(chunk),
      timestamp: Date.now()
    })
    console.log(`[${ts()}] [TTS-QUEUE] flush(${reason}) len=${chunk.length} complete=${isCompleteSentence(chunk)} text="${chunk}" queue=${ttsQueue.length}`)
    
    if (!ttsBusy) processTTSQueue().catch(() => {})
  }
  
  const queueSpeech = (text, force = false) => {
    if (!text || !text.trim()) return
    
    // Check for user interruption with grace period for sentence completion
    const timeSinceUserInput = Date.now() - lastUserInputTime
    const allowCompletion = activeTTSSessions.size > 0 && timeSinceUserInput < LATENCY_CONFIG.SENTENCE_COMPLETION_MS
    
    if (userSpeechDetected && timeSinceUserInput < LATENCY_CONFIG.INTERRUPTION_GRACE_MS && !allowCompletion) {
      console.log(`[${ts()}] [TTS-SKIP] user_speaking grace_period=${timeSinceUserInput}ms allow_completion=${allowCompletion}`)
      return
    }
    
    const cleanText = text.trim()
    if (cleanText.length < 1 && !force) {
      console.log(`[${ts()}] [TTS-SKIP] too_short="${cleanText}"`)
      return
    }
    
    const incoming = cleanText
    speakBuffer += (speakBuffer ? " " : "") + incoming
    const bufLen = speakBuffer.length
    const wordCount = speakBuffer.trim().split(/\s+/).filter(Boolean).length
    const punctNow = PUNCTUATION_FLUSH.test(speakBuffer)
    const completeSentence = isCompleteSentence(speakBuffer)
    
    const shouldImmediate = force || 
                           punctNow || 
                           completeSentence ||
                           bufLen >= 60 ||  // Longer for complete thoughts
                           wordCount >= 8   // More words for complete phrases
    
    if (shouldImmediate) {
      if (speakDebounceTimer) { 
        clearTimeout(speakDebounceTimer)
        speakDebounceTimer = null 
      }
      flushSpeakBuffer(punctNow ? "punct" : (completeSentence ? "sentence" : (force ? "force" : "threshold")))
      return
    }
    
    if (speakDebounceTimer) clearTimeout(speakDebounceTimer)
    speakDebounceTimer = setTimeout(() => flushSpeakBuffer("debounce"), LATENCY_CONFIG.TTS_DEBOUNCE_MS)
  }
  
  const processTTSQueue = async () => {
    if (ttsBusy) return
    ttsBusy = true
    
    try {
      while (ttsQueue.length > 0 && ws.readyState === WebSocket.OPEN) {
        // Check for urgent interruption before processing
        const timeSinceUserInput = Date.now() - lastUserInputTime
        const shouldStop = userSpeechDetected && 
                          timeSinceUserInput < LATENCY_CONFIG.INTERRUPTION_GRACE_MS &&
                          activeTTSSessions.size === 0
        
        if (shouldStop) {
          console.log(`[${ts()}] [TTS-QUEUE-INTERRUPTED] clearing_queue user_speech_detected time_since=${timeSinceUserInput}ms`)
          ttsQueue = []
          break
        }
        
        const item = ttsQueue.shift()
        const sessionId = ++currentTTSSession
        ws.currentTTSSession = sessionId
        activeTTSSessions.add(sessionId)
        
        const priority = item.isComplete ? 'normal' : 'high'
        console.log(`[${ts()}] [TTS-PLAY] start len=${item.text.length} session=${sessionId} complete=${item.isComplete} priority=${priority} text="${item.text}"`)
        
        const startTime = Date.now()
        const ok = await elevenLabsStreamTTS(item.text, ws, ids, sessionId, priority)
        const duration = Date.now() - startTime
        
        activeTTSSessions.delete(sessionId)
        
        if (ok) {
          console.log(`[${ts()}] [TTS-PLAY] success len=${item.text.length} session=${sessionId} duration=${duration}ms`)
        } else {
          console.log(`[${ts()}] [TTS-PLAY] cancelled_or_error len=${item.text.length} session=${sessionId} duration=${duration}ms`)
          // Don't clear entire queue if just one item fails
          break
        }
        
        // Very small delay for interruption detection
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    } catch (e) {
      console.log(`[${ts()}] [TTS-QUEUE-ERROR] ${e.message}`)
    } finally {
      ttsBusy = false
      
      if (ttsQueue.length > 0 && ws.readyState === WebSocket.OPEN) {
        setTimeout(() => processTTSQueue(), 25)
      }
    }
  }

  // Enhanced transcript handling with better interruption detection
  const handleTranscript = async (text, isFinal = false, confidence = 1.0) => {
    try {
      const clean = (text || "").trim()
      if (!clean) return
      
      const wordCount = clean.split(/\s+/).filter(Boolean).length
      const timestamp = Date.now()
      
      console.log(`[${ts()}] [TRANSCRIPT-${isFinal ? 'FINAL' : 'INTERIM'}] words=${wordCount} conf=${confidence.toFixed(2)} text="${clean}"`)
      
      if (!isFinal) {
        // Handle interim transcript with smarter interruption detection
        const isInterruption = conversationHistory.handleInterimTranscript(clean, timestamp)
        
        if (isInterruption && confidence >= LATENCY_CONFIG.CONFIDENCE_THRESHOLD) {
          userSpeechDetected = true
          lastUserInputTime = timestamp
          
          // Smart interruption - gentle stop first
          clearTTSOperations(false)
          
          if (silenceTimer) {
            clearTimeout(silenceTimer)
            silenceTimer = null
          }
          
          console.log(`[${ts()}] [INTERRUPTION-DETECTED] interim_text="${clean}" conf=${confidence.toFixed(2)}`)
        }
        
        return // Don't process interim transcripts
      } else {
        // Handle final transcript
        conversationHistory.addUserTranscript(clean, timestamp)
        userSpeechDetected = false
        
        // Set silence timer
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

  // Optimized user input processing with latency tracking
  const processUserInput = async (userText) => {
    try {
      const processingStartTime = Date.now()
      const sessionId = ++currentLLMSession
      let responseText = ""
      let lastLen = 0
      let firstTokenTime = null
      
      console.log(`[${ts()}] [USER-INPUT] processing session=${sessionId} text="${userText}"`)
      
      const fullHistory = conversationHistory.getConversationHistory()
      
      // Optimized flushing logic for complete thoughts
      const shouldFlush = (prevLen, currText) => {
        const newContent = currText.slice(prevLen).trim()
        const words = newContent.split(/\s+/).filter(Boolean).length
        const sentences = newContent.split(/[.!?]+/).filter(Boolean).length
        
        // Prioritize complete thoughts
        if (/[.!?]\s*$/.test(newContent)) return true
        if (sentences > 1) return true
        if (words >= 5 && /[,;:]\s*$/.test(newContent)) return true
        if (newContent.length >= 40) return true
        
        return false
      }
      
      const finalText = await respondWithOpenAIStream(userText, fullHistory, async (accum, delta, llmSessionId) => {
        if (llmSessionId !== sessionId) {
          console.log(`[${ts()}] [LLM-OUTDATED] session=${llmSessionId} current=${sessionId}`)
          return
        }
        
        if (!firstTokenTime) {
          firstTokenTime = Date.now()
          const latency = firstTokenTime - processingStartTime
          console.log(`[${ts()}] [LLM-LATENCY] first_token_ms=${latency}`)
        }
        
        const timeSinceUserInput = Date.now() - lastUserInputTime
        if (userSpeechDetected && timeSinceUserInput < LATENCY_CONFIG.INTERRUPTION_GRACE_MS) {
          console.log(`[${ts()}] [LLM-SKIP] user_still_speaking time_since=${timeSinceUserInput}ms`)
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
      
      // Handle final chunk with completion tracking
      if (finalText && finalText.length > lastLen && sessionId === currentLLMSession) {
        const tail = finalText.slice(lastLen).trim()
        if (tail) {
          console.log(`[${ts()}] [LLM-FINAL] session=${sessionId} tail_len=${tail.length} tail="${tail}"`)
          queueSpeech(tail, true)
        }
      }
      
      // Add response to history and log completion
      if (finalText && sessionId === currentLLMSession) {
        const totalLatency = Date.now() - processingStartTime
        conversationHistory.addAssistantResponse(finalText)
        console.log(`[${ts()}] [RESPONSE-COMPLETE] session=${sessionId} response_len=${finalText.length} total_latency_ms=${totalLatency}`)
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
          console.log(`[${ts()}] [DEEPGRAM-META] request_id=${msg.request_id} model=${msg.model_info?.name}`)
        } else if (msg.type === "UtteranceEnd") {
          console.log(`[${ts()}] [DEEPGRAM-UTTERANCE-END] user_finished_speaking`)
          userSpeechDetected = false
        }
      } catch (e) {
        console.log(`[${ts()}] [DEEPGRAM-MSG-ERROR] ${e.message}`)
      }
    }
    
    deepgramWs.onerror = (e) => { 
      deepgramReady = false
      console.log(`[${ts()}] ⚠️ [DEEPGRAM] error: ${e?.message || e?.type || 'unknown'}`) 
    }
    
    deepgramWs.onclose = (e) => { 
      deepgramReady = false
      console.log(`[${ts()}] 🔌 [DEEPGRAM] closed code=${e?.code} reason="${e?.reason || 'none'}"`)
      
      if (e?.code !== 1000 && retryCount < MAX_RETRIES && ids.streamId) {
        console.log(`[${ts()}] [DEEPGRAM-RETRY] retrying in ${RETRY_DELAY}ms...`)
        setTimeout(() => {
          bootDeepgram(retryCount + 1)
        }, RETRY_DELAY)
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
          
          // Complete state reset
          conversationHistory.clear()
          clearTTSOperations(true)
          
          currentLLMSession = 0
          currentTTSSession = 0
          ws.currentTTSSession = 0
          userSpeechDetected = false
          lastUserInputTime = 0
          activeTTSSessions.clear()
          
          // Reset latency tracking
          sttStartTs = Date.now()
          firstMediaTs = null
          firstForwardToDgTs = null
          firstDgMsgTs = null
          
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
            }
          }
          break
          
        case "stop":
          console.log(`[${ts()}] 🛑 [SANPBX] stop`)
          
          clearTTSOperations(true)
          if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) deepgramWs.close()
          if (silenceTimer) {
            clearTimeout(silenceTimer)
            silenceTimer = null
          }
          
          // Log conversation summary
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
    clearTTSOperations(true)
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