const WebSocket = require("ws")
const EventEmitter = require("events")
const Agent = require("../models/Agent")
const CallLog = require("../models/CallLog")
require("dotenv").config()

const API_KEYS = {
  deepgram: process.env.DEEPGRAM_API_KEY,
  sarvam: process.env.SARVAM_API_KEY,
  openai: process.env.OPENAI_API_KEY,
}
console.log(API_KEYS)
// Validate API keys
if (!API_KEYS.deepgram || !API_KEYS.sarvam || !API_KEYS.openai) {
  console.error("❌ Missing required API keys in environment variables")
  process.exit(1)
}

const LANGUAGE_MAPPING = {
  hi: "hi-IN",
  en: "en-IN",
  bn: "bn-IN",
  te: "te-IN",
  ta: "ta-IN",
  mr: "mr-IN",
  gu: "gu-IN",
  kn: "kn-IN",
  ml: "ml-IN",
  pa: "pa-IN",
  or: "or-IN",
  as: "as-IN",
  ur: "ur-IN",
}

const getSarvamLanguage = (detectedLang, defaultLang = "hi") => {
  const lang = detectedLang?.toLowerCase() || defaultLang
  return LANGUAGE_MAPPING[lang] || "hi-IN"
}

const getDeepgramLanguage = (detectedLang, defaultLang = "hi") => {
  const lang = detectedLang?.toLowerCase() || defaultLang
  if (lang === "hi") return "hi"
  if (lang === "en") return "en-IN"
  if (lang === "mr") return "mr"
  return lang
}

const VALID_SARVAM_VOICES = new Set([
  "abhilash",
  "anushka",
  "meera",
  "pavithra",
  "maitreyi",
  "arvind",
  "amol",
  "amartya",
  "diya",
  "neel",
  "misha",
  "vian",
  "arjun",
  "maya",
  "manisha",
  "vidya",
  "arya",
  "karun",
  "hitesh",
])

const getValidSarvamVoice = (voiceSelection = "pavithra") => {
  const normalized = (voiceSelection || "").toString().trim().toLowerCase()
  if (VALID_SARVAM_VOICES.has(normalized)) {
    return normalized
  }
  // Map generic labels to closest Sarvam voices
  const voiceMapping = {
    "male-professional": "arvind",
    "female-professional": "pavithra",
    "male-friendly": "amol",
    "female-friendly": "maya",
    neutral: "pavithra",
    default: "pavithra",
    male: "arvind",
    female: "pavithra",
  }
  return voiceMapping[normalized] || "pavithra"
}

// -------- Phone utils --------
function extractDigits(value) {
  if (!value) return ""
  return String(value).replace(/\D+/g, "")
}

function last10Digits(value) {
  const digits = extractDigits(value)
  return digits.slice(-10)
}

async function findActiveAgentByNumber(dialedNumberA, dialedNumberB) {
  // Fallback-friendly in-memory match by last 10 digits
  const candidates = await Agent.find({ isActive: true, callingNumber: { $exists: true } })
    .select("_id clientId callingNumber sttSelection ttsSelection llmSelection")
    .lean()
  const aLast = last10Digits(dialedNumberA)
  const bLast = last10Digits(dialedNumberB)
  let best = null
  for (const ag of candidates) {
    const agLast = last10Digits(ag.callingNumber)
    if (agLast && (agLast === aLast || agLast === bLast)) {
      best = ag
      break
    }
  }
  return best
}

// -------- Debug decode helpers --------
function isPrintableAscii(text) {
  if (typeof text !== "string") return false
  // Allow common whitespace; disallow control chars
  return /^[\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]*$/.test(text)
}

function isProbablyBase64(str) {
  if (typeof str !== "string") return false
  if (str.length < 8) return false
  if (str.length % 4 !== 0) return false
  // Common base64 chars only
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(str)) return false
  return true
}

function tryDecodeBase64ToUtf8(str) {
  try {
    const buf = Buffer.from(str, "base64")
    if (buf.length === 0) return null
    const asUtf8 = buf.toString("utf8")
    if (isPrintableAscii(asUtf8)) return asUtf8
    return null
  } catch (_) {
    return null
  }
}

