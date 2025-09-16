const mongoose = require("mongoose");

const humanAgentSchema = new mongoose.Schema({
  // Client reference
  clientId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Client', 
    required: true, 
    index: true 
  },

  // Personal Information
  humanAgentName: { 
    type: String, 
    required: true 
  },
  email: { 
    type: String, 
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  mobileNumber:{
    type:String,
    required: true
  },
  role: {
    type: String,
    enum: ['executive', 'team leads', 'deputy manager', 'deputy director', 'manager', 'director'],
    default: 'executive',
    required: true
  },

  // Status flags
  isprofileCompleted: { 
    type: Boolean, 
    default: false 
  },
  isApproved: { 
    type: Boolean, 
    default: false 
  },

  // Agent IDs array (required)
  agentIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Agent',
    required: true
  }],

  // Timestamps
  createdAt: { 
    type: Date, 
    default: Date.now 
  },
  updatedAt: { 
    type: Date, 
    default: Date.now 
  }
});

// Update the updatedAt field before saving
humanAgentSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Compound index for client + human agent name uniquene

module.exports = mongoose.model("HumanAgent", humanAgentSchema); 