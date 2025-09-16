const mongoose = require("mongoose")

const agentSchema = new mongoose.Schema({
  // Client Information
  clientId: { type: String }, // Optional - can be set by admin or client
  
  // Creation tracking
  createdBy: { type: String }, // ID of the user who created the agent
  createdByType: { 
    type: String, 
    enum: ["client", "admin"], 
    default: "admin" 
  }, // Type of user who created the agent
  
  agentId: {type: String},
  // Active Status
  isActive: { type: Boolean, default: true, index: true },
  isApproved: { type: Boolean, default: false, index: true },

  // Personal Information
  agentName: { type: String, required: true },
  description: { type: String, required: true },
  category: { type: String },
  personality: {
    type: String,
    enum: ["formal", "informal", "friendly", "flirty", "disciplined"],
    default: "formal",
  },
  language: { type: String, default: "en" },

  // System Information
  firstMessage: { type: String, required: true },
  systemPrompt: { type: String, required: true },
  sttSelection: {
    type: String,
    enum: ["deepgram", "whisper", "google", "azure", "aws"],
    default: "deepgram",
  },
  ttsSelection: {
    type: String,
    enum: ["sarvam", "elevenlabs", "openai", "google", "azure", "aws"],
    default: "sarvam",
  },
  llmSelection: {
    type: String,
    enum: ["openai", "anthropic", "google", "azure"],
    default: "openai",
  },
  voiceSelection: {
    type: String,
    enum: [
      "male-professional",
      "female-professional",
      "male-friendly",
      "female-friendly",
      "neutral",
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
    ],
    default: "meera",
  },
  contextMemory: { type: String },
  brandInfo: { type: String },


  // Multiple starting messages
  startingMessages: [
    {
      text: { type: String, required: true },
      audioBase64: { type: String },
    },
  ],

  // Telephony
  accountSid: { type: String },
  callingNumber: { type: String }, // Add missing callingNumber field
  callerId: { type: String, index: true }, // For outbound call matching
  serviceProvider: {
    type: String,
    enum: ["twilio", "vonage", "plivo", "bandwidth", "other", "c-zentrix", "tata", "snapbx"],
  },
  X_API_KEY: { type: String }, // Add missing X_API_KEY field

  // SnapBX provider fields
  didNumber: { type: String },
  accessToken: { type: String },
  accessKey: { type: String },

  // UI customization
  uiImage: { type: String }, // base64 image for agent avatar/logo
  backgroundImage: { type: String }, // base64 image for background
  backgroundColor: { type: String }, // hex color string

  // Knowledge Base: store S3 keys and optional titles
  knowledgeBase: [
    {
      key: { type: String, required: true },
      name: { type: String },
      uploadedAt: { type: Date, default: Date.now },
    },
  ],

  // Depositions with sub-depositions
  depositions: [
    {
      title: { type: String, required: true },
      sub: [{ type: String }],
    },
  ],
  // Audio storage - Store as base64 string instead of Buffer
  audioFile: { type: String }, // File path (legacy support)
  audioBytes: {
    type: String, // Store as base64 string
    validate: {
      validator: (v) => !v || typeof v === "string",
      message: "audioBytes must be a string",
    },
  },
  audioMetadata: {
    format: { type: String, default: "mp3" },
    sampleRate: { type: Number, default: 22050 },
    channels: { type: Number, default: 1 },
    size: { type: Number },
    generatedAt: { type: Date },
    language: { type: String, default: "en" },
    speaker: { type: String },
    provider: { type: String, default: "sarvam" },
  },

  //socials
  // Social media enable flags
  whatsappEnabled: { type: Boolean, default: false },
  telegramEnabled: { type: Boolean, default: false },
  emailEnabled: { type: Boolean, default: false },
  smsEnabled: { type: Boolean, default: false },

  // Convenience single WhatsApp link for quick access
  whatsapplink: { type: String },

  whatsapp: [
    {
      link: { type: String, required: true },
    },
  ],
  telegram: [
    {
      link: { type: String, required: true },
    },
  ],
  email: [
    {
      link: { type: String, required: true },
    },
  ],
  sms: [
    {
      link: { type: String, required: true },
    },
  ],

  // Assigned templates (admin -> agent)
  templates: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Template' }],
  
  // WhatsApp template data for approved templates
  whatsappTemplates: [
    {
      templateId: { type: String },
      templateName: { type: String },
      templateUrl: { type: String },
      description: { type: String },
      language: { type: String },
      status: { type: String },
      category: { type: String },
      assignedAt: { type: Date, default: Date.now }
    }
  ],

  // Default template for each platform
  defaultTemplate: {
    templateId: { type: String },
    templateName: { type: String },
    templateUrl: { type: String },
    platform: { type: String }
  },

  // Timestamps
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
})

