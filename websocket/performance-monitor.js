const EventEmitter = require('events');
const { performance } = require('perf_hooks');

/**
 * Performance Monitor for SanIPPBX WebSocket Server
 * Tracks latency, throughput, and system performance
 */
class PerformanceMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      enableRealTimeMonitoring: options.enableRealTimeMonitoring !== false,
      latencyThresholds: {
        excellent: 50,   // ms
        good: 100,       // ms
        acceptable: 200, // ms
        poor: 500       // ms
      },
      sampleWindow: options.sampleWindow || 1000, // ms
      alertThreshold: options.alertThreshold || 300, // ms
      ...options
    };
    
    // Performance metrics
    this.metrics = {
      audio: {
        packetsProcessed: 0,
        totalLatency: 0,
        avgLatency: 0,
        minLatency: Infinity,
        maxLatency: 0,
        latencyHistory: [],
        throughput: 0,
        errorCount: 0
      },
      ai: {
        transcriptionLatency: 0,
        ttsLatency: 0,
        conversationLatency: 0,
        totalRequests: 0,
        successRate: 0,
        errorCount: 0
      },
      network: {
        websocketLatency: 0,
        packetLoss: 0,
        bandwidth: 0,
        connectionQuality: 'unknown'
      },
      system: {
        cpuUsage: 0,
        memoryUsage: 0,
        eventLoopLag: 0,
        gcPause: 0
      }
    };
    
    // Start monitoring if enabled
    if (this.options.enableRealTimeMonitoring) {
      this.startRealTimeMonitoring();
    }
  }

  /**
   * Start real-time performance monitoring
   */
  startRealTimeMonitoring() {
    // Monitor event loop lag
    this.monitorEventLoopLag();
    
    // Monitor system resources
    this.monitorSystemResources();
    
    // Periodic cleanup and analysis
    this.analysisInterval = setInterval(() => {
      this.analyzePerformance();
      this.cleanupOldData();
    }, this.options.sampleWindow);
    
    console.log('📊 [PERF-MONITOR] Real-time performance monitoring started');
  }

  /**
   * Record audio processing latency
   */
  recordAudioLatency(startTime, endTime = performance.now()) {
    const latency = endTime - startTime;
    
    const audio = this.metrics.audio;
    audio.packetsProcessed++;
    audio.totalLatency += latency;
    audio.avgLatency = audio.totalLatency / audio.packetsProcessed;
    audio.minLatency = Math.min(audio.minLatency, latency);
    audio.maxLatency = Math.max(audio.maxLatency, latency);
    
    // Keep recent history for analysis
    audio.latencyHistory.push({
      latency,
      timestamp: Date.now()
    });
    
    // Limit history size
    if (audio.latencyHistory.length > 1000) {
      audio.latencyHistory.shift();
    }
    
    // Check for performance alerts
    this.checkLatencyAlert('audio', latency);
    
    return latency;
  }

  /**
   * Record AI service latency
   */
  recordAILatency(service, startTime, endTime = performance.now(), success = true) {
    const latency = endTime - startTime;
    const ai = this.metrics.ai;
    
    ai.totalRequests++;
    
    if (success) {
      switch (service) {
        case 'transcription':
          ai.transcriptionLatency = (ai.transcriptionLatency + latency) / 2;
          break;
        case 'tts':
          ai.ttsLatency = (ai.ttsLatency + latency) / 2;
          break;
        case 'conversation':
          ai.conversationLatency = (ai.conversationLatency + latency) / 2;
          break;
      }
      ai.successRate = ((ai.totalRequests - ai.errorCount) / ai.totalRequests) * 100;
    } else {
      ai.errorCount++;
      ai.successRate = ((ai.totalRequests - ai.errorCount) / ai.totalRequests) * 100;
    }
    
    this.checkLatencyAlert(service, latency);
    
    return latency;
  }

  /**
   * Record network performance metrics
   */
  recordNetworkMetrics(type, value) {
    const network = this.metrics.network;
    
    switch (type) {
      case 'websocket_latency':
        network.websocketLatency = value;
        break;
      case 'packet_loss':
        network.packetLoss = value;
        break;
      case 'bandwidth':
        network.bandwidth = value;
        break;
      case 'connection_quality':
        network.connectionQuality = value;
        break;
    }
  }

  /**
   * Monitor event loop lag (critical for real-time performance)
   */
  monitorEventLoopLag() {
    let start = performance.now();
    
    const measureLag = () => {
      const lag = performance.now() - start;
      this.metrics.system.eventLoopLag = lag;
      
      if (lag > 10) { // Alert if event loop lag > 10ms
        console.warn(`⚠️ [PERF-MONITOR] High event loop lag detected: ${lag.toFixed(2)}ms`);
      }
      
      start = performance.now();
      setImmediate(measureLag);
    };
    
    setImmediate(measureLag);
  }

  /**
   * Monitor system resource usage
   */
  monitorSystemResources() {
    const updateInterval = 5000; // 5 seconds
    
    const updateMetrics = () => {
      const usage = process.memoryUsage();
      const cpuUsage = process.cpuUsage();
      
      // Memory usage (in MB)
      this.metrics.system.memoryUsage = {
        rss: Math.round(usage.rss / 1024 / 1024),
        heapUsed: Math.round(usage.heapUsed / 1024 / 1024),
        heapTotal: Math.round(usage.heapTotal / 1024 / 1024),
        external: Math.round(usage.external / 1024 / 1024)
      };
      
      // CPU usage percentage (approximation)
      this.metrics.system.cpuUsage = {
        user: cpuUsage.user,
        system: cpuUsage.system
      };
    };
    
    updateMetrics();
    setInterval(updateMetrics, updateInterval);
  }

  /**
   * Analyze performance and emit warnings
   */
  analyzePerformance() {
    const audio = this.metrics.audio;
    const ai = this.metrics.ai;
    
    // Analyze audio performance
    if (audio.packetsProcessed > 0) {
      const recentLatencies = audio.latencyHistory
        .filter(item => Date.now() - item.timestamp < this.options.sampleWindow)
        .map(item => item.latency);
      
      if (recentLatencies.length > 0) {
        const avgRecentLatency = recentLatencies.reduce((a, b) => a + b, 0) / recentLatencies.length;
        const p95Latency = this.calculatePercentile(recentLatencies, 95);
        const p99Latency = this.calculatePercentile(recentLatencies, 99);
        
        audio.throughput = recentLatencies.length / (this.options.sampleWindow / 1000);
        
        // Emit performance analysis
        this.emit('performance-analysis', {
          type: 'audio',
          metrics: {
            avgLatency: avgRecentLatency,
            p95Latency,
            p99Latency,
            throughput: audio.throughput,
            quality: this.getPerformanceQuality(avgRecentLatency)
          }
        });
      }
    }
    
    // Analyze AI performance
    if (ai.totalRequests > 0) {
      const totalAILatency = ai.transcriptionLatency + ai.conversationLatency + ai.ttsLatency;
      
      this.emit('performance-analysis', {
        type: 'ai',
        metrics: {
          totalLatency: totalAILatency,
          transcriptionLatency: ai.transcriptionLatency,
          conversationLatency: ai.conversationLatency,
          ttsLatency: ai.ttsLatency,
          successRate: ai.successRate,
          quality: this.getPerformanceQuality(totalAILatency)
        }
      });
    }
  }

  /**
   * Check for latency alerts
   */
  checkLatencyAlert(type, latency) {
    if (latency > this.options.alertThreshold) {
      const alert = {
        type: 'latency_alert',
        service: type,
        latency: latency,
        threshold: this.options.alertThreshold,
        severity: this.getAlertSeverity(latency),
        timestamp: new Date().toISOString()
      };
      
      console.warn(`🚨 [PERF-ALERT] ${alert.severity.toUpperCase()} latency in ${type}: ${latency.toFixed(2)}ms`);
      this.emit('alert', alert);
    }
  }

  /**
   * Get alert severity based on latency
   */
  getAlertSeverity(latency) {
    const thresholds = this.options.latencyThresholds;
    
    if (latency <= thresholds.excellent) return 'info';
    if (latency <= thresholds.good) return 'low';
    if (latency <= thresholds.acceptable) return 'medium';
    if (latency <= thresholds.poor) return 'high';
    return 'critical';
  }

  /**
   * Get performance quality rating
   */
  getPerformanceQuality(avgLatency) {
    const thresholds = this.options.latencyThresholds;
    
    if (avgLatency <= thresholds.excellent) return 'excellent';
    if (avgLatency <= thresholds.good) return 'good';
    if (avgLatency <= thresholds.acceptable) return 'acceptable';
    if (avgLatency <= thresholds.poor) return 'poor';
    return 'critical';
  }

  /**
   * Calculate percentile from array of values
   */
  calculatePercentile(values, percentile) {
    const sorted = values.sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[index] || 0;
  }

  /**
   * Clean up old performance data
   */
  cleanupOldData() {
    const cutoffTime = Date.now() - (this.options.sampleWindow * 10); // Keep 10x window
    
    // Clean audio latency history
    this.metrics.audio.latencyHistory = this.metrics.audio.latencyHistory
      .filter(item => item.timestamp > cutoffTime);
  }

  /**
   * Get comprehensive performance report
   */
  getPerformanceReport() {
    const report = {
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      metrics: JSON.parse(JSON.stringify(this.metrics)), // Deep clone
      summary: {
        overallHealth: this.calculateOverallHealth(),
        recommendations: this.generateRecommendations()
      }
    };
    
    return report;
  }

  /**
   * Calculate overall system health score
   */
  calculateOverallHealth() {
    const weights = {
      audio: 0.4,
      ai: 0.3,
      network: 0.2,
      system: 0.1
    };
    
    let totalScore = 0;
    let totalWeight = 0;
    
    // Audio performance score
    const audioQuality = this.getPerformanceQuality(this.metrics.audio.avgLatency);
    const audioScore = this.qualityToScore(audioQuality);
    totalScore += audioScore * weights.audio;
    totalWeight += weights.audio;
    
    // AI performance score
    const aiLatency = this.metrics.ai.transcriptionLatency + 
                     this.metrics.ai.conversationLatency + 
                     this.metrics.ai.ttsLatency;
    const aiQuality = this.getPerformanceQuality(aiLatency);
    const aiScore = this.qualityToScore(aiQuality) * (this.metrics.ai.successRate / 100);
    totalScore += aiScore * weights.ai;
    totalWeight += weights.ai;
    
    // Network performance score
    const networkScore = this.calculateNetworkScore();
    totalScore += networkScore * weights.network;
    totalWeight += weights.network;
    
    // System performance score
    const systemScore = this.calculateSystemScore();
    totalScore += systemScore * weights.system;
    totalWeight += weights.system;
    
    const overallScore = totalWeight > 0 ? totalScore / totalWeight : 0;
    
    return {
      score: Math.round(overallScore),
      rating: this.scoreToRating(overallScore),
      components: {
        audio: { score: audioScore, quality: audioQuality },
        ai: { score: aiScore, quality: aiQuality },
        network: { score: networkScore },
        system: { score: systemScore }
      }
    };
  }

  /**
   * Convert quality rating to numeric score
   */
  qualityToScore(quality) {
    const scoreMap = {
      'excellent': 100,
      'good': 80,
      'acceptable': 60,
      'poor': 40,
      'critical': 20
    };
    return scoreMap[quality] || 0;
  }

  /**
   * Convert numeric score to rating
   */
  scoreToRating(score) {
    if (score >= 90) return 'excellent';
    if (score >= 75) return 'good';
    if (score >= 60) return 'acceptable';
    if (score >= 40) return 'poor';
    return 'critical';
  }

  /**
   * Calculate network performance score
   */
  calculateNetworkScore() {
    const network = this.metrics.network;
    let score = 100;
    
    // Penalize high WebSocket latency
    if (network.websocketLatency > 100) score -= 20;
    if (network.websocketLatency > 200) score -= 30;
    
    // Penalize packet loss
    if (network.packetLoss > 1) score -= 15;
    if (network.packetLoss > 5) score -= 35;
    
    // Factor in connection quality
    const qualityScores = {
      'excellent': 0,
      'good': -10,
      'fair': -25,
      'poor': -50,
      'critical': -75,
      'unknown': -20
    };
    
    score += qualityScores[network.connectionQuality] || -20;
    
    return Math.max(0, Math.min(100, score));
  }

  /**
   * Calculate system performance score
   */
  calculateSystemScore() {
    const system = this.metrics.system;
    let score = 100;
    
    // Penalize high memory usage
    if (system.memoryUsage && system.memoryUsage.rss > 512) score -= 15;
    if (system.memoryUsage && system.memoryUsage.rss > 1024) score -= 35;
    
    // Penalize high event loop lag
    if (system.eventLoopLag > 5) score -= 10;
    if (system.eventLoopLag > 15) score -= 30;
    if (system.eventLoopLag > 50) score -= 60;
    
    return Math.max(0, Math.min(100, score));
  }

  /**
   * Generate performance recommendations
   */
  generateRecommendations() {
    const recommendations = [];
    const audio = this.metrics.audio;
    const ai = this.metrics.ai;
    const system = this.metrics.system;
    
    // Audio performance recommendations
    if (audio.avgLatency > this.options.latencyThresholds.acceptable) {
      recommendations.push({
        type: 'audio',
        priority: 'high',
        message: 'Audio latency is high. Consider optimizing audio processing pipeline.',
        suggestion: 'Reduce audio buffer size, enable preprocessing, or upgrade hardware.'
      });
    }
    
    // AI performance recommendations
    if (ai.transcriptionLatency > 200) {
      recommendations.push({
        type: 'ai',
        priority: 'medium',
        message: 'Speech recognition latency is high.',
        suggestion: 'Check Deepgram connection, optimize audio quality, or use faster model.'
      });
    }
    
    if (ai.ttsLatency > 300) {
      recommendations.push({
        type: 'ai',
        priority: 'medium',
        message: 'Text-to-speech latency is high.',
        suggestion: 'Use faster TTS model, implement audio caching, or optimize synthesis pipeline.'
      });
    }
    
    if (ai.successRate < 95) {
      recommendations.push({
        type: 'ai',
        priority: 'high',
        message: 'AI service success rate is low.',
        suggestion: 'Check API keys, network connectivity, and error handling.'
      });
    }
    
    // System performance recommendations
    if (system.eventLoopLag > 10) {
      recommendations.push({
        type: 'system',
        priority: 'high',
        message: 'Event loop lag detected.',
        suggestion: 'Optimize blocking operations, use worker threads, or scale horizontally.'
      });
    }
    
    if (system.memoryUsage && system.memoryUsage.rss > 1024) {
      recommendations.push({
        type: 'system',
        priority: 'medium',
        message: 'High memory usage detected.',
        suggestion: 'Implement garbage collection optimization, reduce buffer sizes, or add more RAM.'
      });
    }
    
    return recommendations;
  }

  /**
   * Reset all metrics
   */
  resetMetrics() {
    this.metrics = {
      audio: {
        packetsProcessed: 0,
        totalLatency: 0,
        avgLatency: 0,
        minLatency: Infinity,
        maxLatency: 0,
        latencyHistory: [],
        throughput: 0,
        errorCount: 0
      },
      ai: {
        transcriptionLatency: 0,
        ttsLatency: 0,
        conversationLatency: 0,
        totalRequests: 0,
        successRate: 0,
        errorCount: 0
      },
      network: {
        websocketLatency: 0,
        packetLoss: 0,
        bandwidth: 0,
        connectionQuality: 'unknown'
      },
      system: {
        cpuUsage: 0,
        memoryUsage: 0,
        eventLoopLag: 0,
        gcPause: 0
      }
    };
  }

  /**
   * Stop performance monitoring
   */
  stop() {
    if (this.analysisInterval) {
      clearInterval(this.analysisInterval);
      this.analysisInterval = null;
    }
    
    this.removeAllListeners();
    console.log('📊 [PERF-MONITOR] Performance monitoring stopped');
  }
}

