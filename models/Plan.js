const mongoose = require("mongoose");

const PlanSchema = new mongoose.Schema({
  // Basic Plan Information
  name: {
    type: String,
    required: [true, "Plan name is required"],
    trim: true
  },
  description: {
    type: String,
    required: [true, "Plan description is required"],
    trim: true
  },
  category: {
    type: String,
    enum: ["basic", "professional", "enterprise", "custom"],
    default: "basic"
  },
  
  // Pricing Information
  price: {
    type: Number,
    required: [true, "Plan price is required"],
    min: 0
  },
  currency: {
    type: String,
    default: "USD"
  },
  billingCycle: {
    type: String,
    enum: ["monthly", "quarterly", "yearly"],
    default: "monthly"
  },
  
  // Credit Allocation
  creditsIncluded: {
    type: Number,
    required: [true, "Credits included is required"],
    min: 0
  },
  bonusCredits: {
    type: Number,
    default: 0,
    min: 0
  },
  
  // Usage Rates (credits per action)
  usageRates: {
    callPerMinute: {
      type: Number,
      required: [true, "Call per minute rate is required"],
      min: 0
    },
    whatsappMessage: {
      type: Number,
      required: [true, "WhatsApp message rate is required"],
      min: 0
    },
    telegramMessage: {
      type: Number,
      required: [true, "Telegram message rate is required"],
      min: 0
    },
    emailMessage: {
      type: Number,
      required: [true, "Email message rate is required"],
      min: 0
    },
    smsMessage: {
      type: Number,
      required: [true, "SMS message rate is required"],
      min: 0
    }
  },
  
  // Features
  features: {
    maxAgents: {
      type: Number,
      default: 1
    },
    maxCampaigns: {
      type: Number,
      default: 1
    },
    maxContacts: {
      type: Number,
      default: 100
    },
    voiceCalls: {
      type: Boolean,
      default: true
    },
    whatsappIntegration: {
      type: Boolean,
      default: false
    },
    telegramIntegration: {
      type: Boolean,
      default: false
    },
    emailIntegration: {
      type: Boolean,
      default: false
    },
    smsIntegration: {
      type: Boolean,
      default: false
    },
    analytics: {
      type: Boolean,
      default: false
    },
    prioritySupport: {
      type: Boolean,
      default: false
    },
    customBranding: {
      type: Boolean,
      default: false
    },
    apiAccess: {
      type: Boolean,
      default: false
    }
  },
  
  // Discounts and Coupons
  discounts: {
    monthlyDiscount: {
      type: Number,
      default: 0,
      min: 0,
      max: 100
    },
    quarterlyDiscount: {
      type: Number,
      default: 0,
      min: 0,
      max: 100
    },
    yearlyDiscount: {
      type: Number,
      default: 0,
      min: 0,
      max: 100
    }
  },
  
  // Plan Status
  isActive: {
    type: Boolean,
    default: true
  },
  isPopular: {
    type: Boolean,
    default: false
  },
  isCustom: {
    type: Boolean,
    default: false
  },
  
  // Plan Limits
  limits: {
    maxCallsPerDay: {
      type: Number,
      default: 100
    },
    maxMessagesPerDay: {
      type: Number,
      default: 1000
    },
    maxStorageGB: {
      type: Number,
      default: 1
    }
  },
  
  // Metadata
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
    required: true
  },
  sortOrder: {
    type: Number,
    default: 0
  },
  
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
PlanSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Virtual for total credits (included + bonus)
PlanSchema.virtual('totalCredits').get(function() {
  return this.creditsIncluded + this.bonusCredits;
});

// Virtual for effective price after discounts
PlanSchema.virtual('effectivePrice').get(function() {
  const discount = this.discounts[`${this.billingCycle}Discount`] || 0;
  return this.price * (1 - discount / 100);
});

// Method to calculate credits needed for a call
PlanSchema.methods.calculateCallCredits = function(durationMinutes) {
  return Math.ceil(durationMinutes * this.usageRates.callPerMinute);
};

// Method to calculate credits needed for messages
PlanSchema.methods.calculateMessageCredits = function(messageType, count = 1) {
  const rates = {
    whatsapp: this.usageRates.whatsappMessage,
    telegram: this.usageRates.telegramMessage,
    email: this.usageRates.emailMessage,
    sms: this.usageRates.smsMessage
  };
  return rates[messageType] * count;
};

// Static method to get active plans
PlanSchema.statics.getActivePlans = function() {
  return this.find({ isActive: true }).sort({ sortOrder: 1, price: 1 });
};

// Static method to get popular plans
PlanSchema.statics.getPopularPlans = function() {
  return this.find({ isActive: true, isPopular: true }).sort({ sortOrder: 1 });
};

module.exports = mongoose.model("Plan", PlanSchema);
