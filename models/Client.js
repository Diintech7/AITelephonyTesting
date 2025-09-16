const mongoose = require("mongoose");

const ClientSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, "Name is required"],
  },
  email: {
    type: String,
    required: [true, "Email is required"],
    unique: true,
  },
  password: {
    type: String,
    required: function () {
      // Password is required only if not using Google auth
      return !this.googleId;
    },
  },
  businessName: {
    type: String,
    required: function () {
      // Password is required only if not using Google auth
      return !this.googleId;
    },
  },
  businessLogoKey: {
    type: String,
    required: function () {
      // Password is required only if not using Google auth
      return !this.googleId;
    },
  },
  businessLogoUrl: {
    type: String,
    required: function () {
      // Password is required only if not using Google auth
      return !this.googleId;
    },
  },
  gstNo: {
    type: String,
    required: function () {
      return !this.googleId;
    },
    unique: true,
    sparse: true,
  },
  panNo: {
    type: String,
    required: function () {
      return !this.googleId;
    },
    unique: true,
    sparse: true,
  },
  mobileNo: {
    type: String,
    required: function () {
      // Password is required only if not using Google auth
      return !this.googleId;
    },
    unique: true,
    sparse: true
  },
  address: {
    type: String,
    required: function () {
      // Password is required only if not using Google auth
      return !this.googleId;
    },
  },
  city: {
    type: String,
    required: function () {
      // Password is required only if not using Google auth
      return !this.googleId;
    },
  },
  pincode: {
    type: String,
    required: function () {
      // Password is required only if not using Google auth
      return !this.googleId;
    },
  },
  websiteUrl: {
    type: String,
  },
  // Auto-generated user ID for clients
  userId: {
    type: String,
    unique: true,
    sparse: true, // Only unique if not null
  },
  //goole user data
  isGoogleUser: {
    type: Boolean,
    default: false,
  },
  googleId: {
    type: String,
  },
  googlePicture: {
    type: String,
  },
  emailVerified: {
    type: Boolean,
    default: false,
  },
  isprofileCompleted: {
    type: Boolean,
    default: false,
  },
  isApproved:{
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Generate unique user ID for clients
ClientSchema.pre("save", async function (next) {
  // Generate user ID for new clients
  if (this.isNew && !this.userId) {
    try {
      let userId;
      let isUnique = false;
      let attempts = 0;
      const maxAttempts = 10;

      while (!isUnique && attempts < maxAttempts) {
        // Generate a more unique ID: CLI + timestamp + random string
        const timestamp = Date.now().toString().slice(-6); // Last 6 digits of timestamp
        const randomString = Math.random()
          .toString(36)
          .substr(2, 4)
          .toUpperCase();
        userId = `CLI${timestamp}${randomString}`;

        // Check if this ID already exists
        const existingUser = await this.constructor.findOne({ userId });
        if (!existingUser) {
          isUnique = true;
        }
        attempts++;
      }

      if (!isUnique) {
        // Fallback to a more random approach if needed
        userId = `CLI${Date.now()}${Math.floor(Math.random() * 1000)}`;
      }

      this.userId = userId;
    } catch (error) {
      console.error("Error generating user ID:", error);
      return next(error);
    }
  }

  next();
});

// Method to generate a new user ID (if needed)
ClientSchema.methods.generateUserId = async function () {
  if (this.userId) {
    return this.userId;
  }

  let userId;
  let isUnique = false;
  let attempts = 0;
  const maxAttempts = 10;

  while (!isUnique && attempts < maxAttempts) {
    const timestamp = Date.now().toString().slice(-6);
    const randomString = Math.random().toString(36).substr(2, 4).toUpperCase();
    userId = `CLI${timestamp}${randomString}`;

    const existingUser = await this.constructor.findOne({ userId });
    if (!existingUser) {
      isUnique = true;
    }
    attempts++;
  }

  if (!isUnique) {
    userId = `CLI${Date.now()}${Math.floor(Math.random() * 1000)}`;
  }

  this.userId = userId;
  await this.save();
  return userId;
};

module.exports = mongoose.model("Client", ClientSchema);
