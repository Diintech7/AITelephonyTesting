const mongoose = require("mongoose");

const CreditSchema = new mongoose.Schema({
  // Client Reference
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    required: true,
    index: true
  },
  
  // Current Balance
  currentBalance: {
    type: Number,
    default: 0,
    min: 0
  },
  
  // Total Credits Ever Purchased
  totalPurchased: {
    type: Number,
    default: 0,
    min: 0
  },
  
  // Total Credits Ever Used
  totalUsed: {
    type: Number,
    default: 0,
    min: 0
  },
  
  // Credit History
  history: [{
    type: {
      type: String,
      enum: ['purchase', 'usage', 'refund', 'bonus', 'expiry', 'adjustment'],
      required: true
    },
    amount: {
      type: Number,
      required: true
    },
    description: {
      type: String,
      required: true
    },
    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Plan'
    },
    transactionId: {
      type: String
    },
    usageType: {
      type: String,
      enum: ['call', 'whatsapp', 'telegram', 'email', 'sms', 'other']
    },
    duration: {
      type: Number // For calls in minutes
    },
    messageCount: {
      type: Number // For messages
    },
    metadata: {
      type: Map,
      of: String
    },
    timestamp: {
      type: Date,
      default: Date.now
    }
  }],
  
  // Current Plan Information
  currentPlan: {
    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Plan'
    },
    startDate: {
      type: Date
    },
    endDate: {
      type: Date
    },
    billingCycle: {
      type: String,
      enum: ['monthly', 'quarterly', 'yearly']
    },
    autoRenew: {
      type: Boolean,
      default: false
    }
  },
  
  // Usage Statistics
  usageStats: {
    calls: {
      total: { type: Number, default: 0 },
      minutes: { type: Number, default: 0 },
      creditsUsed: { type: Number, default: 0 }
    },
    whatsapp: {
      messages: { type: Number, default: 0 },
      creditsUsed: { type: Number, default: 0 }
    },
    telegram: {
      messages: { type: Number, default: 0 },
      creditsUsed: { type: Number, default: 0 }
    },
    email: {
      messages: { type: Number, default: 0 },
      creditsUsed: { type: Number, default: 0 }
    },
    sms: {
      messages: { type: Number, default: 0 },
      creditsUsed: { type: Number, default: 0 }
    }
  },
  
  // Monthly Usage Tracking
  monthlyUsage: [{
    month: {
      type: String, // Format: "YYYY-MM"
      required: true
    },
    calls: {
      count: { type: Number, default: 0 },
      minutes: { type: Number, default: 0 },
      credits: { type: Number, default: 0 }
    },
    whatsapp: {
      count: { type: Number, default: 0 },
      credits: { type: Number, default: 0 }
    },
    telegram: {
      count: { type: Number, default: 0 },
      credits: { type: Number, default: 0 }
    },
    email: {
      count: { type: Number, default: 0 },
      credits: { type: Number, default: 0 }
    },
    sms: {
      count: { type: Number, default: 0 },
      credits: { type: Number, default: 0 }
    },
    totalCredits: { type: Number, default: 0 }
  }],
  
  // Settings
  settings: {
    lowBalanceAlert: {
      enabled: { type: Boolean, default: true },
      threshold: { type: Number, default: 100 }
    },
    autoPurchase: {
      enabled: { type: Boolean, default: false },
      planId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan' },
      threshold: { type: Number, default: 50 }
    }
  },

  // Unbilled leftover seconds to carry into next call
  rolloverSeconds: {
    type: Number,
    default: 0,
    min: 0,
  },
  
  // Call billing details for tracking
  callBillingDetails: [{
    mobile: {
      type: String,
      required: true
    },
    callDirection: {
      type: String,
      enum: ['inbound', 'outbound'],
      required: true
    },
    duration: {
      type: String, // Format: "1:30" for 1 minute 30 seconds
      required: true
    },
    durationSeconds: {
      type: Number, // Total seconds for calculation
      required: true
    },
    creditsUsed: {
      type: Number, // Decimal credits used (e.g., 1.50 for 45 seconds)
      required: true,
      min: 0
    },
    callLogId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CallLog'
    },
    streamSid: {
      type: String
    },
    uniqueid: {
      type: String // For outbound calls tracking
    },
    timestamp: {
      type: Date,
      default: Date.now
    }
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

// Update timestamp on save
CreditSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Index for efficient queries
CreditSchema.index({ clientId: 1, 'history.timestamp': -1 });

// Method to add credits (purchase, bonus, refund)
CreditSchema.methods.addCredits = function(amount, type, description, planId = null, transactionId = null) {
  this.currentBalance += amount;
  this.totalPurchased += amount;
  
  this.history.push({
    type: type,
    amount: amount,
    description: description,
    planId: planId,
    transactionId: transactionId,
    timestamp: new Date()
  });
  
  return this.save();
};

// Method to use credits
CreditSchema.methods.useCredits = function(amount, usageType, description, metadata = {}) {
  // Normalize usage type keys (schema uses 'calls' in usageStats but history enum has 'call')
  const normalizedUsageType = usageType === 'call' ? 'calls' : usageType;
  
  // Round amount to 2 decimal places for precision
  const roundedAmount = Math.round(amount * 100) / 100;
  
  if (this.currentBalance < roundedAmount) {
    throw new Error('Insufficient credits');
  }
  
  this.currentBalance -= roundedAmount;
  this.totalUsed += roundedAmount;
  
  // Update usage statistics
  if (normalizedUsageType && this.usageStats[normalizedUsageType]) {
    this.usageStats[normalizedUsageType].creditsUsed += roundedAmount;
    if (normalizedUsageType === 'calls') {
      this.usageStats.calls.total += 1;
      this.usageStats.calls.minutes += (metadata.duration || 0);
    } else {
      this.usageStats[normalizedUsageType].messages += (metadata.messageCount || 1);
    }
  }
  
  // Update monthly usage
  this.updateMonthlyUsage(roundedAmount, normalizedUsageType, metadata);
  
  this.history.push({
    type: 'usage',
    amount: -roundedAmount,
    description: description,
    usageType: usageType, // preserve original label in history
    duration: metadata.duration,
    messageCount: metadata.messageCount,
    metadata: metadata,
    timestamp: new Date()
  });
  
  return this.save();
};

// Method to update monthly usage
CreditSchema.methods.updateMonthlyUsage = function(amount, usageType, metadata = {}) {
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  
  let monthlyRecord = this.monthlyUsage.find(record => record.month === monthKey);
  
  if (!monthlyRecord) {
    monthlyRecord = {
      month: monthKey,
      calls: { count: 0, minutes: 0, credits: 0 },
      whatsapp: { count: 0, credits: 0 },
      telegram: { count: 0, credits: 0 },
      email: { count: 0, credits: 0 },
      sms: { count: 0, credits: 0 },
      totalCredits: 0
    };
    this.monthlyUsage.push(monthlyRecord);
  }
  
  // Round to 2 decimal places for monthly tracking
  const roundedAmount = Math.round(amount * 100) / 100;
  monthlyRecord.totalCredits += roundedAmount;
  
  if (usageType && monthlyRecord[usageType]) {
    monthlyRecord[usageType].credits += roundedAmount;
    if (usageType === 'calls') {
      monthlyRecord.calls.count += 1;
      monthlyRecord.calls.minutes += (metadata.duration || 0);
    } else {
      monthlyRecord[usageType].count += (metadata.messageCount || 1);
    }
  }
};

// Method to get current month usage
CreditSchema.methods.getCurrentMonthUsage = function() {
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  
  return this.monthlyUsage.find(record => record.month === monthKey) || {
    month: monthKey,
    calls: { count: 0, minutes: 0, credits: 0 },
    whatsapp: { count: 0, credits: 0 },
    telegram: { count: 0, credits: 0 },
    email: { count: 0, credits: 0 },
    sms: { count: 0, credits: 0 },
    totalCredits: 0
  };
};

// Method to check if low balance alert should be triggered
CreditSchema.methods.shouldTriggerLowBalanceAlert = function() {
  return this.settings.lowBalanceAlert.enabled && 
         this.currentBalance <= this.settings.lowBalanceAlert.threshold;
};

// Method to bill call credits with decimal precision (1/30 credit per second)
CreditSchema.methods.billCallCredits = function(durationSeconds, mobile, callDirection, callLogId = null, streamSid = null, uniqueid = null) {
  // Calculate credits using formula: (1/30) * totalSeconds
  const creditsPerSecond = 1/30;
  const totalCredits = (creditsPerSecond * durationSeconds);
  
  // Round to 2 decimal places
  const roundedCredits = Math.round(totalCredits * 100) / 100;
  
  // Check if sufficient balance
  if (this.currentBalance < roundedCredits) {
    throw new Error(`Insufficient credits. Required: ${roundedCredits}, Available: ${this.currentBalance}`);
  }
  
  // Format duration as "M:SS" or "H:MM:SS"
  const formatDuration = (seconds) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
      return `${minutes}:${secs.toString().padStart(2, '0')}`;
    }
  };
  
  const durationFormatted = formatDuration(durationSeconds);
  
  // Deduct credits
  this.currentBalance -= roundedCredits;
  this.totalUsed += roundedCredits;
  
  // Add to call billing details
  this.callBillingDetails.push({
    mobile: mobile || 'unknown',
    callDirection: callDirection || 'inbound',
    duration: durationFormatted,
    durationSeconds: durationSeconds,
    creditsUsed: roundedCredits,
    callLogId: callLogId,
    streamSid: streamSid,
    uniqueid: uniqueid,
    timestamp: new Date()
  });
  
  // Update usage statistics
  this.usageStats.calls.total += 1;
  this.usageStats.calls.minutes += Math.round(durationSeconds / 60 * 100) / 100; // Convert to minutes with 2 decimal places
  this.usageStats.calls.creditsUsed += roundedCredits;
  
  // Update monthly usage
  this.updateMonthlyUsage(roundedCredits, 'calls', {
    duration: Math.round(durationSeconds / 60 * 100) / 100,
    mobile: mobile,
    callDirection: callDirection
  });
  
  // Add to history
  this.history.push({
    type: 'usage',
    amount: -roundedCredits,
    description: `Call charges (${callDirection || 'inbound'}) - ${durationFormatted} - ${mobile || 'unknown'}`,
    usageType: 'call',
    duration: Math.round(durationSeconds / 60 * 100) / 100,
    metadata: {
      mobile: mobile || null,
      callDirection: callDirection || null,
      callLogId: callLogId || null,
      streamSid: streamSid || null,
      uniqueid: uniqueid || null,
      durationSeconds: durationSeconds,
      durationFormatted: durationFormatted
    },
    timestamp: new Date()
  });
  
  return {
    creditsUsed: roundedCredits,
    durationFormatted: durationFormatted,
    balanceAfter: this.currentBalance
  };
};

// Static method to get credit balance for a client
CreditSchema.statics.getClientBalance = function(clientId) {
  return this.findOne({ clientId }).populate('currentPlan.planId');
};

// Static method to create or get credit record for a client
CreditSchema.statics.getOrCreateCreditRecord = async function(clientId) {
  let creditRecord = await this.findOne({ clientId });
  
  if (!creditRecord) {
    creditRecord = new this({
      clientId: clientId,
      currentBalance: 0,
      totalPurchased: 0,
      totalUsed: 0,
      history: [],
      usageStats: {
        calls: { total: 0, minutes: 0, creditsUsed: 0 },
        whatsapp: { messages: 0, creditsUsed: 0 },
        telegram: { messages: 0, creditsUsed: 0 },
        email: { messages: 0, creditsUsed: 0 },
        sms: { messages: 0, creditsUsed: 0 }
      },
      monthlyUsage: [],
      callBillingDetails: [],
      settings: {
        lowBalanceAlert: { enabled: true, threshold: 100 },
        autoPurchase: { enabled: false, threshold: 50 }
      }
    });
    await creditRecord.save();
  }
  
  return creditRecord;
};

module.exports = mongoose.model("Credit", CreditSchema);