/**
 * Latency Optimizer - Automatically adjusts settings based on performance
 */
class LatencyOptimizer extends EventEmitter {
  constructor(monitor, options = {}) {
    super();
    
    this.monitor = monitor;
    this.options = {
      autoOptimize: options.autoOptimize !== false,
      optimizationInterval: options.optimizationInterval || 30000, // 30 seconds
      targetLatency: options.targetLatency || 100, // ms
      aggressiveness: options.aggressiveness || 'medium', // low, medium, high
      ...options
    };
    
    this.currentSettings = {
      audioBufferSize: 320,
      audioPreprocessing: true,
      vadEnabled: true,
      compressionLevel: 'medium',
      aiModel: 'fast'
    };
    
    this.optimizationHistory = [];
    
    if (this.options.autoOptimize) {
      this.startAutoOptimization();
    }
  }

  /**
   * Start automatic latency optimization
   */
  startAutoOptimization() {
    this.monitor.on('performance-analysis', (analysis) => {
      this.analyzeAndOptimize(analysis);
    });
    
    console.log('🔧 [LATENCY-OPTIMIZER] Auto-optimization started');
  }

  /**
   * Analyze performance and apply optimizations
   */
  analyzeAndOptimize(analysis) {
    const { type, metrics } = analysis;
    
    if (type === 'audio' && metrics.avgLatency > this.options.targetLatency) {
      this.optimizeAudioSettings(metrics);
    }
    
    if (type === 'ai' && metrics.totalLatency > this.options.targetLatency * 2) {
      this.optimizeAISettings(metrics);
    }
  }

