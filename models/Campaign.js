const mongoose = require('mongoose');

const campaignSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  category: {
    type: String,
    trim: true
  },
  isRunning: {
    type: Boolean,
    default: false
  },
  agent: [{
    type: String,
    trim: true
  }],
  groupIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Group'
  }],
  clientId: {
    type: String,
    required: true,
    index: true
  },
  // Array to store detailed call information for campaign calls
  details: [{
    uniqueId: { 
      type: String, 
      required: true,
      index: true 
    },
    contactId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'Contact'
      // Removed required: true to make it optional
    },
    time: { 
      type: Date, 
      default: Date.now 
    },
    status: { 
      type: String, 
      enum: ['ringing', 'ongoing', 'completed'], 
      default: 'ringing' 
    },
  }],
  // Array to store campaign contacts (copied from groups but can be manipulated independently)
  contacts: [{
    _id: {type: mongoose.Schema.Types.ObjectId},
    name: { type: String, required: true },
    phone: { type: String, required: true },
    email: { type: String, default: "" },
    addedAt: { type: Date, default: Date.now }
  }],
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Index for better performance on status queries
campaignSchema.index({ 'details.status': 1 });

// Ensure virtual fields are included when converting to JSON
campaignSchema.set('toJSON', { virtuals: true });
campaignSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Campaign', campaignSchema); 