function summarizeBase64Binary(str, maxPreviewBytes = 16) {
  try {
    const buf = Buffer.from(str, "base64")
    const preview = buf.slice(0, maxPreviewBytes)
    const hexPreview = Array.from(preview)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ")
    return {
      _encoding: "base64",
      _summary: `binary ${buf.length} bytes`,
      _preview_hex: hexPreview,
    }
  } catch (_) {
    return { _encoding: "base64", _summary: "invalid base64" }
  }
}

function isProbablyUrlEncoded(str) {
  if (typeof str !== "string") return false
  // Heuristic: presence of %XX or + as space and typical separators
  return /%[0-9A-Fa-f]{2}/.test(str) || (str.includes("+") && /%|=|&/.test(str))
}

function tryDecodeUrl(str) {
  try {
    // Replace + with space as in application/x-www-form-urlencoded
    const replaced = str.replace(/\+/g, " ")
    const decoded = decodeURIComponent(replaced)
    if (decoded !== str) return decoded
    return null
  } catch (_) {
    return null
  }
}

function decodeStringFieldByHeuristics(key, value) {
  if (typeof value !== "string") return value

  // Large payload keys: summarize instead of full dump
  const lowerKey = (key || "").toString().toLowerCase()
  const isLikelyPayload = lowerKey.includes("payload") || lowerKey.includes("audio")

  if (isProbablyBase64(value)) {
    if (isLikelyPayload) {
      return summarizeBase64Binary(value)
    }
    const asUtf8 = tryDecodeBase64ToUtf8(value)
    if (asUtf8 !== null) return asUtf8
    return summarizeBase64Binary(value)
  }

  const urlDecoded = tryDecodeUrl(value)
  if (urlDecoded !== null) return urlDecoded

  return value
}

function deepDecodeObject(input, currentKey = "") {
  if (Array.isArray(input)) {
    return input.map((v) => deepDecodeObject(v, currentKey))
  }
  if (input && typeof input === "object") {
    const out = {}
    for (const [k, v] of Object.entries(input)) {
      out[k] = deepDecodeObject(v, k)
    }
    return out
  }
  if (typeof input === "string") {
    return decodeStringFieldByHeuristics(currentKey, input)
  }
  return input
}

// -------- Audio utils: WAV PCM16 -> µ-law (8kHz mono) --------
function linearPcmSampleToMuLaw(sample) {
  // Clamp to 16-bit signed range
  if (sample > 32767) sample = 32767
  if (sample < -32768) sample = -32768

  const MU = 255

  let sign = 0
  if (sample < 0) {
    sign = 0x80
    sample = -sample
  }

  // Bias for μ-law
  sample = sample + 132
  if (sample > 32635) sample = 32635

  // Determine exponent
  let exponent = 7
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0f
  const muLawByte = ~(sign | (exponent << 4) | mantissa) & 0xff
  return muLawByte
}

function wavPcm16ToMuLawBase64(wavBase64) {
  try {
    const buffer = Buffer.from(wavBase64, "base64")
    if (buffer.length < 44) return null
    // Basic WAV header checks
    if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
      return null
    }

    // Parse fmt chunk
    let offset = 12
    let fmtChunkFound = false
    let audioFormat = 1
    let numChannels = 1
    let sampleRate = 8000
    let bitsPerSample = 16
    let dataOffset = -1
    let dataSize = 0

    while (offset + 8 <= buffer.length) {
      const chunkId = buffer.toString("ascii", offset, offset + 4)
      const chunkSize = buffer.readUInt32LE(offset + 4)
      const next = offset + 8 + chunkSize
      if (chunkId === "fmt ") {
        fmtChunkFound = true
        audioFormat = buffer.readUInt16LE(offset + 8)
        numChannels = buffer.readUInt16LE(offset + 10)
        sampleRate = buffer.readUInt32LE(offset + 12)
        bitsPerSample = buffer.readUInt16LE(offset + 22)
      } else if (chunkId === "data") {
        dataOffset = offset + 8
        dataSize = chunkSize
      }
      offset = next
    }

    if (!fmtChunkFound || dataOffset < 0 || dataSize <= 0) return null
    if (audioFormat !== 1 || numChannels !== 1 || bitsPerSample !== 16) return null
    if (sampleRate !== 8000) return null

    const pcmData = buffer.slice(dataOffset, dataOffset + dataSize)
    const sampleCount = pcmData.length / 2
    const muLawBuffer = Buffer.alloc(sampleCount)
    for (let i = 0; i < sampleCount; i++) {
      const sample = pcmData.readInt16LE(i * 2)
      muLawBuffer[i] = linearPcmSampleToMuLaw(sample)
    }
    return muLawBuffer.toString("base64")
  } catch (err) {
    return null
  }
}

