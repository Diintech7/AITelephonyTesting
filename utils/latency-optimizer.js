class LatencyOptimizer {
    constructor() {
      this.metrics = {
        audioProcessing: [],
        speechToText: [],
        aiResponse: [],
        textToSpeech: [],
        totalRoundTrip: [],
      }
      this.maxMetrics = 100 // Keep last 100 measurements
    }
  
    // Start timing a process
    startTimer(processName) {
      return {
        processName,
        startTime: process.hrtime.bigint(),
      }
    }
  
    // End timing and record metric
    endTimer(timer) {
      const endTime = process.hrtime.bigint()
      const latencyNs = endTime - timer.startTime
      const latencyMs = Number(latencyNs) / 1000000 // Convert to milliseconds
  
      this.recordMetric(timer.processName, latencyMs)
      return latencyMs
    }
  
    // Record a latency metric
    recordMetric(processName, latencyMs) {
      if (!this.metrics[processName]) {
        this.metrics[processName] = []
      }
  
      this.metrics[processName].push({
        latency: latencyMs,
        timestamp: Date.now(),
      })
  
      // Keep only recent metrics
      if (this.metrics[processName].length > this.maxMetrics) {
        this.metrics[processName].shift()
      }
  
      // Log if latency is high
      if (latencyMs > 200) {
        console.warn(`⚠️ [LATENCY] High latency detected in ${processName}: ${latencyMs.toFixed(2)}ms`)
      }
    }
  
    // Get latency statistics
    getStats(processName = null) {
      if (processName) {
        return this.calculateStats(this.metrics[processName] || [])
      }
  
      const stats = {}
      for (const [name, metrics] of Object.entries(this.metrics)) {
        stats[name] = this.calculateStats(metrics)
      }
      return stats
    }
  
    // Calculate statistics for a metric array
    calculateStats(metrics) {
      if (metrics.length === 0) {
        return {
          count: 0,
          average: 0,
          min: 0,
          max: 0,
          p95: 0,
          p99: 0,
        }
      }
  
      const latencies = metrics.map((m) => m.latency).sort((a, b) => a - b)
      const count = latencies.length
      const sum = latencies.reduce((a, b) => a + b, 0)
  
      return {
        count,
        average: sum / count,
        min: latencies[0],
        max: latencies[count - 1],
        p95: latencies[Math.floor(count * 0.95)] || 0,
        p99: latencies[Math.floor(count * 0.99)] || 0,
      }
    }
  
    // Get optimization recommendations
    getOptimizationRecommendations() {
      const stats = this.getStats()
      const recommendations = []
  
      // Check audio processing latency
      if (stats.audioProcessing?.average > 50) {
        recommendations.push({
          component: "audioProcessing",
          issue: "High audio processing latency",
          recommendation: "Consider reducing buffer size or optimizing audio filters",
          currentAvg: stats.audioProcessing.average,
        })
      }
  
      // Check speech-to-text latency
      if (stats.speechToText?.average > 100) {
        recommendations.push({
          component: "speechToText",
          issue: "High speech-to-text latency",
          recommendation: "Consider using streaming mode or optimizing Deepgram settings",
          currentAvg: stats.speechToText.average,
        })
      }
  
      // Check AI response latency
      if (stats.aiResponse?.average > 200) {
        recommendations.push({
          component: "aiResponse",
          issue: "High AI response latency",
          recommendation: "Consider using faster model or reducing max_tokens",
          currentAvg: stats.aiResponse.average,
        })
      }
  
      // Check text-to-speech latency
      if (stats.textToSpeech?.average > 150) {
        recommendations.push({
          component: "textToSpeech",
          issue: "High text-to-speech latency",
          recommendation: "Consider optimizing Sarvam settings or using streaming TTS",
          currentAvg: stats.textToSpeech.average,
        })
      }
  
      // Check total round-trip latency
      if (stats.totalRoundTrip?.average > 500) {
        recommendations.push({
          component: "totalRoundTrip",
          issue: "High total conversation latency",
          recommendation: "Overall optimization needed across all components",
          currentAvg: stats.totalRoundTrip.average,
        })
      }
  
      return recommendations
    }
  
    // Reset all metrics
    reset() {
      for (const key of Object.keys(this.metrics)) {
        this.metrics[key] = []
      }
      console.log("📊 [LATENCY] Metrics reset")
    }
  
    // Get current performance grade
    getPerformanceGrade() {
      const stats = this.getStats()
      const totalAvg = stats.totalRoundTrip?.average || 0
  
      if (totalAvg < 200) return "A+"
      if (totalAvg < 300) return "A"
      if (totalAvg < 400) return "B"
      if (totalAvg < 500) return "C"
      return "D"
    }
  }
  
  module.exports = LatencyOptimizer
  