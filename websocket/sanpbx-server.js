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
    "Give complete answers in 1-2 short sentences only.",
    "Be direct and helpful. No follow-up questions unless necessary.",
  ].join(" "),
  firstMessage: "Hello! How can I help you today?",
}

// ElevenLabs configuration
const ELEVEN_CONFIG = {
  voiceId: process.env.ELEVEN_VOICE_ID || "Xb7hH8MSUJpSbSDYk0k2",
  modelId: process.env.ELEVEN_MODEL_ID || "eleven_turbo_v2_5", // Faster model
  inactivityTimeout: 120, // Shorter timeout
}

// Optimized for <2 second latency
const LATENCY_CONFIG = {
  INTERIM_MIN_WORDS: 2,           // Require at least 2 words for processing
  CONFIDENCE_THRESHOLD: 0.7,      // Higher confidence for accuracy
  INTERRUPTION_DEBOUNCE: 200,     // Fast interruption detection
  TTS_CHUNK_MIN_WORDS: 4,         // Larger chunks for efficiency
  TTS_BUFFER_MAX_CHARS: 80,       // Buffer more before sending
  SILENCE_TIMEOUT: 800,           // User silence detection
  LLM_MAX_TOKENS: 60,             // Shorter responses for speed
  RESPONSE_TIMEOUT: 8000,         // Max time for complete response
}

const ts = () => new Date().toISOString()

// Enhanced downsample with noise reduction
const downsamplePcm16kTo8k = (pcm16kBuf) => {
  try {
    const byteLen = pcm16kBuf.length - (pcm16kBuf.length % 2)
    if (byteLen <= 0) return pcm16kBuf
    
    const srcView = new Int16Array(pcm16kBuf.buffer, pcm16kBuf.byteOffset, byteLen / 2)
    const dstSamples = Math.floor(srcView.length / 2)
    const outView = new Int16Array(dstSamples)

    // Low-pass filter + decimation to reduce aliasing noise
    for (let i = 0, o = 0; o < dstSamples; o++, i += 2) {
      // Simple 3-tap filter to reduce aliasing
      const prev = i > 0 ? srcView[i - 1] : 0
      const curr = srcView[i] || 0
      const next = i + 1 < srcView.length ? srcView[i + 1] : 0
      
      // Weighted average for smoother output
      let filtered = (prev * 0.25 + curr * 0.5 + next * 0.25)
      
      // Clamp to prevent overflow
      if (filtered > 32767) filtered = 32767
      else if (filtered < -32768) filtered = -32768
      
      outView[o] = Math.round(filtered)
    }

    return Buffer.from(outView.buffer, outView.byteOffset, outView.byteLength)
  } catch (e) {
    console.log(`[${ts()}] [DOWNSAMPLE-ERROR] ${e.message}`)
    return pcm16kBuf
  }
}