class SipCallSession extends EventEmitter {
  constructor(ws, callSid) {
    super()
    this.ws = ws
    this.callSid = callSid
    this.streamSid = null
    this.isActive = false
    this.audioBuffer = []
    this.conversationHistory = []
    this.detectedLanguage = "en"
    this.createdAt = new Date()
    this.callLogId = null
    this.agent = null
    this.systemPromptOverride = null
    this.voiceOverride = null
    this.firstMessageText = null

    this.deepgramWs = null
    this.deepgramReady = false
    this.deepgramAudioQueue = []

    console.log(`📞 [SIP-SESSION] New session created: ${this.callSid}`)

    this.connectToDeepgram()
  }

  async connectToDeepgram() {
    try {
      const deepgramLanguage = getDeepgramLanguage(this.detectedLanguage)

      const deepgramUrl = new URL("wss://api.deepgram.com/v1/listen")
      deepgramUrl.searchParams.append("sample_rate", "8000")
      deepgramUrl.searchParams.append("channels", "1")
      // Incoming SIP audio is µ-law 8k; match Deepgram input encoding
      deepgramUrl.searchParams.append("encoding", "mulaw")
      deepgramUrl.searchParams.append("model", "nova-2")
      deepgramUrl.searchParams.append("language", deepgramLanguage)
      deepgramUrl.searchParams.append("interim_results", "true")
      deepgramUrl.searchParams.append("smart_format", "true")
      deepgramUrl.searchParams.append("endpointing", "300")

      this.deepgramWs = new WebSocket(deepgramUrl.toString(), {
        headers: { Authorization: `Token ${API_KEYS.deepgram}` },
      })

      this.deepgramWs.onopen = () => {
        console.log("🎤 [DEEPGRAM] Connection established")
        this.deepgramReady = true
        console.log("🎤 [DEEPGRAM] Processing queued audio packets:", this.deepgramAudioQueue.length)
        this.deepgramAudioQueue.forEach((buffer) => this.deepgramWs.send(buffer))
        this.deepgramAudioQueue = []
      }

      this.deepgramWs.onmessage = async (event) => {
        const data = JSON.parse(event.data)
        await this.handleDeepgramResponse(data)
      }

      this.deepgramWs.onerror = (error) => {
        console.log("❌ [DEEPGRAM] Connection error:", error.message)
        this.deepgramReady = false
      }

      this.deepgramWs.onclose = () => {
        console.log("🔌 [DEEPGRAM] Connection closed")
        this.deepgramReady = false
      }
    } catch (error) {
      console.error("❌ [DEEPGRAM] Connection setup error:", error.message)
    }
  }

  async handleDeepgramResponse(data) {
    try {
      if (data.channel?.alternatives?.[0]?.transcript) {
        const transcript = data.channel.alternatives[0].transcript
        const confidence = data.channel.alternatives[0].confidence
        const isFinal = data.is_final

        if (isFinal && transcript.trim() && confidence > 0.5) {
          console.log(`🎤 [SIP-STT] Final transcript: ${transcript}`)

          // Detect language if available
          if (data.channel.detected_language) {
            this.detectedLanguage = data.channel.detected_language
          }

          // Persist user transcript line
          try {
            let callLog = null
            if (this.callLogId) {
              callLog = await CallLog.findById(this.callLogId)
            } else if (this.streamSid) {
              callLog = await CallLog.findActiveCallByStreamSid(this.streamSid)
            }
            if (callLog) {
              callLog.addLiveTranscriptEntry({
                type: "user",
                language: this.detectedLanguage || "en",
                text: transcript,
                timestamp: new Date(),
              })
              await callLog.save()
            }
          } catch (err) {
            console.error("❌ [CALLLOG] Failed to persist user transcript:", err.message)
          }

          // Process with OpenAI
          await this.processWithOpenAI(transcript)
        }
      }
    } catch (error) {
      console.error("❌ [DEEPGRAM] Response handling error:", error.message)
    }
  }

