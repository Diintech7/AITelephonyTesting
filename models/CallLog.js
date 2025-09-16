const mongoose = require('mongoose');

const CallLogSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', index: true },
  agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Agent', index: true },
  mobile: String,
  time: Date,
  transcript: { type: String, default: "" }, // Will be updated live
  audioUrl: String,
  duration: { type: Number, default: 0 }, // Will be updated live
  leadStatus: { 
    type: String, 
    enum: [
      // Connected - Interested
      'vvi',                    // very very interested
      'maybe',                  // maybe
      'enrolled',               // enrolled
      
      // Connected - Not Interested
      'junk_lead',              // junk lead
      'not_required',           // not required
      'enrolled_other',         // enrolled other
      'decline',                // decline
      'not_eligible',           // not eligible
      'wrong_number',           // wrong number
      
      // Connected - Followup
      'hot_followup',           // hot followup
      'cold_followup',          // cold followup
      'schedule',               // schedule
      
      // Not Connected
      'not_connected'           // not connected
    ], 
    default: 'maybe' 
  },
  
  // Disposition tracking based on agent's depositions
  disposition: { 
    type: String, 
    default: null 
  },
  subDisposition: { 
    type: String, 
    default: null 
  },
  dispositionId: { 
    type: String, 
    default: null 
  },
  subDispositionId: { 
    type: String, 
    default: null 
  },
  
  // Telephony identifiers for call management
  streamSid: { type: String, index: true }, // For active call tracking
  callSid: { type: String, index: true },   // For call identification
  // Enhanced metadata for live tracking
  metadata: {
    userTranscriptCount: { type: Number, default: 0 },
    aiResponseCount: { type: Number, default: 0 },
    languages: [{ type: String }],
    callEndTime: { type: Date },
    callDirection: { type: String, enum: ['inbound', 'outbound'], default: 'inbound' },
    isActive: { type: Boolean, default: true }, // Track if call is ongoing
    lastUpdated: { type: Date, default: Date.now }, // Track last live update
    // Custom params from czdata
    customParams: {
      type: Object,
      default: {},
    },
    // Telephony identifiers
    callerId: { type: String },
    // Performance metrics
    totalUpdates: { type: Number, default: 0 },
    averageResponseTime: { type: Number },
    // Technical details
    sttProvider: { type: String, default: 'deepgram' },
    ttsProvider: { type: String, default: 'sarvam' },
    llmProvider: { type: String, default: 'openai' },
    // WhatsApp tracking (persist intent and send status)
    whatsappRequested: { type: Boolean, default: false },
    whatsappMessageSent: { type: Boolean, default: false }
  }
}, {
  timestamps: true
});

// Enhanced indexes for better performance with live updates
CallLogSchema.index({ clientId: 1, campaignId: 1, agentId: 1, time: -1 });
CallLogSchema.index({ clientId: 1, leadStatus: 1 });
CallLogSchema.index({ 'metadata.isActive': 1, 'metadata.lastUpdated': 1 }); // For active call queries
CallLogSchema.index({ clientId: 1, 'metadata.isActive': 1 }); // For client's active calls
CallLogSchema.index({ streamSid: 1 }); // For active call lookup by streamSid
CallLogSchema.index({ callSid: 1 });   // For call lookup by callSid

// Pre-save middleware to update metadata
CallLogSchema.pre('save', function(next) {
  if (this.metadata) {
    this.metadata.lastUpdated = new Date();
    if (this.isModified('transcript')) {
      this.metadata.totalUpdates = (this.metadata.totalUpdates || 0) + 1;
    }
  }
  next();
});

// Static method to get active calls for a client
CallLogSchema.statics.getActiveCalls = function(clientId) {
  return this.find({ 
    clientId: clientId, 
    'metadata.isActive': true 
  }).sort({ 'metadata.lastUpdated': -1 });
};

// Static method to find active call by streamSid
CallLogSchema.statics.findActiveCallByStreamSid = function(streamSid) {
  return this.findOne({ 
    streamSid: streamSid, 
    'metadata.isActive': true 
  });
};

// Static method to cleanup stale active calls (calls marked active but haven't updated in 10 minutes)
CallLogSchema.statics.cleanupStaleActiveCalls = function() {
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
  return this.updateMany(
    { 
      'metadata.isActive': true,
      'metadata.lastUpdated': { $lt: tenMinutesAgo }
    },
    { 
      $set: { 
        'metadata.isActive': false,
        leadStatus: 'not_connected'
      }
    }
  );
};

// Instance method to add live transcript entry
CallLogSchema.methods.addLiveTranscriptEntry = function(entry) {
  const timestamp = entry.timestamp || new Date();
  const speaker = entry.type === "user" ? "User" : "AI";
  const transcriptLine = `[${timestamp.toISOString()}] ${speaker} (${entry.language}): ${entry.text}`;
  
  if (this.transcript) {
    this.transcript += '\n' + transcriptLine;
  } else {
    this.transcript = transcriptLine;
  }
  
  // Update metadata
  if (entry.type === "user") {
    this.metadata.userTranscriptCount = (this.metadata.userTranscriptCount || 0) + 1;
  } else {
    this.metadata.aiResponseCount = (this.metadata.aiResponseCount || 0) + 1;
  }
  
  // Update languages array
  if (!this.metadata.languages.includes(entry.language)) {
    this.metadata.languages.push(entry.language);
  }
  
  this.metadata.lastUpdated = new Date();
};

module.exports = mongoose.model('CallLog', CallLogSchema);