  /**
   * Optimize audio processing settings
   */
  optimizeAudioSettings(metrics) {
    const optimizations = [];
    
    // Reduce buffer size if latency is high
    if (metrics.avgLatency > this.options.targetLatency * 1.5) {
      if (this.currentSettings.audioBufferSize > 160) {
        this.currentSettings.audioBufferSize = Math.max(160, this.currentSettings.audioBufferSize * 0.8);
        optimizations.push('Reduced audio buffer size');
      }
    }
    
    // Disable preprocessing if CPU is overloaded
    if (this.monitor.metrics.system.eventLoopLag > 20 && this.currentSettings.audioPreprocessing) {
      this.currentSettings.audioPreprocessing = false;
      optimizations.push('Disabled audio preprocessing');
    }
    
    // Adjust VAD sensitivity
    if (metrics.throughput < 10 && this.currentSettings.vadEnabled) {
      // If throughput is low, VAD might be too sensitive
      optimizations.push('Adjusted VAD sensitivity');
    }
    
    if (optimizations.length > 0) {
      this.applyOptimizations('audio', optimizations, metrics);
    }
  }

  /**
   * Optimize AI service settings
   */
  optimizeAISettings(metrics) {
    const optimizations = [];
    
    // Use faster AI models if latency is too high
    if (metrics.totalLatency > this.options.targetLatency * 3) {
      if (this.currentSettings.aiModel !== 'fastest') {
        this.currentSettings.aiModel = 'fastest';
        optimizations.push('Switched to fastest AI model');
      }
    }
    
    // Reduce AI response length if conversation latency is high
    if (metrics.conversationLatency > 500) {
      optimizations.push('Reduced AI response length');
    }
    
    if (optimizations.length > 0) {
      this.applyOptimizations('ai', optimizations, metrics);
    }
  }