// // Compound index for client + agent name uniqueness
// agentSchema.index({ clientId: 1, agentName: 1 }, { unique: true })

// // Additional index for callerId lookup (outbound calls) with isActive filter
// agentSchema.index({ callerId: 1, isActive: 1 })

// // Additional index for accountSid lookup with isActive filter
// agentSchema.index({ accountSid: 1, isActive: 1 })

// // Ensure only one active agent per (clientId, accountSid)
// // Partial unique index applies only when isActive is true and accountSid exists
// try {
//   agentSchema.index(
//     { clientId: 1, accountSid: 1 },
//     {
//       unique: true,
//       partialFilterExpression: {
//         isActive: true,
//         accountSid: { $exists: true, $type: 'string' },
//       },
//     }
//   )
// } catch (e) {
//   // Index creation failures will be logged by Mongoose at startup; continue
// }

// Update the updatedAt field before saving
agentSchema.pre("save", function (next) {
  this.updatedAt = Date.now()

  // Clean up disabled social media fields
  if (!this.whatsappEnabled) {
    this.whatsapp = undefined;
    this.whatsapplink = undefined;
  }
  if (!this.telegramEnabled) {
    this.telegram = undefined;
  }
  if (!this.emailEnabled) {
    this.email = undefined;
  }
  if (!this.smsEnabled) {
    this.sms = undefined;
  }

  // Validate and convert audioBytes if present
  if (this.audioBytes) {
    if (typeof this.audioBytes === "string") {
      // Already a string, ensure metadata is updated
      if (!this.audioMetadata) {
        this.audioMetadata = {}
      }
      // Calculate actual byte size from base64 string
      const byteSize = Math.ceil((this.audioBytes.length * 3) / 4)
      this.audioMetadata.size = byteSize
      console.log(`[AGENT_MODEL] Audio stored as base64 string: ${this.audioBytes.length} chars (${byteSize} bytes)`)
    } else {
      return next(new Error("audioBytes must be a string"))
    }
  }

  next()
})

// Method to get audio as base64
agentSchema.methods.getAudioBase64 = function () {
  if (this.audioBytes && typeof this.audioBytes === "string") {
    return this.audioBytes
  }
  return null
}

// Method to set audio from base64
agentSchema.methods.setAudioFromBase64 = function (base64String) {
  if (base64String && typeof base64String === "string") {
    this.audioBytes = base64String
    if (!this.audioMetadata) {
      this.audioMetadata = {}
    }
    // Calculate actual byte size from base64 string
    const byteSize = Math.ceil((base64String.length * 3) / 4)
    this.audioMetadata.size = byteSize
  }
}

// Method to get only enabled social media fields
agentSchema.methods.getEnabledSocials = function() {
  const enabledSocials = {};
  
  if (this.whatsappEnabled && this.whatsapp && this.whatsapp.length > 0) {
    enabledSocials.whatsapp = this.whatsapp;
  }
  
  if (this.telegramEnabled && this.telegram && this.telegram.length > 0) {
    enabledSocials.telegram = this.telegram;
  }
  
  if (this.emailEnabled && this.email && this.email.length > 0) {
    enabledSocials.email = this.email;
  }
  
  if (this.smsEnabled && this.sms && this.sms.length > 0) {
    enabledSocials.sms = this.sms;
  }
  
  return enabledSocials;
}

// Method to check if a social media platform is enabled
agentSchema.methods.isSocialEnabled = function(platform) {
  const enabledPlatforms = {
    whatsapp: this.whatsappEnabled,
    telegram: this.telegramEnabled,
    email: this.emailEnabled,
    sms: this.smsEnabled
  };
  
  return enabledPlatforms[platform] || false;
}

// Method to enable/disable a social media platform
agentSchema.methods.toggleSocial = function(platform, enabled) {
  const platformField = `${platform}Enabled`;
  if (this.schema.paths[platformField]) {
    this[platformField] = enabled;
    
    // If disabling, clear the social media data
    if (!enabled) {
      this[platform] = undefined;
    }
    
    return true;
  }
  return false;
}

module.exports = mongoose.model("Agent", agentSchema)