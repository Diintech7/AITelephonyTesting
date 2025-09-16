const mongoose = require('mongoose');

const ProfileSchema = new mongoose.Schema({
  clientId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Client', 
    required: false
  },
  humanAgentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'HumanAgent',
    required: false
  },
  businessName: { 
    type: String, 
    trim: true,
    maxlength: 100
  },
  businessType: { 
    type: String, 
    trim: true,
    maxlength: 50
  },
  contactNumber: { 
    type: String, 
    required: true,
    trim: true,
    maxlength: 20
  },
  contactName: { 
    type: String, 
    required: true,
    maxlength: 100
  },
  pincode: { 
    type: String, 
    trim: true,
    maxlength: 10
  },
  city: { 
    type: String, 
    trim: true,
    maxlength: 100
  },
  state: { 
    type: String, 
    trim: true,
    maxlength: 100
  },
  website: { 
    type: String,
    trim: true,
    maxlength: 200
  },
  pancard: { 
    type: String,
    trim: true,
    maxlength: 10,
    uppercase: true
  },
  gst: { 
    type: String,
    trim: true,
    maxlength: 15,
    uppercase: true
  },
  annualTurnover: { 
    type: String,
    trim: true,
    maxlength: 50
  },
  isProfileCompleted: { 
    type: Boolean, 
    default: false, 
    required: true 
  },
}, { 
  timestamps: true
});

// Pre-save middleware to ensure either clientId or humanAgentId is provided and unique
ProfileSchema.pre('save', async function(next) {
  if (this.isNew) {
    // Ensure either clientId or humanAgentId is provided
    if (!this.clientId && !this.humanAgentId) {
      const error = new Error('Either clientId or humanAgentId is required');
      error.name = 'ValidationError';
      return next(error);
    }
    
    // Check for existing profile with same clientId or humanAgentId
    const query = this.clientId ? { clientId: this.clientId } : { humanAgentId: this.humanAgentId };
    const existingProfile = await this.constructor.findOne(query);
    if (existingProfile) {
      const error = new Error(`Profile already exists for this ${this.clientId ? 'client' : 'human agent'}`);
      error.name = 'DuplicateProfileError';
      return next(error);
    }
  }
  next();
});

module.exports = mongoose.model('Profile', ProfileSchema); 