  /**
   * Apply optimizations and track results
   */
  applyOptimizations(category, optimizations, metrics) {
    const optimization = {
      timestamp: new Date().toISOString(),
      category,
      optimizations,
      beforeMetrics: { ...metrics },
      settings: { ...this.currentSettings }
    };
    
    this.optimizationHistory.push(optimization);
    
    // Emit optimization event
    this.emit('optimization-applied', optimization);
    
    console.log(`🔧 [LATENCY-OPTIMIZER] Applied ${category} optimizations:`, optimizations);
    
    // Schedule result evaluation
    setTimeout(() => {
      this.evaluateOptimizationResults(optimization);
    }, 10000); // Wait 10 seconds to see results
  }

  /**
   * Evaluate optimization results
   */
  evaluateOptimizationResults(optimization) {
    const currentMetrics = this.monitor.metrics[optimization.category];
    const improvement = this.calculateImprovement(optimization.beforeMetrics, currentMetrics);
    
    optimization.afterMetrics = { ...currentMetrics };
    optimization.improvement = improvement;
    optimization.success = improvement > 5; // 5% improvement threshold
    
    if (optimization.success) {
      console.log(`✅ [LATENCY-OPTIMIZER] Optimization successful: ${improvement.toFixed(1)}% improvement`);
    } else {
      console.log(`❌ [LATENCY-OPTIMIZER] Optimization ineffective: ${improvement.toFixed(1)}% change`);
      this.revertOptimization(optimization);
    }
    
    this.emit('optimization-evaluated', optimization);
  }

