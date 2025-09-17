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

const streamPcmToSanPBX = async (ws, { streamId, callId, channelId }, pcmBase64) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  if (!streamId || !callId || !channelId) return
  const CHUNK_SIZE = 320
  const audioBuffer = Buffer.from(pcmBase64, 'base64')
  let position = 0
  while (position < audioBuffer.length && ws.readyState === WebSocket.OPEN) {
    const chunk = audioBuffer.slice(position, position + CHUNK_SIZE)
    const padded = chunk.length < CHUNK_SIZE ? Buffer.concat([chunk, Buffer.alloc(CHUNK_SIZE - chunk.length)]) : chunk
    const message = { event: "reverse-media", payload: padded.toString('base64'), streamId, channelId, callId }
    try { ws.send(JSON.stringify(message)) } catch (_) { break }
    position += CHUNK_SIZE
    if (position < audioBuffer.length) await new Promise(r => setTimeout(r, 20))
  }
  try {
    for (let i = 0; i < 3; i++) {
      const silence = Buffer.alloc(CHUNK_SIZE).toString('base64')
      ws.send(JSON.stringify({ event: "reverse-media", payload: silence, streamId, channelId, callId }))
      await new Promise(r => setTimeout(r, 20))
    }
  } catch (_) {}
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
      pace: 1.0,
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
    body: JSON.stringify({ model: "gpt-4o-mini", messages, max_tokens: 120, temperature: 0.3 }),
  })
  if (!res.ok) throw new Error(`OpenAI error: ${res.status}`)
  const data = await res.json()
  return (data.choices?.[0]?.message?.content || "").trim()
}

