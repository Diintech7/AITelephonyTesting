// models/Payment.js
const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  orderId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    required: true,
    index: true
  },
  amount: {
    type: Number,
    required: true
  },
  planKey: {
    type: String,
    required: true,
    enum: ['basic', 'professional', 'enterprise']
  },
  gateway: {
    type: String,
    required: true,
    enum: ['cashfree', 'paytm', 'razorpay'],
    default: 'cashfree'
  },
  status: {
    type: String,
    enum: ['INITIATED', 'PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'TXN_SUCCESS'],
    default: 'INITIATED',
    index: true
  },
  sessionId: {
    type: String, // Cashfree payment session ID
    index: true
  },
  paymentLink: {
    type: String, // Direct payment link URL
    index: true
  },
  transactionId: {
    type: String, // Gateway transaction ID
    index: true
  },
  orderStatus: {
    type: String // Gateway specific order status
  },
  responseCode: String,
  responseMsg: String,
  credited: {
    type: Boolean,
    default: false,
    index: true
  },
  creditsAdded: {
    type: Number,
    default: 0
  },
  rawResponse: {
    type: mongoose.Schema.Types.Mixed // Store full gateway response
  },
  rawCallback: {
    type: mongoose.Schema.Types.Mixed // Store callback data
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

// Index for efficient queries
paymentSchema.index({ clientId: 1, createdAt: -1 });
paymentSchema.index({ status: 1, credited: 1 });
paymentSchema.index({ gateway: 1, status: 1 });

// Static method to find pending payments
paymentSchema.statics.findPendingPayments = function(gateway = null) {
  const query = { 
    status: { $in: ['INITIATED', 'PENDING'] },
    createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } // Last 24 hours
  };
  
  if (gateway) {
    query.gateway = gateway;
  }
  
  return this.find(query);
};

// Instance method to mark as completed
paymentSchema.methods.markCompleted = function(transactionId, creditsAdded = 0) {
  this.status = 'SUCCESS';
  this.transactionId = transactionId;
  this.credited = true;
  this.creditsAdded = creditsAdded;
  return this.save();
};

// Instance method to mark as failed
paymentSchema.methods.markFailed = function(reason = '') {
  this.status = 'FAILED';
  this.responseMsg = reason;
  return this.save();
};

// Pre-save middleware to update timestamps
paymentSchema.pre('save', function(next) {
  if (this.isModified('status') && this.status === 'SUCCESS') {
    this.metadata.completedAt = new Date();
  }
  next();
});

const Payment = mongoose.model('Payment', paymentSchema);

module.exports = Payment;