const mongoose = require('mongoose');
const AgentSettingsSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  agentName: String,
  voice: String,
  didNumber: String,
  firstMessage: String,
  knowledgeText: String
});
module.exports = mongoose.model('AgentSettings', AgentSettingsSchema); 