// Optimized SIP streaming
const streamPcmToSanPBX = async (ws, { streamId, callId, channelId }, pcmBase64, sessionId) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  if (!streamId || !callId || !channelId) return false
  
  // Check session validity immediately
  if (sessionId && ws.activeTTSSession !== sessionId) {
    console.log(`[${ts()}] [SIP-CANCELLED] session=${sessionId} active=${ws.activeTTSSession}`)
    return false
  }
  
  const CHUNK_SIZE = 320
  const audioBuffer = Buffer.from(pcmBase64, 'base64')
  let position = 0
  
  console.log(`[${ts()}] [SIP-START] session=${sessionId} bytes=${audioBuffer.length}`)
  
  while (position < audioBuffer.length && ws.readyState === WebSocket.OPEN) {
    // Check for interruption on every chunk
    if (sessionId && ws.activeTTSSession !== sessionId) {
      console.log(`[${ts()}] [SIP-INTERRUPTED] session=${sessionId}`)
      return false
    }
    
    const chunk = audioBuffer.slice(position, position + CHUNK_SIZE)
    const padded = chunk.length < CHUNK_SIZE ? 
      Buffer.concat([chunk, Buffer.alloc(CHUNK_SIZE - chunk.length)]) : chunk
    
    try {
      ws.send(JSON.stringify({
        event: "reverse-media",
        payload: padded.toString('base64'),
        streamId, channelId, callId
      }))
    } catch (_) {
      return false
    }
    
    position += CHUNK_SIZE
    if (position < audioBuffer.length) {
      await new Promise(r => setTimeout(r, 15)) // Faster playback
    }
  }
  
  // Send silence frames
  if (sessionId && ws.activeTTSSession === sessionId) {
    try {
      const silence = Buffer.alloc(CHUNK_SIZE).toString('base64')
      for (let i = 0; i < 2; i++) {
        ws.send(JSON.stringify({ 
          event: "reverse-media", 
          payload: silence, 
          streamId, channelId, callId 
        }))
        await new Promise(r => setTimeout(r, 20))
      }
    } catch (_) {}
  }
  
  console.log(`[${ts()}] [SIP-END] session=${sessionId} success`)
  return true
}