  /**
   * Calculate improvement percentage
   */
  calculateImprovement(before, after) {
    const beforeLatency = before.avgLatency || before.totalLatency || 0;
    const afterLatency = after.avgLatency || after.totalLatency || 0;
    
    if (beforeLatency === 0) return 0;
    
    return ((beforeLatency - afterLatency) / beforeLatency) * 100;
  }

  /**
   * Revert unsuccessful optimization
   */
  revertOptimization(optimization) {
    // This would typically involve restoring previous settings
    // Implementation depends on how settings are applied to the system
    console.log(`🔄 [LATENCY-OPTIMIZER] Reverting optimization for ${optimization.category}`);
  }

  /**
   * Get current optimization settings
   */
  getCurrentSettings() {
    return { ...this.currentSettings };
  }

  /**
   * Get optimization history
   */
  getOptimizationHistory(limit = 50) {
    return this.optimizationHistory.slice(-limit);
  }

  /**
   * Stop auto-optimization
   */
  stop() {
    this.monitor.removeAllListeners();
    this.removeAllListeners();
    console.log('🔧 [LATENCY-OPTIMIZER] Auto-optimization stopped');
  }
}

/**
 * Real-time performance dashboard data provider
 */
class PerformanceDashboard {
  constructor(monitor, optimizer = null) {
    this.monitor = monitor;
    this.optimizer = optimizer;
  }