  async processAudioChunk(audioData) {
    try {
      // Convert base64 µ-law to linear16 for Deepgram
      const audioBuffer = Buffer.from(audioData, "base64")

      if (this.deepgramReady && this.deepgramWs) {
        this.deepgramWs.send(audioBuffer)
      } else {
        // Queue audio if Deepgram not ready
        this.deepgramAudioQueue.push(audioBuffer)
      }
    } catch (error) {
      console.error(`❌ [SIP-STT] Error processing audio:`, error.message)
    }
  }

  async processWithOpenAI(userMessage) {
    try {
      // Add user message to conversation history
      this.conversationHistory.push({
        role: "user",
        content: userMessage,
        timestamp: new Date(),
        language: this.detectedLanguage,
      })

      // Create system prompt with token limit instruction (prefer agent-provided)
      const baseSystem = this.systemPromptOverride || this.getSystemPrompt(this.detectedLanguage)
      const systemPrompt = `${baseSystem}\n\nIMPORTANT: Keep your responses concise and under 100 tokens. Be brief but helpful.`

      // Prepare messages for OpenAI
      const messages = [
        { role: "system", content: systemPrompt },
        ...this.conversationHistory.slice(-6).map((msg) => ({
          role: msg.role,
          content: msg.content,
        })),
      ]

      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEYS.openai}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages,
          max_tokens: 100,
          temperature: 0.7,
        }),
      })

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status}`)
      }

      const completion = await response.json()
      const aiResponse = completion.choices[0]?.message?.content

      if (aiResponse) {
        console.log(`🤖 [SIP-AI] Response (${this.detectedLanguage}): ${aiResponse}`)

        // Add AI response to conversation history
        this.conversationHistory.push({
          role: "assistant",
          content: aiResponse,
          timestamp: new Date(),
          language: this.detectedLanguage,
        })

        // Persist AI response line
        try {
          let callLog = null
          if (this.callLogId) {
            callLog = await CallLog.findById(this.callLogId)
          } else if (this.streamSid) {
            callLog = await CallLog.findActiveCallByStreamSid(this.streamSid)
          }
          if (callLog) {
            callLog.addLiveTranscriptEntry({
              type: "ai",
              language: this.detectedLanguage || "en",
              text: aiResponse,
              timestamp: new Date(),
            })
            await callLog.save()
          }
        } catch (err) {
          console.error("❌ [CALLLOG] Failed to persist AI response:", err.message)
        }

        // Convert to speech using Sarvam AI
        await this.convertToSpeech(aiResponse)
      }
    } catch (error) {
      console.error(`❌ [SIP-AI] Error processing with OpenAI:`, error.message)
    }
  }

  async convertToSpeech(text) {
    try {
      const sarvamLanguage = getSarvamLanguage(this.detectedLanguage)
      const voice = getValidSarvamVoice(this.voiceOverride || "pavithra")

      const response = await fetch("https://api.sarvam.ai/text-to-speech", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "API-Subscription-Key": API_KEYS.sarvam,
        },
        body: JSON.stringify({
          inputs: [text],
          target_language_code: sarvamLanguage,
          speaker: voice,
          pitch: 0,
          pace: 1.0,
          loudness: 1.0,
          speech_sample_rate: 8000,
          enable_preprocessing: true,
          model: "bulbul:v1",
        }),
      })

      if (!response.ok) {
        throw new Error(`Sarvam API error: ${response.status}`)
      }

      const responseData = await response.json()
      const audioBase64 = responseData.audios?.[0]

      if (audioBase64) {
        // Sarvam typically returns WAV PCM. Convert to µ-law/8000 base64 for SIP client.
        const muLawBase64 = wavPcm16ToMuLawBase64(audioBase64) || audioBase64
        this.sendAudioToClient(muLawBase64)
      } else {
        throw new Error("No audio data received from Sarvam API")
      }
    } catch (error) {
      console.error(`❌ [SIP-TTS] Error converting to speech:`, error.message)
      // Fallback: send a simple text response
      this.sendTextToClient("I'm sorry, I'm having trouble with audio processing right now.")
    }
  }

  sendAudioToClient(base64Audio) {
    if (this.ws.readyState === WebSocket.OPEN && this.streamSid) {
      const audioMessage = {
        event: "media",
        streamSid: this.streamSid,
        media: {
          payload: base64Audio,
        },
      }

      this.ws.send(JSON.stringify(audioMessage))
      console.log(`🔊 [SIP-AUDIO] Sent audio response to client`)
    }
  }

  sendTextToClient(text) {
    if (this.ws.readyState === WebSocket.OPEN) {
      const textMessage = {
        event: "text",
        text: text,
        timestamp: new Date().toISOString(),
      }

      this.ws.send(JSON.stringify(textMessage))
      console.log(`📝 [SIP-TEXT] Sent text response: ${text}`)
    }
  }

  getSystemPrompt(language) {
    const prompts = {
      en: "You are a helpful AI assistant for voice calls. Provide concise, natural responses suitable for phone conversations. Keep responses under 50 words.",
      hi: "आप एक सहायक AI असिस्टेंट हैं। संक्षिप्त और प्राकृतिक उत्तर दें जो फोन कॉल के लिए उपयुक्त हों।",
      es: "Eres un asistente de IA útil para llamadas de voz. Proporciona respuestas concisas y naturales adecuadas para conversaciones telefónicas.",
      fr: "Vous êtes un assistant IA utile pour les appels vocaux. Fournissez des réponses concises et naturelles adaptées aux conversations téléphoniques.",
      de: "Sie sind ein hilfreicher KI-Assistent für Sprachanrufe. Geben Sie prägnante, natürliche Antworten, die für Telefongespräche geeignet sind.",
    }

    return prompts[language] || prompts["en"]
  }

  terminate(reason = "normal_termination") {
    console.log(`🛑 [SIP-SESSION] Terminating session ${this.callSid}: ${reason}`)
    this.isActive = false

    if (this.deepgramWs) {
      this.deepgramWs.close()
      this.deepgramWs = null
    }

    this.emit("terminated", { callSid: this.callSid, reason })
  }
}

// Active sessions storage
const activeSessions = new Map()

function setupSipWebSocketServer(wss) {
  console.log("🔧 [SIP-WS] Setting up SIP WebSocket server...")

  wss.on("connection", (ws, req) => {
    console.log("🔗 [SIP-WS] New SIP WebSocket connection established")

    // Send immediate connection acknowledgment
    ws.send(
      JSON.stringify({
        event: "connected",
        protocol: "SIP-WebSocket-v1.0",
        timestamp: new Date().toISOString(),
      }),
    )

    ws.on("message", async (message) => {
      try {
        const data = JSON.parse(message.toString())
        console.log(`📨 [SIP-WS] Received event: ${data.event}`)

        // Emit decoded debug snapshot for visibility
        try {
          const decodedSnapshot = deepDecodeObject(data)
          const debugPayload = {
            event: "sip_debug",
            original_event: data.event || "unknown",
            decoded: decodedSnapshot,
            timestamp: new Date().toISOString(),
          }
          // Log compactly to avoid flooding
          console.log("🔍 [SIP-DEBUG]", JSON.stringify(debugPayload).slice(0, 2000))
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(debugPayload))
          }
        } catch (_) {}

        switch (data.event) {
          case "connected":
            // Some vendors send an initial connected event; acknowledge by ignoring
            break
          case "start":
            await handleStart(ws, data)
            break

          case "media":
            await handleMedia(ws, data)
            break

          case "stop":
            await handleStop(ws, data)
            break

          case "dtmf":
            await handleDtmf(ws, data)
            break

          case "mark":
            await handleMark(ws, data)
            break

          case "clear":
            await handleClear(ws, data)
            break

          default:
            console.log(`⚠️ [SIP-WS] Unknown event type: ${data.event}`)
        }
      } catch (error) {
        console.error("❌ [SIP-WS] Error processing message:", error.message)
        ws.send(
          JSON.stringify({
            event: "error",
            message: "Invalid message format",
            timestamp: new Date().toISOString(),
          }),
        )
      }
    })

    ws.on("close", (code, reason) => {
      console.log(`🔗 [SIP-WS] Connection closed: ${code} - ${reason}`)

      // Clean up any active sessions for this connection
      for (const [callSid, session] of activeSessions.entries()) {
        if (session.ws === ws) {
          session.terminate("connection_closed")
          activeSessions.delete(callSid)
        }
      }
    })

    ws.on("error", (error) => {
      console.error("❌ [SIP-WS] WebSocket error:", error.message)
    })
  })

  console.log("✅ [SIP-WS] SIP WebSocket server setup complete")
}

async function handleStart(ws, data) {
  const startInfo = data.start || {}
  const callSid = data.callSid || startInfo.callSid || startInfo.call_sid || startInfo.callsid
  const streamSid = data.streamSid || startInfo.streamSid || startInfo.stream_sid || data.streamsid

  console.log(`🚀 [SIP-START] Starting call session: ${callSid || "(unknown)"} | streamSid: ${streamSid || "(missing)"}`)

  // Create new session (no database validation - accept all)
  const sessionKey = callSid || streamSid
  const session = new SipCallSession(ws, sessionKey)
  session.streamSid = streamSid
  session.isActive = true

  // Store session using whichever identifier is available
  activeSessions.set(sessionKey, session)

  // Match agent by 'to' number (preferred) and persist CallLog
  try {
    const fromNumber = startInfo.from || data.from
    const toNumber = startInfo.to || data.to
    const toLast = last10Digits(toNumber)
    let agent = null
    try {
      const candidates = await Agent.find({ isActive: true, callingNumber: { $exists: true } })
        .select("_id clientId agentName callingNumber sttSelection ttsSelection llmSelection systemPrompt firstMessage voiceSelection language")
        .lean()
      agent = candidates.find((a) => last10Digits(a.callingNumber) === toLast) || null
    } catch (_) {}
    if (!agent) {
      agent = await findActiveAgentByNumber(fromNumber, toNumber)
    }
    session.agent = agent || null

    // Apply agent configuration overrides if available
    if (agent) {
      if (agent.systemPrompt && typeof agent.systemPrompt === "string") {
        session.systemPromptOverride = agent.systemPrompt
      }
      if (agent.voiceSelection) {
        session.voiceOverride = agent.voiceSelection
      }
      if (agent.firstMessage && typeof agent.firstMessage === "string") {
        session.firstMessageText = agent.firstMessage
      }
      if (agent.language && typeof agent.language === "string") {
        session.detectedLanguage = agent.language
      }
    }

    const agentCalling = agent?.callingNumber
    const agentLast = agentCalling ? last10Digits(agentCalling) : null
    const fromLast = last10Digits(fromNumber)

    let callDirection = "inbound"
    if (agentLast) {
      if (agentLast === fromLast) callDirection = "outbound"
      else if (agentLast === toLast) callDirection = "inbound"
    } else if (typeof startInfo.direction === "string" && isPrintableAscii(startInfo.direction)) {
      callDirection = startInfo.direction.trim().toLowerCase()
    }

    // Mobile is the counterparty
    const mobile = callDirection === "outbound" ? toLast : fromLast

    const meta = {
      userTranscriptCount: 0,
      aiResponseCount: 0,
      languages: session.detectedLanguage ? [session.detectedLanguage] : [],
      callEndTime: undefined,
      callDirection,
      isActive: true,
      lastUpdated: new Date(),
      customParams: (startInfo.customParameters && typeof startInfo.customParameters === "object") ? startInfo.customParameters : {},
      callerId: fromLast,
      totalUpdates: 0,
      sttProvider: (agent && agent.sttSelection) || "deepgram",
      ttsProvider: (agent && agent.ttsSelection) || "sarvam",
      llmProvider: (agent && agent.llmSelection) || "openai",
      serviceProvider: "tata",
    }

    // Client ID from Agent when available; fallback to accountSid or "unknown"
    const clientId = (agent && agent.clientId) ? agent.clientId : (startInfo.accountSid || "unknown")

    const callLog = await CallLog.create({
      clientId: clientId,
      agentId: agent ? agent._id : undefined,
      mobile: mobile,
      time: new Date(),
      transcript: "",
      duration: 0,
      leadStatus: "maybe",
      streamSid: streamSid,
      callSid: callSid,
      metadata: meta,
    })

    session.callLogId = callLog._id
  } catch (err) {
    console.error("❌ [CALLLOG] Failed to create CallLog:", err.message)
  }

  // Send acknowledgment
  ws.send(
    JSON.stringify({
      event: "start_ack",
      callSid: callSid || null,
      streamSid: streamSid || null,
      status: "accepted",
      message: "Call session started successfully",
      agent: session.agent ? { id: session.agent._id, clientId: session.agent.clientId, callingNumber: session.agent.callingNumber } : null,
      timestamp: new Date().toISOString(),
    }),
  )

  console.log(`✅ [SIP-START] Session started. Key: ${sessionKey}`)

  // Optionally send an initial greeting to test audio path
  try {
    const greeting = session.firstMessageText && typeof session.firstMessageText === "string"
      ? session.firstMessageText
      : "Hello, you are now connected. How can I help you?"
    await session.convertToSpeech(greeting)
  } catch (_) {}
}

async function handleMedia(ws, data) {
  const { streamSid, media } = data

  // Find session by streamSid
  const session = Array.from(activeSessions.values()).find((s) => s.streamSid === streamSid)

  if (!session) {
    console.log(`⚠️ [SIP-MEDIA] No active session found for streamSid: ${streamSid}`)
    return
  }

  if (media && media.payload) {
    // Process audio chunk
    await session.processAudioChunk(media.payload)
  }
}

async function handleStop(ws, data) {
  const callSid = data.callSid
  const streamSid = data.streamSid

  console.log(`🛑 [SIP-STOP] Stopping call session. callSid: ${callSid || "(missing)"}, streamSid: ${streamSid || "(missing)"}`)

  let sessionKey = callSid
  let session = sessionKey ? activeSessions.get(sessionKey) : undefined
  if (!session && streamSid) {
    session = Array.from(activeSessions.values()).find((s) => s.streamSid === streamSid)
    sessionKey = session ? session.callSid || session.streamSid : undefined
  }

  if (session && sessionKey) {
    session.terminate("call_ended")
    activeSessions.delete(sessionKey)

    // Update CallLog with end info
    try {
      let callLog = null
      if (session.callLogId) {
        callLog = await CallLog.findById(session.callLogId)
      } else if (streamSid) {
        callLog = await CallLog.findActiveCallByStreamSid(streamSid)
      }
      if (callLog) {
        const startTime = callLog.time ? new Date(callLog.time).getTime() : Date.now()
        const endTime = Date.now()
        const durationSec = Math.max(0, Math.round((endTime - startTime) / 1000))
        callLog.duration = durationSec
        callLog.metadata.isActive = false
        callLog.metadata.callEndTime = new Date(endTime)
        callLog.metadata.lastUpdated = new Date(endTime)
        await callLog.save()
      }
    } catch (err) {
      console.error("❌ [CALLLOG] Failed to finalize CallLog:", err.message)
    }

    // Send acknowledgment
    ws.send(
      JSON.stringify({
        event: "stop_ack",
        callSid: callSid || null,
        streamSid: streamSid || null,
        status: "terminated",
        timestamp: new Date().toISOString(),
      }),
    )

    console.log(`✅ [SIP-STOP] Session terminated. Key: ${sessionKey}`)
  }
}

async function handleDtmf(ws, data) {
  const { callSid, dtmf, streamSid } = data

  console.log(`📞 [SIP-DTMF] DTMF received. callSid: ${callSid || "(missing)"}, streamSid: ${streamSid || "(missing)"}, digit: ${dtmf?.digit}`)

  let session = (callSid && activeSessions.get(callSid)) || null
  if (!session && streamSid) {
    session = Array.from(activeSessions.values()).find((s) => s.streamSid === streamSid) || null
  }
  if (session) {
    // Handle DTMF input (could be used for menu navigation, etc.)
    session.sendTextToClient(`DTMF digit received: ${dtmf?.digit}`)
  }
}

async function handleMark(ws, data) {
  const { callSid, mark } = data

  console.log(`🏷️ [SIP-MARK] Mark received for call ${callSid}: ${mark.name}`)

  // Send acknowledgment
  ws.send(
    JSON.stringify({
      event: "mark_ack",
      callSid: callSid,
      mark: mark,
      timestamp: new Date().toISOString(),
    }),
  )
}

async function handleClear(ws, data) {
  const { callSid, streamSid } = data

  console.log(`🧹 [SIP-CLEAR] Clear received. callSid: ${callSid || "(missing)"}, streamSid: ${streamSid || "(missing)"}`)

  let session = (callSid && activeSessions.get(callSid)) || null
  if (!session && streamSid) {
    session = Array.from(activeSessions.values()).find((s) => s.streamSid === streamSid) || null
  }
  if (session) {
    // Clear any queued audio or reset session state
    session.audioBuffer = []

    ws.send(
      JSON.stringify({
        event: "clear_ack",
        callSid: callSid || null,
        streamSid: streamSid || null,
        status: "cleared",
        timestamp: new Date().toISOString(),
      }),
    )
  }
}

// Export the setup function and session management
module.exports = {
  setupSipWebSocketServer,
  activeSessions,
  SipCallSession,
}
