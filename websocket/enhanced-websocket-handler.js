const WebSocket = require("ws")
require("dotenv").config()
const mongoose = require("mongoose")
const Agent = require("../models/Agent")
const CallLog = require("../models/CallLog")
const { detectLeadStatusFromTranscript } = require("../scripts/lead-status-detector")

// Enhanced CallLogger class with automatic lead status detection
class EnhancedCallLogger {
  constructor(clientId, mobile = null, callDirection = "inbound", agentConfig = null) {
    this.clientId = clientId
    this.mobile = mobile
    this.callDirection = callDirection
    this.agentConfig = agentConfig
    this.callStartTime = new Date()
    this.transcripts = []
    this.responses = []
    this.totalDuration = 0
    this.leadStatus = null // Will be determined automatically
  }

  // Log user transcript from Deepgram
  logUserTranscript(transcript, language, timestamp = new Date()) {
    const entry = {
      type: "user",
      text: transcript,
      language: language,
      timestamp: timestamp,
      source: "deepgram",
    }

    this.transcripts.push(entry)
    console.log(`📝 [CALL-LOG] User: "${transcript}" (${language})`)
  }

  // Log AI response from Sarvam
  logAIResponse(response, language, timestamp = new Date()) {
    const entry = {
      type: "ai",
      text: response,
      language: language,
      timestamp: timestamp,
      source: "sarvam",
    }

    this.responses.push(entry)
    console.log(`🤖 [CALL-LOG] AI: "${response}" (${language})`)
  }

  // Generate full transcript combining user and AI messages
  generateFullTranscript() {
    const allEntries = [...this.transcripts, ...this.responses].sort(
      (a, b) => new Date(a.timestamp) - new Date(b.timestamp),
    )

    return allEntries
      .map((entry) => {
        const speaker = entry.type === "user" ? "User" : "AI"
        const time = entry.timestamp.toISOString()
        return `[${time}] ${speaker} (${entry.language}): ${entry.text}`
      })
      .join("\n")
  }

  // Enhanced save method with automatic lead status detection
  async saveToDatabase(fallbackLeadStatus = "maybe") {
    try {
      const callEndTime = new Date()
      this.totalDuration = Math.round((callEndTime - this.callStartTime) / 1000)

      // Generate full transcript
      const fullTranscript = this.generateFullTranscript()

      // Automatically detect lead status from transcript
      console.log("🔍 [LEAD-STATUS] Starting automatic detection...")
      const detectedLeadStatus = await detectLeadStatusFromTranscript(fullTranscript, this.agentConfig)

      // Use detected status or fallback
      const finalLeadStatus = detectedLeadStatus || fallbackLeadStatus

      console.log(
        `📊 [LEAD-STATUS] Final status: "${finalLeadStatus}" (detected: ${detectedLeadStatus ? "Yes" : "No"})`,
      )

      const callLogData = {
        clientId: this.clientId,
        mobile: this.mobile,
        time: this.callStartTime,
        transcript: fullTranscript,
        duration: this.totalDuration,
        leadStatus: finalLeadStatus, // Use AI-detected status
        // Additional metadata
        metadata: {
          userTranscriptCount: this.transcripts.length,
          aiResponseCount: this.responses.length,
          languages: [...new Set([...this.transcripts, ...this.responses].map((entry) => entry.language))],
          callEndTime: callEndTime,
          callDirection: this.callDirection,
          leadStatusDetectedBy: detectedLeadStatus ? "AI" : "fallback",
          agentName: this.agentConfig?.agentName || "unknown",
        },
      }

      // Add agent and campaign IDs if available
      if (this.agentConfig?._id) {
        callLogData.agentId = this.agentConfig._id
      }

      const callLog = new CallLog(callLogData)
      const savedLog = await callLog.save()

      console.log(
        `💾 [CALL-LOG] Saved with AI-detected status - ID: ${savedLog._id}, Status: "${finalLeadStatus}", Duration: ${this.totalDuration}s`,
      )
      console.log(
        `📊 [CALL-LOG] Stats - User: ${this.transcripts.length}, AI: ${this.responses.length}, Direction: ${this.callDirection}`,
      )

      return savedLog
    } catch (error) {
      console.error(`❌ [CALL-LOG] Database save error: ${error.message}`)

      // Try to save with minimal data if main save fails
      try {
        const emergencyCallLog = new CallLog({
          clientId: this.clientId,
          mobile: this.mobile,
          time: this.callStartTime,
          transcript: this.generateFullTranscript(),
          duration: this.totalDuration,
          leadStatus: fallbackLeadStatus, // Use fallback on error
        })

        const emergencySave = await emergencyCallLog.save()
        console.log(`🚨 [CALL-LOG] Emergency save successful - ID: ${emergencySave._id}`)
        return emergencySave
      } catch (emergencyError) {
        console.error(`❌ [CALL-LOG] Emergency save also failed: ${emergencyError.message}`)
        throw error
      }
    }
  }

  // Get call statistics
  getStats() {
    return {
      duration: this.totalDuration,
      userMessages: this.transcripts.length,
      aiResponses: this.responses.length,
      languages: [...new Set([...this.transcripts, ...this.responses].map((entry) => entry.language))],
      startTime: this.callStartTime,
      callDirection: this.callDirection,
      leadStatus: this.leadStatus,
    }
  }
}

// Enhanced WebSocket close handler
const enhancedWebSocketCloseHandler = async (ws, callLogger, callDirection) => {
  console.log(`🔗 [ENHANCED] Connection closing - Direction: ${callDirection}`)

  // Always save call log with AI-detected lead status on disconnection
  if (callLogger) {
    try {
      console.log("🎯 [DISCONNECT] Analyzing conversation for lead status...")

      // Save with automatic lead status detection
      const savedLog = await callLogger.saveToDatabase("not_connected")

      console.log(`✅ [DISCONNECT] Call log saved successfully:`)
      console.log(`   - ID: ${savedLog._id}`)
      console.log(`   - Lead Status: "${savedLog.leadStatus}"`)
      console.log(`   - Duration: ${savedLog.duration}s`)
      console.log(`   - Direction: ${callDirection}`)
      console.log(`   - Transcript Length: ${savedLog.transcript.length} chars`)

      // Log final statistics
      const stats = callLogger.getStats()
      console.log(
        `📈 [FINAL-STATS] User: ${stats.userMessages}, AI: ${stats.aiResponses}, Languages: ${stats.languages.join(", ")}`,
      )
    } catch (error) {
      console.error(`❌ [DISCONNECT] Failed to save call log: ${error.message}`)

      // Last resort: try to save basic info
      try {
        const basicCallLog = new CallLog({
          clientId: callLogger.clientId,
          mobile: callLogger.mobile,
          time: callLogger.callStartTime,
          transcript: "Error saving full transcript",
          duration: Math.round((new Date() - callLogger.callStartTime) / 1000),
          leadStatus: "not_connected",
        })

        await basicCallLog.save()
        console.log("🚨 [DISCONNECT] Basic call log saved as fallback")
      } catch (finalError) {
        console.error(`❌ [DISCONNECT] All save attempts failed: ${finalError.message}`)
      }
    }
  } else {
    console.log("⚠️ [DISCONNECT] No call logger available to save")
  }
}

// Export the enhanced components
module.exports = {
  EnhancedCallLogger,
  enhancedWebSocketCloseHandler,
  detectLeadStatusFromTranscript,
}
