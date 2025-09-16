const mongoose = require("mongoose");

const CouponSchema = new mongoose.Schema({
  // Basic Coupon Information
  code: {
    type: String,
    required: [true, "Coupon code is required"],
    unique: true,
    uppercase: true,
    trim: true
  },
  name: {
    type: String,
    required: [true, "Coupon name is required"],
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  
  // Discount Information
  discountType: {
    type: String,
    enum: ["percentage", "fixed", "credits"],
    required: [true, "Discount type is required"]
  },
  discountValue: {
    type: Number,
    required: [true, "Discount value is required"],
    min: 0
  },
  maxDiscount: {
    type: Number,
    min: 0
  },
  
  // Usage Limits
  maxUses: {
    type: Number,
    default: null, // null means unlimited
    min: 1
  },
  currentUses: {
    type: Number,
    default: 0,
    min: 0
  },
  maxUsesPerUser: {
    type: Number,
    default: 1,
    min: 1
  },
  
  // Validity Period
  validFrom: {
    type: Date,
    required: [true, "Valid from date is required"]
  },
  validUntil: {
    type: Date,
    required: [true, "Valid until date is required"]
  },
  
  // Applicability
  applicablePlans: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Plan'
  }],
  applicableCategories: [{
    type: String,
    enum: ["basic", "professional", "enterprise", "custom"]
  }],
  minimumPurchase: {
    type: Number,
    default: 0,
    min: 0
  },
  
  // Restrictions
  restrictions: {
    newUsersOnly: {
      type: Boolean,
      default: false
    },
    firstTimePurchase: {
      type: Boolean,
      default: false
    },
    specificUsers: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Client'
    }],
    excludedUsers: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Client'
    }]
  },
  
  // Status
  isActive: {
    type: Boolean,
    default: true
  },
  
  // Usage Tracking
  usageHistory: [{
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Client',
      required: true
    },
    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Plan'
    },
    orderAmount: {
      type: Number,
      required: true
    },
    discountApplied: {
      type: Number,
      required: true
    },
    finalAmount: {
      type: Number,
      required: true
    },
    usedAt: {
      type: Date,
      default: Date.now
    }
  }],
  
  // Metadata
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
    required: true
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
CouponSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Index for efficient queries
CouponSchema.index({ code: 1 });
CouponSchema.index({ isActive: 1, validFrom: 1, validUntil: 1 });

// Method to check if coupon is valid
CouponSchema.methods.isValid = function() {
  const now = new Date();
  
  // Check if coupon is active
  if (!this.isActive) {
    return { valid: false, reason: 'Coupon is inactive' };
  }
  
  // Check validity period
  if (now < this.validFrom || now > this.validUntil) {
    return { valid: false, reason: 'Coupon is not valid at this time' };
  }
  
  // Check usage limits
  if (this.maxUses && this.currentUses >= this.maxUses) {
    return { valid: false, reason: 'Coupon usage limit exceeded' };
  }
  
  return { valid: true };
};

// Method to check if coupon can be used by a specific user
CouponSchema.methods.canBeUsedBy = function(userId, isNewUser = false, isFirstTimePurchase = false) {
  const validity = this.isValid();
  if (!validity.valid) {
    return validity;
  }
  
  // Check if user is in excluded list
  if (this.restrictions.excludedUsers.includes(userId)) {
    return { valid: false, reason: 'Coupon not available for this user' };
  }
  
  // Check if coupon is for specific users only
  if (this.restrictions.specificUsers.length > 0 && !this.restrictions.specificUsers.includes(userId)) {
    return { valid: false, reason: 'Coupon not available for this user' };
  }
  
  // Check new users only restriction
  if (this.restrictions.newUsersOnly && !isNewUser) {
    return { valid: false, reason: 'Coupon only for new users' };
  }
  
  // Check first time purchase restriction
  if (this.restrictions.firstTimePurchase && !isFirstTimePurchase) {
    return { valid: false, reason: 'Coupon only for first-time purchases' };
  }
  
  // Check usage per user limit
  const userUsageCount = this.usageHistory.filter(usage => 
    usage.userId.toString() === userId.toString()
  ).length;
  
  if (userUsageCount >= this.maxUsesPerUser) {
    return { valid: false, reason: 'Maximum uses per user exceeded' };
  }
  
  return { valid: true };
};

// Method to check if coupon applies to a plan
CouponSchema.methods.appliesToPlan = function(planId, planCategory) {
  // Check specific plans
  if (this.applicablePlans.length > 0 && !this.applicablePlans.includes(planId)) {
    return false;
  }
  
  // Check plan categories
  if (this.applicableCategories.length > 0 && !this.applicableCategories.includes(planCategory)) {
    return false;
  }
  
  return true;
};

// Method to calculate discount
CouponSchema.methods.calculateDiscount = function(orderAmount) {
  let discount = 0;
  
  if (this.discountType === 'percentage') {
    discount = (orderAmount * this.discountValue) / 100;
    if (this.maxDiscount) {
      discount = Math.min(discount, this.maxDiscount);
    }
  } else if (this.discountType === 'fixed') {
    discount = Math.min(this.discountValue, orderAmount);
  } else if (this.discountType === 'credits') {
    discount = this.discountValue; // Credits are applied separately
  }
  
  return Math.round(discount * 100) / 100; // Round to 2 decimal places
};

// Method to apply coupon
CouponSchema.methods.applyCoupon = function(userId, planId, orderAmount) {
  const canUse = this.canBeUsedBy(userId);
  if (!canUse.valid) {
    throw new Error(canUse.reason);
  }
  
  const discount = this.calculateDiscount(orderAmount);
  const finalAmount = orderAmount - discount;
  
  // Record usage
  this.currentUses += 1;
  this.usageHistory.push({
    userId: userId,
    planId: planId,
    orderAmount: orderAmount,
    discountApplied: discount,
    finalAmount: finalAmount,
    usedAt: new Date()
  });
  
  return {
    discount: discount,
    finalAmount: finalAmount,
    creditsToAdd: this.discountType === 'credits' ? this.discountValue : 0
  };
};

// Static method to find valid coupon by code
CouponSchema.statics.findValidCoupon = function(code) {
  return this.findOne({ 
    code: code.toUpperCase(),
    isActive: true,
    validFrom: { $lte: new Date() },
    validUntil: { $gte: new Date() }
  });
};

// Static method to get all active coupons
CouponSchema.statics.getActiveCoupons = function() {
  return this.find({
    isActive: true,
    validFrom: { $lte: new Date() },
    validUntil: { $gte: new Date() }
  }).sort({ createdAt: -1 });
};

module.exports = mongoose.model("Coupon", CouponSchema);
