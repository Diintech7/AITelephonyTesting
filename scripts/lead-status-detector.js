const { generateText } = require("ai")
const { openai } = require("@ai-sdk/openai")

/**
 * Analyzes conversation transcript to determine lead status using AI
 * @param {string} transcript - Full conversation transcript
 * @param {string} agentConfig - Agent configuration for context
 * @returns {Promise<string>} - Lead status from the enum
 */
async function detectLeadStatusFromTranscript(transcript, agentConfig = null) {
  try {
    if (!transcript || transcript.trim().length === 0) {
      console.log("📊 [LEAD-STATUS] Empty transcript, defaulting to not_connected")
      return "not_connected"
    }

    const systemPrompt = `You are an expert lead qualification analyst. Analyze the conversation transcript and determine the lead status based on the customer's responses and engagement level.

Available lead statuses:
- CONNECTED - INTERESTED:
  * "vvi" - very very interested (customer shows strong buying intent, asks for pricing, wants to proceed immediately)
  * "maybe" - maybe (customer shows some interest but needs more information or time to decide)
  * "enrolled" - enrolled (customer has completed enrollment/purchase process)

- CONNECTED - NOT INTERESTED:
  * "junk_lead" - junk lead (wrong person, spam, or completely irrelevant)
  * "not_required" - not required (customer doesn't need the product/service)
  * "enrolled_other" - enrolled other (customer already has similar service elsewhere)
  * "decline" - decline (customer explicitly refuses or declines the offer)
  * "not_eligible" - not eligible (customer doesn't meet criteria for the service)
  * "wrong_number" - wrong number (reached wrong person or number)

- CONNECTED - FOLLOWUP:
  * "hot_followup" - hot followup (interested customer who wants to be contacted again soon)
  * "cold_followup" - cold followup (lukewarm interest, follow up later)
  * "schedule" - schedule (customer wants to schedule a specific time for next contact)

- NOT CONNECTED:
  * "not_connected" - not connected (call didn't connect properly or no meaningful conversation)

Analyze the conversation for:
1. Customer engagement level
2. Buying signals or objections
3. Explicit statements about interest/disinterest
4. Requests for information or next steps
5. Completion of any enrollment process

Return ONLY the lead status code (e.g., "vvi", "maybe", "decline", etc.). No explanation needed.`

    const userPrompt = `Analyze this conversation transcript and determine the lead status:

TRANSCRIPT:
${transcript}

${agentConfig ? `AGENT CONTEXT: ${agentConfig.description || agentConfig.agentName}` : ""}

Lead Status:`

    console.log("🤖 [LEAD-STATUS] Analyzing transcript with AI...")

    const { text } = await generateText({
      model: openai("gpt-4o-mini"),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      maxTokens: 20,
      temperature: 0.1,
    })

    const detectedStatus = text.trim().toLowerCase()

    // Validate the detected status against allowed enum values
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

    if (validStatuses.includes(detectedStatus)) {
      console.log(`✅ [LEAD-STATUS] Detected: "${detectedStatus}" from transcript analysis`)
      return detectedStatus
    } else {
      console.log(`⚠️ [LEAD-STATUS] Invalid status "${detectedStatus}", defaulting to "maybe"`)
      return "maybe"
    }
  } catch (error) {
    console.error(`❌ [LEAD-STATUS] Analysis error: ${error.message}`)
    return "maybe" // Default fallback
  }
}

module.exports = { detectLeadStatusFromTranscript }