// Optimized ElevenLabs streaming with better audio quality
const elevenLabsStreamTTS = async (text, ws, ids, sessionId) => {
  return new Promise(async (resolve) => {
    try {
      if (!API_KEYS.elevenlabs) throw new Error("Missing ELEVEN_API_KEY")
      
      // Set as active session
      ws.activeTTSSession = sessionId
      console.log(`[${ts()}] [TTS-START] session=${sessionId} text="${text}"`)
      
      // Use standard model for better quality
      const url = `wss://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_CONFIG.voiceId}/stream-input?model_id=eleven_multilingual_v2&output_format=pcm_16000`
      const elWs = new WebSocket(url, { 
        headers: { 'xi-api-key': API_KEYS.elevenlabs } 
      })

      let resolved = false
      let audioReceived = false
      const startTime = Date.now()
      
      const safeResolve = (success) => {
        if (resolved) return
        resolved = true
        const duration = Date.now() - startTime
        console.log(`[${ts()}] [TTS-RESOLVE] session=${sessionId} success=${success} duration=${duration}ms`)
        
        try { elWs.close() } catch (_) {}
        resolve(success)
      }

      // Longer timeout for better quality model
      const timeout = setTimeout(() => {
        console.log(`[${ts()}] [TTS-TIMEOUT] session=${sessionId}`)
        safeResolve(false)
      }, 5000)

      elWs.on("open", () => {
        // Check if still active session
        if (ws.activeTTSSession !== sessionId) {
          console.log(`[${ts()}] [TTS-OBSOLETE] session=${sessionId} active=${ws.activeTTSSession}`)
          safeResolve(false)
          return
        }
        
        console.log(`[${ts()}] [TTS-CONNECTED] session=${sessionId}`)
        
        // Initialize with high-quality settings
        const initMsg = {
          text: " ",
          xi_api_key: API_KEYS.elevenlabs,
          voice_settings: { 
            stability: 0.5,      // More stable voice
            similarity_boost: 0.8, // Higher similarity
            style: 0.3,
            use_speaker_boost: true 
          },
          generation_config: { 
            chunk_length_schedule: [100, 150, 200] // Balanced chunks
          },
        }
        
        try {
          elWs.send(JSON.stringify(initMsg))
          elWs.send(JSON.stringify({ text }))
          elWs.send(JSON.stringify({ flush: true }))
        } catch (e) {
          console.log(`[${ts()}] [TTS-SEND-ERROR] session=${sessionId} ${e.message}`)
          safeResolve(false)
        }
      })

      let pcmBuffer = Buffer.alloc(0)
      let firstAudioTime = null
      let totalAudioBytes = 0
      
      elWs.on("message", async (data) => {
        try {
          // Check session validity
          if (ws.activeTTSSession !== sessionId) {
            console.log(`[${ts()}] [TTS-STALE] session=${sessionId}`)
            safeResolve(false)
            return
          }
          
          let audioData = null
          
          if (Buffer.isBuffer(data)) {
            // Binary PCM data
            audioData = data
          } else {
            // JSON message
            try {
              const msg = JSON.parse(data.toString())
              if (msg.audio) {
                audioData = Buffer.from(msg.audio, 'base64')
              } else if (msg.isFinal) {
                console.log(`[${ts()}] [TTS-FINAL] session=${sessionId}`)
              } else if (msg.error) {
                console.log(`[${ts()}] [TTS-MSG-ERROR] session=${sessionId} ${msg.error}`)
              }
            } catch (_) {}
          }
          
          if (audioData && audioData.length > 0) {
            if (!audioReceived) {
              audioReceived = true
              firstAudioTime = Date.now()
              const latency = firstAudioTime - startTime
              console.log(`[${ts()}] [TTS-FIRST-AUDIO] session=${sessionId} latency=${latency}ms`)
            }
            
            totalAudioBytes += audioData.length
            
            // Downsample with noise reduction
            const pcm8k = downsamplePcm16kTo8k(audioData)
            pcmBuffer = Buffer.concat([pcmBuffer, pcm8k])
            
            // Stream in optimized chunks
            const STREAM_CHUNK_SIZE = 1600 // 100ms of audio for smoother playback
            while (pcmBuffer.length >= STREAM_CHUNK_SIZE) {
              const toStream = pcmBuffer.slice(0, STREAM_CHUNK_SIZE)
              pcmBuffer = pcmBuffer.slice(STREAM_CHUNK_SIZE)
              
              const success = await streamPcmToSanPBX(ws, ids, toStream.toString('base64'), sessionId)
              if (!success) {
                console.log(`[${ts()}] [TTS-STREAM-FAILED] session=${sessionId}`)
                safeResolve(false)
                return
              }
            }
          }
        } catch (e) {
          console.log(`[${ts()}] [TTS-MSG-ERROR] session=${sessionId} ${e.message}`)
        }
      })

      elWs.on("close", async () => {
        console.log(`[${ts()}] [TTS-CLOSED] session=${sessionId} total_audio=${totalAudioBytes}bytes`)
        
        // Stream remaining audio
        if (pcmBuffer.length > 0 && ws.activeTTSSession === sessionId) {
          try {
            // Pad to minimum chunk size if needed
            const minSize = 320
            if (pcmBuffer.length < minSize) {
              pcmBuffer = Buffer.concat([pcmBuffer, Buffer.alloc(minSize - pcmBuffer.length)])
            }
            await streamPcmToSanPBX(ws, ids, pcmBuffer.toString('base64'), sessionId)
          } catch (_) {}
        }
        
        clearTimeout(timeout)
        safeResolve(audioReceived && totalAudioBytes > 0)
      })

      elWs.on("error", (e) => {
        console.log(`[${ts()}] [TTS-ERROR] session=${sessionId} ${e.message}`)
        clearTimeout(timeout)
        safeResolve(false)
      })

    } catch (e) {
      console.log(`[${ts()}] [TTS-SETUP-ERROR] session=${sessionId} ${e.message}`)
      resolve(false)
    }
  })
}

