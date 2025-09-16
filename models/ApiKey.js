const mongoose = require("mongoose")
const crypto = require("crypto")

const apiKeySchema = new mongoose.Schema({
  clientId: {
    type: String,
    required: true,
    index: true,
  },
  provider: {
    type: String,
    required: true,
    enum: [
      "openai",
      "deepgram",
      "sarvam",
      "elevenlabs",
      "lmnt",
      "google_cloud",
      "azure_speech",
      "aws_transcribe",
      "aws_polly",
      "twilio",
      "vonage",
      "plivo",
      "bandwidth",
    ],
  },
  keyName: {
    type: String,
    required: true,
  },
  encryptedKey: {
    type: String,
    required: true,
  },
  keyPreview: {
    type: String,
    required: true,
  }, // First 8 chars + "..." for display
  isActive: {
    type: Boolean,
    default: true,
  },
  usage: {
    totalRequests: { type: Number, default: 0 },
    lastUsed: { type: Date },
    monthlyUsage: { type: Number, default: 0 },
    monthlyLimit: { type: Number, default: 10000 },
  },
  configuration: {
    // Provider-specific settings
    model: String, // For OpenAI: gpt-4, gpt-3.5-turbo
    voice: String, // For TTS providers
    language: String, // Default language
    region: String, // For regional APIs
    customSettings: { type: Map, of: String },
  },
  metadata: {
    addedBy: String,
    description: String,
    environment: {
      type: String,
      enum: ["development", "staging", "production"],
      default: "production",
    },
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
})

// Compound index for client + provider uniqueness
apiKeySchema.index({ clientId: 1, provider: 1 }, { unique: true })

apiKeySchema.pre("save", function (next) {
  this.updatedAt = Date.now()
  next()
})

// Encryption/Decryption methods
apiKeySchema.statics.encryptKey = (key) => {
  const algorithm = "aes-256-cbc"
  const secretKey = crypto
    .createHash("sha256")
    .update(process.env.ENCRYPTION_SECRET || "default-secret-key-change-in-production")
    .digest()
  const iv = crypto.randomBytes(16)

  const cipher = crypto.createCipheriv(algorithm, secretKey, iv)
  let encrypted = cipher.update(key, "utf8", "hex")
  encrypted += cipher.final("hex")

  return iv.toString("hex") + ":" + encrypted
}

apiKeySchema.statics.decryptKey = (encryptedKey) => {
  const algorithm = "aes-256-cbc"
  const secretKey = crypto
    .createHash("sha256")
    .update(process.env.ENCRYPTION_SECRET || "default-secret-key-change-in-production")
    .digest()

  const parts = encryptedKey.split(":")
  const iv = Buffer.from(parts[0], "hex")
  const encrypted = parts[1]

  const decipher = crypto.createDecipheriv(algorithm, secretKey, iv)
  let decrypted = decipher.update(encrypted, "hex", "utf8")
  decrypted += decipher.final("utf8")

  return decrypted
}

apiKeySchema.methods.getDecryptedKey = function () {
  return this.constructor.decryptKey(this.encryptedKey)
}

module.exports = mongoose.model("ApiKey", apiKeySchema)