// OpenAI streaming with SSE; calls onPartial(accumulated, delta)
const respondWithOpenAIStream = async (userMessage, history = [], onPartial = null) => {
  const messages = [
    { role: "system", content: STATIC.systemPrompt },
    ...history.slice(-6),
    { role: "user", content: userMessage },
  ]
  console.log(`[${ts()}] [LLM-STREAM] start`)
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEYS.openai}` },
    body: JSON.stringify({ model: "gpt-4o-mini", messages, max_tokens: 120, temperature: 0.3, stream: true }),
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
        console.log(`[${ts()}] [LLM-STREAM] done_marker`)
        break
      }
      if (trimmed.startsWith("data:")) {
        try {
          const json = JSON.parse(trimmed.slice(5).trim())
          const delta = json.choices?.[0]?.delta?.content || ""
          if (delta) {
            if (!firstTokenLogged) { firstTokenLogged = true; console.log(`[${ts()}] [LLM-STREAM] first_token`) }
            accumulated += delta
            if (typeof onPartial === "function") {
              try { await onPartial(accumulated, delta) } catch (_) {}
            }
          }
        } catch (_) {}
      }
    }
  }
  console.log(`[${ts()}] [LLM-STREAM] completed chars=${accumulated.length}`)
  return accumulated || null
}

const connectDeepgram = (language = STATIC.deepgramLanguage) => {
  const url = new URL("wss://api.deepgram.com/v1/listen")
  url.searchParams.append("sample_rate", "44100")
  url.searchParams.append("channels", "1")
  url.searchParams.append("encoding", "linear16")
  url.searchParams.append("model", "nova-2")
  url.searchParams.append("language", language)
  const wsUrl = url.toString()
  console.log(`[${ts()}] [DEEPGRAM-CONNECT] ${wsUrl}`)
  return new WebSocket(wsUrl, { headers: { Authorization: `Token ${API_KEYS.deepgram}` } })
}

const setupSanPbxWebSocketServer = (ws) => {
  let ids = { streamId: null, callId: null, channelId: null }
  let deepgramWs = null
  let deepgramReady = false
  let dgQueue = []
  let history = []

  const sendGreeting = async () => {
    try {
      const pcm = await ttsWithSarvam(STATIC.firstMessage)
      await streamPcmToSanPBX(ws, ids, pcm)
      history.push({ role: "assistant", content: STATIC.firstMessage })
    } catch (_) {}
  }

  // Simple TTS queue to serialize playback for streaming partials
  let ttsQueue = []
  let ttsBusy = false
  const enqueueTTS = (text) => {
    if (!text || !text.trim()) return
    ttsQueue.push(text.trim())
    console.log(`[${ts()}] [TTS-QUEUE] enqueue len=${text.trim().length} queue=${ttsQueue.length}`)
    if (!ttsBusy) processTTSQueue().catch(() => {})
  }
  const processTTSQueue = async () => {
    if (ttsBusy) return
    ttsBusy = true
    try {
      while (ttsQueue.length > 0) {
        const item = ttsQueue.shift()
        console.log(`[${ts()}] [TTS-PLAY] start len=${item.length}`)
        const pcm = await ttsWithSarvam(item)
        await streamPcmToSanPBX(ws, ids, pcm)
        console.log(`[${ts()}] [TTS-PLAY] end len=${item.length}`)
        // brief gap to avoid boundary artifacts
        await new Promise(r => setTimeout(r, 50))
      }
    } catch (e) {
      console.log(`[${ts()}] [TTS-PLAY] error ${e.message}`)
    } finally {
      ttsBusy = false
    }
  }

  const handleTranscript = async (text) => {
    try {
      const clean = (text || "").trim()
      if (!clean) return
      console.log(`[${ts()}] [DEEPGRAM-FINAL] ${clean}`)
      history.push({ role: "user", content: clean })
      let lastLen = 0
      const shouldFlush = (prev, curr, delta) => {
        const diff = curr.slice(prev)
        if (diff.length >= 60) return true
        return /[.!?]\s?$/.test(curr) || /\n\s*$/.test(curr)
      }
      const finalText = await respondWithOpenAIStream(clean, history, async (accum, delta) => {
        if (!accum || accum.length <= lastLen) return
        if (!shouldFlush(lastLen, accum, delta)) return
        const chunk = accum.slice(lastLen).trim()
        lastLen = accum.length
        if (chunk) {
          console.log(`[${ts()}] [LLM-FLUSH] chunk_len=${chunk.length}`)
          enqueueTTS(chunk)
        }
      })
      if (finalText && finalText.length > lastLen) {
        const tail = finalText.slice(lastLen).trim()
        if (tail) {
          console.log(`[${ts()}] [LLM-FLUSH] tail_len=${tail.length}`)
          enqueueTTS(tail)
        }
      }
      if (finalText) history.push({ role: "assistant", content: finalText })
    } catch (_) {}
  }

  const bootDeepgram = () => {
    deepgramWs = connectDeepgram()
    deepgramWs.onopen = () => {
      deepgramReady = true
      console.log(`[${ts()}] 🎤 [DEEPGRAM] open; queued_packets=${dgQueue.length}`)
      if (dgQueue.length) { dgQueue.forEach((b) => deepgramWs.send(b)); dgQueue = [] }
    }
    deepgramWs.onmessage = async (evt) => {
      try {
        const msg = JSON.parse(evt.data)
        if (msg.type === "Results") {
          const transcript = msg.channel?.alternatives?.[0]?.transcript || ""
          if (transcript) {
            if (msg.is_final) await handleTranscript(transcript)
            else console.log(`[DEEPGRAM-INTERIM] ${transcript}`)
          }
        }
      } catch (_) {}
    }
    deepgramWs.onerror = (e) => { deepgramReady = false; console.log(`[${ts()}] ❌ [DEEPGRAM] error ${e?.message || ""}`) }
    deepgramWs.onclose = () => { deepgramReady = false; console.log(`[${ts()}] 🔌 [DEEPGRAM] closed`) }
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
          bootDeepgram()
          await sendGreeting()
          break
        case "media":
          if (data.payload) {
            const audioBuffer = Buffer.from(data.payload, 'base64')
            if (!ws.mediaPacketCount) ws.mediaPacketCount = 0
            ws.mediaPacketCount++
            if (ws.mediaPacketCount % 1000 === 0) console.log(`[${ts()}] 🎵 [SANPBX-MEDIA] packets=${ws.mediaPacketCount}`)
            if (deepgramWs && deepgramReady && deepgramWs.readyState === WebSocket.OPEN) deepgramWs.send(audioBuffer)
            else {
              dgQueue.push(audioBuffer)
              if (dgQueue.length % 100 === 0) console.log(`[${ts()}] ⏳ [DEEPGRAM-QUEUE] queued_packets=${dgQueue.length}`)
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
    } catch (_) {}
  })

  ws.on("close", () => {
    console.log(`[${ts()}] 🔌 [SANPBX] ws closed`)
    if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) deepgramWs.close()
  })

  ws.on("error", () => {})
}

module.exports = { setupSanPbxWebSocketServer }