// Optimized OpenAI streaming
const respondWithOpenAIStream = async (userMessage, history = []) => {
  const messages = [
    { role: "system", content: STATIC.systemPrompt },
    ...history.slice(-4), // Keep minimal history for speed
    { role: "user", content: userMessage },
  ]
  
  console.log(`[${ts()}] [LLM-START] message="${userMessage}" history=${history.length}`)
  const startTime = Date.now()
  
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json", 
        Authorization: `Bearer ${API_KEYS.openai}` 
      },
      body: JSON.stringify({ 
        model: "gpt-4o-mini", 
        messages, 
        max_tokens: LATENCY_CONFIG.LLM_MAX_TOKENS,
        temperature: 0.3,
        stream: true,
        frequency_penalty: 0.2 // Reduce repetition
      }),
    })
    
    if (!res.ok || !res.body) {
      console.log(`[${ts()}] [LLM-ERROR] status=${res.status}`)
      return null
    }
    
    const reader = res.body.getReader()
    const decoder = new TextDecoder("utf-8")
    let buffer = ""
    let result = ""
    let tokenCount = 0
    let firstToken = false
    
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ""
      
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed === "data: [DONE]") continue
        
        if (trimmed.startsWith("data:")) {
          try {
            const json = JSON.parse(trimmed.slice(5).trim())
            const delta = json.choices?.[0]?.delta?.content || ""
            
            if (delta) {
              if (!firstToken) {
                firstToken = true
                const latency = Date.now() - startTime
                console.log(`[${ts()}] [LLM-FIRST-TOKEN] latency=${latency}ms`)
              }
              
              result += delta
              tokenCount++
            }
          } catch (_) {}
        }
      }
    }
    
    const totalTime = Date.now() - startTime
    console.log(`[${ts()}] [LLM-COMPLETE] tokens=${tokenCount} time=${totalTime}ms response="${result}"`)
    
    return result.trim() || null
    
  } catch (e) {
    console.log(`[${ts()}] [LLM-STREAM-ERROR] ${e.message}`)
    return null
  }
}

const connectDeepgram = (language = STATIC.deepgramLanguage) => {
  // Use basic configuration that works reliably
  const url = new URL("wss://api.deepgram.com/v1/listen")
  url.searchParams.append("sample_rate", "8000")  // Match SanPBX sample rate
  url.searchParams.append("channels", "1")
  url.searchParams.append("encoding", "linear16") 
  url.searchParams.append("language", language)
  url.searchParams.append("interim_results", "true")
  url.searchParams.append("model", "nova-2")
  // Remove utterance_end_ms as it might cause issues
  
  console.log(`[${ts()}] [DEEPGRAM-CONNECT] ${url.toString()}`)
  console.log(`[${ts()}] [DEEPGRAM-AUTH] key=${API_KEYS.deepgram ? 'present' : 'missing'}`)
  
  return new WebSocket(url.toString(), { 
    headers: { Authorization: `Token ${API_KEYS.deepgram}` } 
  })
}

// Simplified conversation history
class FastHistory {
  constructor() {
    this.entries = []
    this.lastUserText = ""
    this.lastUserTime = 0
  }

  addUser(text) {
    const clean = text.trim()
    if (!clean || clean.length < 2) return
    
    // Simple deduplication
    if (clean === this.lastUserText && Date.now() - this.lastUserTime < 2000) {
      return
    }
    
    this.lastUserText = clean
    this.lastUserTime = Date.now()
    
    this.entries.push({ role: "user", content: clean })
    this.trim()
    
    console.log(`[${ts()}] [HISTORY-USER] "${clean}"`)
  }

  addAssistant(text) {
    const clean = text.trim()
    if (!clean) return
    
    this.entries.push({ role: "assistant", content: clean })
    this.trim()
    
    console.log(`[${ts()}] [HISTORY-ASSISTANT] "${clean}"`)
  }

  getHistory() {
    return this.entries.slice()
  }

  trim() {
    if (this.entries.length > 8) {
      this.entries = this.entries.slice(-6)
    }
  }

  clear() {
    this.entries = []
    this.lastUserText = ""
    this.lastUserTime = 0
  }
}