  /**
   * Get dashboard data
   */
  getDashboardData() {
    const report = this.monitor.getPerformanceReport();
    const settings = this.optimizer ? this.optimizer.getCurrentSettings() : null;
    const optimizations = this.optimizer ? this.optimizer.getOptimizationHistory(10) : [];
    
    return {
      ...report,
      currentSettings: settings,
      recentOptimizations: optimizations,
      realTimeAlerts: this.getActiveAlerts(),
      recommendations: report.summary.recommendations.slice(0, 5) // Top 5 recommendations
    };
  }

  /**
   * Get active performance alerts
   */
  getActiveAlerts() {
    const alerts = [];
    const metrics = this.monitor.metrics;
    
    // Check for active performance issues
    if (metrics.audio.avgLatency > 200) {
      alerts.push({
        type: 'warning',
        category: 'audio',
        message: 'High audio latency detected',
        value: `${metrics.audio.avgLatency.toFixed(1)}ms`,
        threshold: '200ms'
      });
    }
    
    if (metrics.system.eventLoopLag > 10) {
      alerts.push({
        type: 'error',
        category: 'system',
        message: 'Event loop lag detected',
        value: `${metrics.system.eventLoopLag.toFixed(1)}ms`,
        threshold: '10ms'
      });
    }
    
    if (metrics.ai.successRate < 95) {
      alerts.push({
        type: 'warning',
        category: 'ai',
        message: 'Low AI service success rate',
        value: `${metrics.ai.successRate.toFixed(1)}%`,
        threshold: '95%'
      });
    }
    
    return alerts;
  }
}

module.exports = {
  PerformanceMonitor,
  LatencyOptimizer,
  PerformanceDashboard
};