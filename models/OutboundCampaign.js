const mongoose = require("mongoose")

const outboundCampaignSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  campaignName: { type: String, required: true },
  description: { type: String },

  // Agent Configuration
  agentId: { type: mongoose.Schema.Types.ObjectId, ref: "Agent", required: true },

  // Group Configuration
  groupId: { type: mongoose.Schema.Types.ObjectId, ref: "Group", required: true },

  // Campaign Settings
  callerId: { type: String, required: true }, // Your assigned Caller ID
  apiKey: { type: String, required: true },

  // Call Timing
  startTime: { type: Date },
  endTime: { type: Date },
  timezone: { type: String, default: "Asia/Kolkata" },

  // Call Configuration
  maxRetries: { type: Number, default: 3 },
  retryInterval: { type: Number, default: 300 }, // seconds
  callTimeout: { type: Number, default: 60 }, // seconds

  // Campaign Status
  status: {
    type: String,
    enum: ["draft", "scheduled", "running", "paused", "completed", "cancelled"],
    default: "draft",
  },

  // Progress Tracking
  totalContacts: { type: Number, default: 0 },
  contactsCalled: { type: Number, default: 0 },
  successfulCalls: { type: Number, default: 0 },
  failedCalls: { type: Number, default: 0 },

  // Call Results
  callResults: [
    {
      contactId: { type: mongoose.Schema.Types.ObjectId },
      phoneNumber: { type: String },
      status: {
        type: String,
        enum: ["pending", "calling", "connected", "completed", "failed", "busy", "no_answer"],
      },
      attempts: { type: Number, default: 0 },
      lastAttempt: { type: Date },
      callDuration: { type: Number }, // seconds
      leadStatus: {
        type: String,
        enum: ["very_interested", "medium", "not_interested", "not_connected"],
        default: "not_connected",
      },
      transcript: { type: String },
      callLogId: { type: mongoose.Schema.Types.ObjectId, ref: "CallLog" },
    },
  ],

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
})

// Compound index for client + campaign name uniqueness
outboundCampaignSchema.index({ clientId: 1, campaignName: 1 }, { unique: true })

// Update the updatedAt field before saving
outboundCampaignSchema.pre("save", function (next) {
  this.updatedAt = Date.now()
  next()
})

module.exports = mongoose.model("OutboundCampaign", outboundCampaignSchema)
