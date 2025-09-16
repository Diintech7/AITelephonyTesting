const mongoose = require('mongoose');

const BusinessSchema = new mongoose.Schema({
    clientId:{
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Client', 
        required: true
    },
    title: {
      type: String,
      required: true,
      trim: true
    },
    category: {
      type: String,
      required: true,
      trim: true
    },
    type: {
      type: String,
      enum: ['product', 'service'],
      required: true
    },
    image: {
      url:{
        type: String,
        required: true
      },
      key:{
        type: String,
      }
    },

    documents: {
      url:{
        type: String,
        default: null
      },
      key:{
        type: String,
      }
    },
    videoLink: {
      type: String,
      default: null,
      validate: {
        validator: function(v) {
          if (!v) return true;
          return /^https?:\/\/.+/.test(v);
        },
        message: 'Video link must be a valid URL'
      }
    },
    link:{
        type: String,
        default: null,
        validate: {
            validator: function(v) {
              if (!v) return true;
              return /^https?:\/\/.+/.test(v);
            },
            message: 'link must be a valid URL'
          }
    },
    Sharelink:{
        type: String,
        default: null,
        validate: {
            validator: function(v) {
              if (!v) return true;
              return /^https?:\/\/.+/.test(v);
            },
            message: 'link must be a valid URL'
          }
    },
    description: {
      type: String,
      required: true
    },
    mrp: {
      type: Number,
      min: 0,
      default: 0
    },
    offerPrice: {
      type: Number,
      min: 0,
      default: null
    },
    createdAt: {
      type: Date,
      default: Date.now
    },
    updatedAt: {
      type: Date,
      default: Date.now
    },
    hash: {
      type: String,
      unique: true,
      sparse: true
    },
});

module.exports = mongoose.model('Business', BusinessSchema);