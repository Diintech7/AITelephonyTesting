const WebSocket = require("ws")
require("dotenv").config()

const fetch = globalThis.fetch || require("node-fetch")

const API_KEYS = {
  deepgram: process.env.DEEPGRAM_API_KEY,
  sarvam: process.env.SARVAM_API_KEY,
  openai: process.env.OPENAI_API_KEY,
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

// Latency optimization constants
const LATENCY_CONFIG = {
  INTERIM_MIN_WORDS: 2,           // Minimum words to trigger interim processing
  INTERIM_DEBOUNCE_MS: 150,       // Reduced from 450ms
  CONFIDENCE_THRESHOLD: 0.7,       // Minimum confidence for interim processing
  WORD_ACCUMULATION_MS: 200,      // Time to accumulate words before sending to LLM
  TTS_MIN_CHARS: 8,              // Reduced from 10
  TTS_DEBOUNCE_MS: 120,          // Reduced from 180ms
  SILENCE_DETECTION_MS: 300,      // Stop TTS if user starts speaking
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

const streamPcmToSanPBX = async (ws, { streamId, callId, channelId }, pcmBase64, sessionId) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  if (!streamId || !callId || !channelId) return false
  
  const CHUNK_SIZE = 320
  const audioBuffer = Buffer.from(pcmBase64, 'base64')
  let position = 0
  
  while (position < audioBuffer.length && ws.readyState === WebSocket.OPEN) {
    // Check if this TTS session is still valid (not cancelled by new user input)
    if (sessionId && ws.currentTTSSession !== sessionId) {
      console.log(`[${ts()}] [TTS-CANCEL] session=${sessionId} cancelled`)
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
  }
  
  // Send silence frames only if session is still valid
  if (!sessionId || ws.currentTTSSession === sessionId) {
    try {
      for (let i = 0; i < 2; i++) { // Reduced from 3
        const silence = Buffer.alloc(CHUNK_SIZE).toString('base64')
        ws.send(JSON.stringify({ event: "reverse-media", payload: silence, streamId, channelId, callId }))
        await new Promise(r => setTimeout(r, 20))
      }
    } catch (_) {}
  }
  
  return true
}

const ttsWithSarvam = async (text) => {
  const res = await fetch("https://api.sarvam.ai/text-to-speech", {
    method: "POST",
    headers: { "Content-Type": "application/json", "API-Subscription-Key": API_KEYS.sarvam },
    body: JSON.stringify({
      inputs: [text],
      target_language_code: STATIC.sarvamLanguage,
      speaker: STATIC.sarvamVoice,
      pitch: 0,
      pace: 0.8, // Slightly faster pace
      loudness: 1.0,
      speech_sample_rate: 8000,
      enable_preprocessing: true,
      model: "bulbul:v1",
    }),
  })
  if (!res.ok) throw new Error(`Sarvam TTS failed: ${res.status}`)
  const data = await res.json()
  const audioBase64 = data.audios && data.audios[0]
  if (!audioBase64) throw new Error("Sarvam TTS: empty audio")
  return extractPcmLinear16Mono8kBase64(audioBase64)
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

// Optimized OpenAI streaming with faster response triggers
const respondWithOpenAIStream = async (userMessage, history = [], onPartial = null, sessionId = null) => {
  const messages = [
    { role: "system", content: STATIC.systemPrompt },
    ...history.slice(-6),
    { role: "user", content: userMessage },
  ]
  
  console.log(`[${ts()}] [LLM-STREAM] start session=${sessionId || 'none'}`)
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEYS.openai}` },
    body: JSON.stringify({ 
      model: "gpt-4o-mini", 
      messages, 
      max_tokens: 100, 
      temperature: 0.2,
      stream: true 
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
        console.log(`[${ts()}] [LLM-STREAM] done_marker session=${sessionId || 'none'}`)
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
  
  console.log(`[${ts()}] [LLM-STREAM] completed chars=${accumulated.length} session=${sessionId || 'none'}`)
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
    
    if (chunk.length < LATENCY_CONFIG.TTS_MIN_CHARS && reason !== "punct" && reason !== "force") {
      speakBuffer = chunk
      return
    }
    
    ttsQueue.push(chunk)
    console.log(`[${ts()}] [TTS-QUEUE] flush(${reason}) len=${chunk.length} queue=${ttsQueue.length}`)
    if (!ttsBusy) processTTSQueue().catch(() => {})
  }
  
  const queueSpeech = (text, force = false) => {
    if (!text || !text.trim()) return
    
    // Cancel if user is speaking
    if (userSpeechDetected && Date.now() - lastUserInputTime < LATENCY_CONFIG.SILENCE_DETECTION_MS) {
      console.log(`[${ts()}] [TTS-SKIP] user_speaking`)
      return
    }
    
    const incoming = text
    speakBuffer += (speakBuffer ? " " : "") + incoming
    const bufLen = speakBuffer.length
    const wordCount = speakBuffer.trim().split(/\s+/).length
    const punctNow = PUNCTUATION_FLUSH.test(speakBuffer)
    const shouldImmediate = force || punctNow || bufLen >= 60 || wordCount >= 8 // Reduced thresholds
    
    if (shouldImmediate) {
      if (speakDebounceTimer) { clearTimeout(speakDebounceTimer); speakDebounceTimer = null }
      flushSpeakBuffer(punctNow ? "punct" : (force ? "force" : "threshold"))
      return
    }
    
    if (speakDebounceTimer) clearTimeout(speakDebounceTimer)
    speakDebounceTimer = setTimeout(() => flushSpeakBuffer("debounce"), LATENCY_CONFIG.TTS_DEBOUNCE_MS)
  }
  
  const processTTSQueue = async () => {
    if (ttsBusy) return
    ttsBusy = true
    try {
      while (ttsQueue.length > 0) {
        const item = ttsQueue.shift()
        const sessionId = ++currentTTSSession
        ws.currentTTSSession = sessionId
        
        console.log(`[${ts()}] [TTS-PLAY] start len=${item.length} session=${sessionId}`)
        const pcm = await ttsWithSarvam(item)
        const success = await streamPcmToSanPBX(ws, ids, pcm, sessionId)
        
        if (success) {
          console.log(`[${ts()}] [TTS-PLAY] end len=${item.length} session=${sessionId}`)
        } else {
          console.log(`[${ts()}] [TTS-PLAY] cancelled len=${item.length} session=${sessionId}`)
          break // Stop processing queue if cancelled
        }
      }
    } catch (e) {
      console.log(`[${ts()}] [TTS-PLAY] error ${e.message}`)
    } finally {
      ttsBusy = false
    }
  }

  // Enhanced transcript handling with incremental processing
  const handleIncrementalTranscript = async (text, isFinal = false, confidence = 1.0) => {
    try {
      const clean = (text || "").trim()
      if (!clean) return
      
      const wordCount = clean.split(/\s+/).filter(Boolean).length
      
      // Cancel any ongoing TTS when user speaks
      if (!isFinal) {
        userSpeechDetected = true
        lastUserInputTime = Date.now()
        // Cancel current TTS session
        currentTTSSession++
        ws.currentTTSSession = currentTTSSession
        console.log(`[${ts()}] [USER-SPEECH] detected, cancelling TTS session=${currentTTSSession}`)
      }
      
      console.log(`[${ts()}] [TRANSCRIPT-${isFinal ? 'FINAL' : 'INTERIM'}] words=${wordCount} conf=${confidence.toFixed(2)} text="${clean}"`)
      
      // Process if final OR if interim meets criteria
      const shouldProcess = isFinal || 
                           (wordCount >= LATENCY_CONFIG.INTERIM_MIN_WORDS && 
                            confidence >= LATENCY_CONFIG.CONFIDENCE_THRESHOLD)
      
      if (!shouldProcess) return
      
      // Update history only for final transcripts
      if (isFinal) {
        history.push({ role: "user", content: clean })
        userSpeechDetected = false // Reset after final transcript
      }
      
      const sessionId = ++currentLLMSession
      let lastLen = 0
      
      const shouldFlush = (prev, curr, delta) => {
        const diff = curr.slice(prev)
        const words = diff.trim().split(/\s+/).filter(Boolean).length
        // More aggressive flushing for lower latency
        if ((delta && delta.length >= 20) || words >= 2) return true
        return /[.!?]\s?$/.test(curr) || /\n\s*$/.test(curr)
      }
      
      const finalText = await respondWithOpenAIStream(clean, history, async (accum, delta, llmSessionId) => {
        // Skip if this session is outdated
        if (llmSessionId !== sessionId) return
        
        if (!accum || accum.length <= lastLen) return
        if (!shouldFlush(lastLen, accum, delta)) return
        
        const chunk = accum.slice(lastLen).trim()
        lastLen = accum.length
        
        if (chunk) {
          console.log(`[${ts()}] [LLM-FLUSH] session=${sessionId} chunk_len=${chunk.length}`)
          queueSpeech(chunk, false)
        }
      }, sessionId)
      
      // Handle final chunk
      if (finalText && finalText.length > lastLen) {
        const tail = finalText.slice(lastLen).trim()
        if (tail) {
          console.log(`[${ts()}] [LLM-FLUSH] session=${sessionId} tail_len=${tail.length}`)
          queueSpeech(tail, true)
        }
      }
      
      // Update history only for final transcripts and successful LLM responses
      if (isFinal && finalText && sessionId === currentLLMSession) {
        history.push({ role: "assistant", content: finalText })
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