const mongoose = require("mongoose")
const CallLog = require("../models/CallLog")

// Enhanced Call Logger with AI-powered lead status determination
class EnhancedCallLogger {
  constructor(clientId, mobile = null, callDirection = "inbound", campaignId = null, agentId = null) {
    this.clientId = clientId
    this.mobile = mobile
    this.callDirection = callDirection
    this.campaignId = campaignId
    this.agentId = agentId
    this.callStartTime = new Date()
    this.transcripts = []
    this.responses = []
    this.totalDuration = 0
    this.audioUrl = null
    this.isCallActive = true
    this.saveAttempts = 0
    this.maxSaveAttempts = 3

    // Background save queue
    this.pendingSaves = []
    this.saveInProgress = false

    console.log(`📝 [ENHANCED-LOGGER] Initialized for client: ${clientId}, direction: ${callDirection}`)
  }

  // Log user transcript with timestamp
  logUserTranscript(transcript, language, timestamp = new Date()) {
    if (!transcript?.trim()) return

    const entry = {
      type: "user",
      text: transcript.trim(),
      language: language || "unknown",
      timestamp: timestamp,
      source: "deepgram",
    }

    this.transcripts.push(entry)
    console.log(`📝 [USER-LOG] "${transcript}" (${language})`)

    // Trigger background save for real-time backup
    this.scheduleBackgroundSave()
  }

  // Log AI response with timestamp
  logAIResponse(response, language, timestamp = new Date()) {
    if (!response?.trim()) return

    const entry = {
      type: "ai",
      text: response.trim(),
      language: language || "unknown",
      timestamp: timestamp,
      source: "sarvam",
    }

    this.responses.push(entry)
    console.log(`🤖 [AI-LOG] "${response}" (${language})`)

    // Trigger background save for real-time backup
    this.scheduleBackgroundSave()
  }

  // Generate chronological transcript
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

