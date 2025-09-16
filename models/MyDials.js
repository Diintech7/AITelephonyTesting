const mongoose = require("mongoose");

const MyDialSchema = new mongoose.Schema({
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Client",
    required: true,
  },
  category:{
    type: String,
    require: true,
  },
  leadStatus:{
    type: String,
    required: true
  },
  other:{
    type: String,
  },
  phoneNumber:{
    type: String,
    require: true
  },
  contactName:{
    type: String,
    require: true
  },
  date:{
    type: String,
  }
},{
    timestamps: true
});

module.exports = mongoose.model("MyDial", MyDialSchema);