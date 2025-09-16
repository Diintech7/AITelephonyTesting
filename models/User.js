const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema({
  // Client Information
  clientId: { 
    type: String, 
    required: true, 
    index: true 
  },

  // User Information
  name: {
    type: String,
    default: null
  },
  mobileNumber: {
    type: String,
    default: null
  },
  email: {
    type: String,
    default: null
  },

  // User Status
  isRegistered: {
    type: Boolean,
    default: false
  },
  registrationAttempts: {
    type: Number,
    default: 0
  },
  lastRegistrationPrompt: {
    type: Date,
    default: null
  },

  // Session Information
  sessionId: {
    type: String,
    required: true,
    unique: true
  },
  lastActive: {
    type: Date,
    default: Date.now
  },

  // Chat History
  conversations: [{
    agentId: {
      type: String,
      required: true
    },
    agentName: {
      type: String,
      required: true
    },
    messages: [{
      role: {
        type: String,
        enum: ['user', 'assistant', 'system'],
        required: true
      },
      content: {
        type: String,
        required: true
      },
      timestamp: {
        type: Date,
        default: Date.now
      },
      audioChunk: {
        type: String, // base64 audio data
        default: null
      }
    }],
    startedAt: {
      type: Date,
      default: Date.now
    },
    lastMessageAt: {
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

// Update the updatedAt field before saving
UserSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

// Method to add a message to conversation
UserSchema.methods.addMessage = function(agentId, agentName, role, content, audioChunk = null) {
  let conversation = this.conversations.find(conv => conv.agentId === agentId);
  
  if (!conversation) {
    conversation = {
      agentId,
      agentName,
      messages: [],
      startedAt: new Date(),
      lastMessageAt: new Date()
    };
    this.conversations.push(conversation);
  }

  conversation.messages.push({
    role,
    content,
    timestamp: new Date(),
    audioChunk
  });
  
  conversation.lastMessageAt = new Date();
  this.lastActive = new Date();
  
  return this.save();
};

// Method to get conversation history for an agent
UserSchema.methods.getConversationHistory = function(agentId, limit = 10) {
  const conversation = this.conversations.find(conv => conv.agentId === agentId);
  if (!conversation) return [];
  
  return conversation.messages.slice(-limit);
};

// Method to update user registration
UserSchema.methods.updateRegistration = function(name, mobileNumber, email = null) {
  this.name = name;
  this.mobileNumber = mobileNumber;
  this.email = email;
  this.isRegistered = true;
  this.registrationAttempts = 0;
  this.lastRegistrationPrompt = null;
  
  return this.save();
};

// Method to increment registration attempts
UserSchema.methods.incrementRegistrationAttempts = function() {
  this.registrationAttempts += 1;
  this.lastRegistrationPrompt = new Date();
  return this.save();
};

// Method to check if user should be prompted for registration
UserSchema.methods.shouldPromptForRegistration = function() {
  if (this.isRegistered) return false;
  
  // Prompt after 2 conversations if not registered
  const totalMessages = this.conversations.reduce((total, conv) => total + conv.messages.length, 0);
  
  if (totalMessages >= 4 && this.registrationAttempts < 2) {
    return true;
  }
  
  return false;
};

module.exports = mongoose.model("User", UserSchema);
