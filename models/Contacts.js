const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema({
    name:{
        type: String,
        require: true,
        trim: true
    },
    countyCode:{
        type: String,
        trim: true
    },
    phone:{
        type:String,
        require: true,
        trim: true,
        unique: true // Ensure phone numbers are unique per client
    },
    email:{
        type:String,
        trim: true,
        lowercase: true
    },
    clientId:{
        type: String,
        require: true,
        index: true
    },
    createdAt:{
        type: Date,
        default: Date.now
    },
    updatedAt:{
        type: Date,
        default: Date.now
    }
});

// Update the updatedAt field before saving
contactSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

// Create compound index for clientId and phone to ensure uniqueness per client
contactSchema.index({ clientId: 1, phone: 1 }, { unique: true });

module.exports = mongoose.model('Contact', contactSchema);