const setupSanPbxWebSocketServer = (ws) => {
  let ids = { streamId: null, callId: null, channelId: null }
  let deepgramWs = null
  let deepgramReady = false
  let dgQueue = []
  
  const history = new FastHistory()
  
  // Simplified state management
  let sessionCounter = 0
  ws.activeTTSSession = null
  let userSpeaking = false
  let lastUserInput = 0
  let silenceTimer = null
  let processingLock = false

  const sendGreeting = async () => {
    try {
      const sessionId = ++sessionCounter
      const success = await elevenLabsStreamTTS(STATIC.firstMessage, ws, ids, sessionId)
      if (success) {
        history.addAssistant(STATIC.firstMessage)
      }
    } catch (_) {}
  }

  const stopAllTTS = () => {
    const oldSession = ws.activeTTSSession
    ws.activeTTSSession = null
    console.log(`[${ts()}] [STOP-TTS] stopped_session=${oldSession}`)
  }

  const handleUserSpeech = (text, isFinal = false, confidence = 1.0) => {
    const clean = text.trim()
    if (!clean) return
    
    const wordCount = clean.split(/\s+/).length
    const now = Date.now()
    
    console.log(`[${ts()}] [SPEECH-${isFinal ? 'FINAL' : 'INTERIM'}] words=${wordCount} conf=${confidence.toFixed(2)} text="${clean}"`)
    
    if (!isFinal) {
      // Interrupt on any speech detection
      if (wordCount >= LATENCY_CONFIG.INTERIM_MIN_WORDS) {
        if (!userSpeaking) {
          userSpeaking = true
          lastUserInput = now
          stopAllTTS()
          console.log(`[${ts()}] [INTERRUPT] user_started_speaking`)
        }
      }
      return
    }
    
    // Handle final transcript
    if (wordCount < 1 || confidence < LATENCY_CONFIG.CONFIDENCE_THRESHOLD) {
      console.log(`[${ts()}] [SPEECH-IGNORE] low_quality words=${wordCount} conf=${confidence}`)
      return
    }
    
    // Add to history and process
    history.addUser(clean)
    userSpeaking = false
    
    // Set silence detection
    if (silenceTimer) clearTimeout(silenceTimer)
    silenceTimer = setTimeout(() => {
      userSpeaking = false
      console.log(`[${ts()}] [SILENCE] user_stopped`)
    }, LATENCY_CONFIG.SILENCE_TIMEOUT)
    
    // Process immediately without debouncing
    processUserInput(clean)
  }

  const processUserInput = async (userText) => {
    if (processingLock) {
      console.log(`[${ts()}] [PROCESS-SKIP] already_processing`)
      return
    }
    
    processingLock = true
    const startTime = Date.now()
    
    try {
      console.log(`[${ts()}] [PROCESS-START] text="${userText}"`)
      
      // Get LLM response in one go (no streaming for simplicity and speed)
      const response = await respondWithOpenAIStream(userText, history.getHistory())
      
      if (!response) {
        console.log(`[${ts()}] [PROCESS-FAILED] no_response`)
        return
      }
      
      // Check if user is still quiet
      const timeSinceUserInput = Date.now() - lastUserInput
      if (userSpeaking && timeSinceUserInput < LATENCY_CONFIG.INTERRUPTION_DEBOUNCE) {
        console.log(`[${ts()}] [PROCESS-SKIP] user_still_speaking delay=${timeSinceUserInput}ms`)
        return
      }
      
      // Add to history and speak
      history.addAssistant(response)
      
      const sessionId = ++sessionCounter
      const success = await elevenLabsStreamTTS(response, ws, ids, sessionId)
      
      const totalTime = Date.now() - startTime
      console.log(`[${ts()}] [PROCESS-COMPLETE] success=${success} total_time=${totalTime}ms`)
      
    } catch (e) {
      console.log(`[${ts()}] [PROCESS-ERROR] ${e.message}`)
    } finally {
      processingLock = false
    }
  }

  const bootDeepgram = () => {
    console.log(`[${ts()}] [DEEPGRAM-BOOT]`)
    
    deepgramWs = connectDeepgram()
    
    deepgramWs.onopen = () => {
      deepgramReady = true
      console.log(`[${ts()}] [DEEPGRAM-READY] queued=${dgQueue.length}`)
      
      // Send queued packets
      dgQueue.forEach(packet => {
        if (deepgramWs.readyState === WebSocket.OPEN) {
          deepgramWs.send(packet)
        }
      })
      dgQueue = []
    }
    
    deepgramWs.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data)
        
        if (msg.type === "Results") {
          const alt = msg.channel?.alternatives?.[0]
          if (alt?.transcript) {
            handleUserSpeech(alt.transcript, msg.is_final, alt.confidence || 1.0)
          }
        } else if (msg.type === "UtteranceEnd") {
          console.log(`[${ts()}] [UTTERANCE-END]`)
          userSpeaking = false
        } else if (msg.type === "Metadata") {
          console.log(`[${ts()}] [DEEPGRAM-META] request_id=${msg.request_id}`)
        }
      } catch (e) {
        console.log(`[${ts()}] [DEEPGRAM-MSG-ERROR] ${e.message}`)
      }
    }
    
    deepgramWs.onerror = (e) => {
      deepgramReady = false
      console.log(`[${ts()}] [DEEPGRAM-ERROR] ${e.message}`)
    }
    
    deepgramWs.onclose = (evt) => {
      deepgramReady = false
      console.log(`[${ts()}] [DEEPGRAM-CLOSED] code=${evt.code} reason=${evt.reason}`)
      
      // Retry connection if needed
      if (ids.streamId && evt.code !== 1000) {
        console.log(`[${ts()}] [DEEPGRAM-RETRY] reconnecting in 2s...`)
        setTimeout(() => {
          if (ids.streamId) { // Check if still needed
            bootDeepgram()
          }
        }, 2000)
      }
    }
  }

  // WebSocket message handling
  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message.toString())
      
      switch (data.event) {
        case "connected":
          console.log(`[${ts()}] [CONNECTED]`)
          break
          
        case "start":
          console.log(`[${ts()}] [START] ${JSON.stringify({streamId: data.streamId, callId: data.callId})}`)
          
          // Initialize state
          ids = { 
            streamId: data.streamId, 
            callId: data.callId, 
            channelId: data.channelId 
          }
          
          history.clear()
          stopAllTTS()
          userSpeaking = false
          processingLock = false
          sessionCounter = 0
          
          if (silenceTimer) {
            clearTimeout(silenceTimer)
            silenceTimer = null
          }
          
          // Start services
          bootDeepgram()
          await sendGreeting()
          break
          
        case "media":
          if (data.payload && ids.streamId) {
            const audioBuffer = Buffer.from(data.payload, 'base64')
            
            if (deepgramWs && deepgramReady && deepgramWs.readyState === WebSocket.OPEN) {
              deepgramWs.send(audioBuffer)
            } else {
              dgQueue.push(audioBuffer)
            }
          }
          break
          
        case "stop":
          console.log(`[${ts()}] [STOP]`)
          
          stopAllTTS()
          if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
            deepgramWs.close()
          }
          if (silenceTimer) {
            clearTimeout(silenceTimer)
            silenceTimer = null
          }
          
          // Log final conversation
          const finalHistory = history.getHistory()
          console.log(`[${ts()}] [CONVERSATION-SUMMARY] entries=${finalHistory.length}`)
          finalHistory.forEach((entry, i) => {
            console.log(`[${ts()}] [CONV-${i + 1}] ${entry.role}: "${entry.content}"`)
          })
          break
      }
    } catch (e) {
      console.log(`[${ts()}] [WS-MSG-ERROR] ${e.message}`)
    }
  })

  ws.on("close", () => {
    console.log(`[${ts()}] [WS-CLOSED]`)
    
    stopAllTTS()
    if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
      deepgramWs.close()
    }
    if (silenceTimer) {
      clearTimeout(silenceTimer)
      silenceTimer = null
    }
  })

  ws.on("error", (e) => {
    console.log(`[${ts()}] [WS-ERROR] ${e.message}`)
  })
}

module.exports = { setupSanPbxWebSocketServer }