  // Analyze conversation to determine lead status using OpenAI
  async determineLeadStatus(openaiApiKey) {
    try {
      const fullTranscript = this.generateFullTranscript()

      if (!fullTranscript.trim()) {
        console.log(`⚠️ [LEAD-STATUS] No transcript available, defaulting to 'not_connected'`)
        return "not_connected"
      }

      console.log(`🧠 [LEAD-STATUS] Analyzing conversation for lead status...`)

      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openaiApiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `You are an expert call analyst. Analyze the conversation and determine the lead status based on the customer's response and engagement level.

LEAD STATUS OPTIONS:
Connected - Interested:
- vvi: Very very interested (strong buying signals, ready to purchase)
- maybe: Maybe interested (some interest but uncertain)
- enrolled: Already enrolled/purchased

Connected - Not Interested:
- junk_lead: Junk lead (not a real prospect)
- not_required: Not required (doesn't need the product/service)
- enrolled_other: Enrolled with competitor
- decline: Declined the offer
- not_eligible: Not eligible for the offer
- wrong_number: Wrong number contacted

Connected - Followup:
- hot_followup: Hot followup (interested but needs time/info)
- cold_followup: Cold followup (mild interest, long-term prospect)
- schedule: Wants to schedule a callback/meeting

Not Connected:
- not_connected: Call not connected or no meaningful conversation

Analyze the conversation and return ONLY the appropriate status code. Consider:
- Customer's level of interest and engagement
- Buying signals or objections
- Request for more information or callbacks
- Explicit yes/no responses
- Quality of the conversation`,
            },
            {
              role: "user",
              content: `Analyze this call transcript and determine the lead status:\n\n${fullTranscript}`,
            },
          ],
          max_tokens: 20,
          temperature: 0.1,
        }),
      })

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status}`)
      }

      const data = await response.json()
      const leadStatus = data.choices[0]?.message?.content?.trim().toLowerCase()

      // Validate the lead status
      const validStatuses = [
        "vvi",
        "maybe",
        "enrolled",
        "junk_lead",
        "not_required",
        "enrolled_other",
        "decline",
        "not_eligible",
        "wrong_number",
        "hot_followup",
        "cold_followup",
        "schedule",
        "not_connected",
      ]

      if (validStatuses.includes(leadStatus)) {
        console.log(`✅ [LEAD-STATUS] Determined: "${leadStatus}"`)
        return leadStatus
      } else {
        console.log(`⚠️ [LEAD-STATUS] Invalid status "${leadStatus}", defaulting to 'maybe'`)
        return "maybe"
      }
    } catch (error) {
      console.error(`❌ [LEAD-STATUS] Analysis failed: ${error.message}`)
      return "maybe" // Default fallback
    }
  }

  // Schedule background save to avoid blocking call processing
  scheduleBackgroundSave() {
    if (this.saveInProgress) return

    // Debounce saves - only save every 10 seconds during active call
    clearTimeout(this.backgroundSaveTimer)
    this.backgroundSaveTimer = setTimeout(() => {
      this.performBackgroundSave()
    }, 10000)
  }

  // Perform background save without blocking
  async performBackgroundSave() {
    if (this.saveInProgress) return

    this.saveInProgress = true

    try {
      const callLogData = this.prepareCallLogData("maybe") // Temporary status during call

      // Use upsert to update existing record or create new one
      const filter = {
        clientId: this.clientId,
        mobile: this.mobile,
        time: this.callStartTime,
      }

      const update = {
        $set: {
          ...callLogData,
          lastUpdated: new Date(),
          isActive: this.isCallActive,
        },
      }

      const options = { upsert: true, new: true }

      await CallLog.findOneAndUpdate(filter, update, options)
      console.log(`💾 [BACKGROUND-SAVE] Call log updated in background`)
    } catch (error) {
      console.error(`❌ [BACKGROUND-SAVE] Failed: ${error.message}`)
    } finally {
      this.saveInProgress = false
    }
  }

  // Prepare call log data
  prepareCallLogData(leadStatus = "maybe") {
    const callEndTime = new Date()
    this.totalDuration = Math.round((callEndTime - this.callStartTime) / 1000)

    return {
      clientId: this.clientId,
      campaignId: this.campaignId,
      agentId: this.agentId,
      mobile: this.mobile,
      time: this.callStartTime,
      transcript: this.generateFullTranscript(),
      audioUrl: this.audioUrl,
      duration: this.totalDuration,
      leadStatus: leadStatus,
      metadata: {
        userTranscriptCount: this.transcripts.length,
        aiResponseCount: this.responses.length,
        languages: [...new Set([...this.transcripts, ...this.responses].map((entry) => entry.language))],
        callEndTime: callEndTime,
        callDirection: this.callDirection,
        saveAttempts: this.saveAttempts,
        lastSaveAttempt: new Date(),
      },
    }
  }

  // Final save with AI-determined lead status
  async saveToDatabase(openaiApiKey, forceLeadStatus = null) {
    this.isCallActive = false

    try {
      // Clear any pending background saves
      clearTimeout(this.backgroundSaveTimer)

      // Determine lead status using AI if not forced
      let leadStatus = forceLeadStatus
      if (!leadStatus) {
        leadStatus = await this.determineLeadStatus(openaiApiKey)
      }

      const callLogData = this.prepareCallLogData(leadStatus)

      // Try to update existing record first, then create new if not found
      const filter = {
        clientId: this.clientId,
        mobile: this.mobile,
        time: this.callStartTime,
      }

      let savedLog = await CallLog.findOneAndUpdate(
        filter,
        { $set: { ...callLogData, isActive: false, finalSave: true } },
        { new: true },
      )

      if (!savedLog) {
        // Create new record if update didn't find existing one
        const callLog = new CallLog({ ...callLogData, isActive: false, finalSave: true })
        savedLog = await callLog.save()
      }

      console.log(
        `💾 [FINAL-SAVE] Completed - ID: ${savedLog._id}, Status: ${leadStatus}, Duration: ${this.totalDuration}s`,
      )
      console.log(
        `📊 [CALL-STATS] User: ${this.transcripts.length}, AI: ${this.responses.length}, Direction: ${this.callDirection}`,
      )

      return savedLog
    } catch (error) {
      console.error(`❌ [FINAL-SAVE] Failed: ${error.message}`)

      // Retry mechanism
      this.saveAttempts++
      if (this.saveAttempts < this.maxSaveAttempts) {
        console.log(`🔄 [RETRY-SAVE] Attempt ${this.saveAttempts + 1}/${this.maxSaveAttempts}`)
        setTimeout(() => {
          this.saveToDatabase(openaiApiKey, forceLeadStatus)
        }, 2000 * this.saveAttempts) // Exponential backoff
      } else {
        console.error(`❌ [SAVE-FAILED] Max attempts reached, call log may be lost`)
        // Could implement additional fallback mechanisms here (file system, queue, etc.)
      }

      throw error
    }
  }

  // Emergency save for sudden disconnections
  async emergencySave(openaiApiKey) {
    console.log(`🚨 [EMERGENCY-SAVE] Attempting emergency save...`)

    try {
      // Quick save with minimal processing
      const leadStatus = this.transcripts.length > 0 ? "maybe" : "not_connected"
      const callLogData = this.prepareCallLogData(leadStatus)

      const callLog = new CallLog({
        ...callLogData,
        isActive: false,
        emergencySave: true,
        metadata: {
          ...callLogData.metadata,
          emergencySave: true,
          emergencySaveTime: new Date(),
        },
      })

      const savedLog = await callLog.save()
      console.log(`🚨 [EMERGENCY-SAVE] Success - ID: ${savedLog._id}`)

      // Try to update with AI analysis in background (non-blocking)
      setImmediate(async () => {
        try {
          const aiLeadStatus = await this.determineLeadStatus(openaiApiKey)
          await CallLog.findByIdAndUpdate(savedLog._id, {
            leadStatus: aiLeadStatus,
            "metadata.aiAnalysisCompleted": true,
            "metadata.aiAnalysisTime": new Date(),
          })
          console.log(`🧠 [EMERGENCY-AI] Updated lead status to: ${aiLeadStatus}`)
        } catch (aiError) {
          console.error(`❌ [EMERGENCY-AI] Failed: ${aiError.message}`)
        }
      })

      return savedLog
    } catch (error) {
      console.error(`❌ [EMERGENCY-SAVE] Failed: ${error.message}`)
      throw error
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
      isActive: this.isCallActive,
      saveAttempts: this.saveAttempts,
    }
  }

  // Cleanup method
  cleanup() {
    clearTimeout(this.backgroundSaveTimer)
    this.isCallActive = false
    console.log(`🧹 [CLEANUP] Call logger cleaned up`)
  }
}

module.exports = { EnhancedCallLogger }
