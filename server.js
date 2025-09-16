const express = require("express")
const http = require("http")
const WebSocket = require("ws")
const cors = require("cors")
const path = require("path")
const url = require("url")
require("dotenv").config()

// Import database connection
const { connectDatabase, checkDatabaseHealth, getDatabaseStats, getConnectionState } = require("./config/database")

// Import the unified voice server from aitota.js
const { setupUnifiedVoiceServer, terminateCallByStreamSid } = require("./websocket/aitota")
const { setupSipWebSocketServer } = require("./websocket/sip-server")
const { setupSanPbxWebSocketServer } = require("./websocket/sanpbx-server")

// Environment configuration
const PORT = process.env.PORT || 3000
const NODE_ENV = process.env.NODE_ENV || "development"

// Express app setup
const app = express()
const server = http.createServer(app)

app.use(cors())
app.use(express.json({ limit: "10mb" }))
app.use(express.urlencoded({ extended: true }))
app.use(express.static(path.join(__dirname, "public")))

// Initialize database connection
const initializeDatabase = async () => {
  try {
    await connectDatabase()
    console.log("🎯 [SERVER] Database initialization complete")
    return true
  } catch (error) {
    console.error("❌ [SERVER] Database initialization failed:", error.message)
    return false
  }
}

// Connection tracking
let activeConnections = 0
let totalConnections = 0
let sipActiveConnections = 0
let sipTotalConnections = 0
let sanpbxActiveConnections = 0
let sanpbxTotalConnections = 0

// Create WebSocket servers WITHOUT path specification initially
const wss = new WebSocket.Server({
  noServer: true, // This is key - we'll handle upgrades manually
  perMessageDeflate: false,
  clientTracking: true,
})

const sipWss = new WebSocket.Server({
  noServer: true, // This is key - we'll handle upgrades manually
  perMessageDeflate: false,
  clientTracking: true,
})

const sanpbxWss = new WebSocket.Server({
  noServer: true, // This is key - we'll handle upgrades manually
  perMessageDeflate: false,
  clientTracking: true,
})

// Manual WebSocket upgrade handling based on path
server.on("upgrade", (request, socket, head) => {
  const pathname = url.parse(request.url).pathname

  console.log(`🔄 [SERVER] WebSocket upgrade request for path: ${pathname}`)

  if (pathname === "/ws") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request)
    })
  } else if (pathname === "/sip-ws") {
    sipWss.handleUpgrade(request, socket, head, (ws) => {
      sipWss.emit("connection", ws, request)
    })
  } else if (pathname === "/sanpbx-ws") {
    sanpbxWss.handleUpgrade(request, socket, head, (ws) => {
      sanpbxWss.emit("connection", ws, request)
    })
  } else {
    console.log(`❌ [SERVER] Unknown WebSocket path: ${pathname}`)
    socket.destroy()
  }
})

// AITOTA WebSocket connection handling
wss.on("connection", (ws, req) => {
  activeConnections++
  totalConnections++

  const clientIP = req.socket.remoteAddress
  const userAgent = req.headers["user-agent"]

  console.log(`🔗 [AITOTA-WS] New connection from ${clientIP}`)
  console.log(`📊 [AITOTA-WS] Active: ${activeConnections}, Total: ${totalConnections}`)

  // Add connection metadata
  ws.connectionId = `aitota_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  ws.connectedAt = new Date()
  ws.clientIP = clientIP
  ws.userAgent = userAgent

  ws.on("close", (code, reason) => {
    activeConnections--
    const duration = Date.now() - ws.connectedAt.getTime()
    console.log(`🔗 [AITOTA-WS] Connection closed: ${ws.connectionId}`)
    console.log(`📊 [AITOTA-WS] Duration: ${Math.round(duration / 1000)}s, Active: ${activeConnections}`)
  })

  ws.on("error", (error) => {
    console.error(`❌ [AITOTA-WS] WebSocket error for ${ws.connectionId}:`, error.message)
  })
})

// SIP WebSocket connection handling
sipWss.on("connection", (ws, req) => {
  sipActiveConnections++
  sipTotalConnections++

  const clientIP = req.socket.remoteAddress
  console.log(`🔗 [SIP-WS] New connection from ${clientIP}`)
  console.log(`📊 [SIP-WS] Active: ${sipActiveConnections}, Total: ${sipTotalConnections}`)

  // Add connection metadata
  ws.connectionId = `sip_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  ws.connectedAt = new Date()
  ws.clientIP = clientIP

  ws.on("close", (code, reason) => {
    sipActiveConnections--
    const duration = Date.now() - ws.connectedAt.getTime()
    console.log(`🔗 [SIP-WS] Connection closed: ${ws.connectionId}`)
    console.log(`📊 [SIP-WS] Duration: ${Math.round(duration / 1000)}s, Active: ${sipActiveConnections}`)
  })

  ws.on("error", (error) => {
    console.error(`❌ [SIP-WS] Connection error for ${ws.connectionId}:`, error.message)
  })
})

// SanIPPBX WebSocket connection handling
// Setup SanIPPBX WebSocket server
sanpbxWss.on("connection", (ws, req) => {
  const clientIP = req.socket.remoteAddress
  console.log(`🔗 [SANPBX-WS] New connection from ${clientIP}`)
  console.log(`📊 [SANPBX-WS] Active: ${sanpbxActiveConnections}, Total: ${sanpbxTotalConnections}`)

  ws.connectionId = `sanpbx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  ws.connectedAt = new Date()
  ws.clientIP = clientIP

  // 🔑 Pass *this connection* into your handler
  require("./websocket/sanpbx-server").setupSanPbxWebSocketServer(ws)

  ws.on("close", () => {
    sanpbxActiveConnections--
    const duration = Date.now() - ws.connectedAt.getTime()
    console.log(`🔗 [SANPBX-WS] Connection closed: ${ws.connectionId}`)
    console.log(`📊 [SANPBX-WS] Duration: ${Math.round(duration / 1000)}s, Active: ${sanpbxActiveConnections}`)
  })

  ws.on("error", (error) => {
    console.error(`❌ [SANPBX-WS] Connection error for ${ws.connectionId}:`, error.message)
  })
})

console.log("✅ [SERVER] SanIPPBX WebSocket server setup enabled")


// Add error handling for all WebSocket servers
wss.on("error", (error) => {
  console.error("❌ [AITOTA-WS] WebSocket server error:", error.message)
})

sipWss.on("error", (error) => {
  console.error("❌ [SIP-WS] WebSocket server error:", error.message)
})

sanpbxWss.on("error", (error) => {
  console.error("❌ [SANPBX-WS] WebSocket server error:", error.message)
})

// Initialize the unified voice server with the WebSocket server
setupUnifiedVoiceServer(wss)

// Setup SIP WebSocket server
setupSipWebSocketServer(sipWss)
console.log("✅ [SERVER] SIP WebSocket server setup enabled")

// Setup SanIPPBX WebSocket server
// setupSanPbxWebSocketServer(sanpbxWss)
console.log("✅ [SERVER] SanIPPBX WebSocket server setup enabled")

// ==================== API ENDPOINTS ====================

// Live logs endpoint with filtering and pagination
app.get("/api/logs", async (req, res) => {
  try {
    const { clientId, limit = 50, page = 1, leadStatus, isActive, sortBy = "createdAt", sortOrder = "desc" } = req.query

    // Build query filters
    const filters = {}
    if (clientId) filters.clientId = clientId
    if (leadStatus) filters.leadStatus = leadStatus
    if (isActive !== undefined) filters["metadata.isActive"] = isActive === "true"

    // Build sort object
    const sort = {}
    sort[sortBy] = sortOrder === "desc" ? -1 : 1

    // Calculate skip for pagination
    const skip = (Number.parseInt(page) - 1) * Number.parseInt(limit)

    // Import CallLog model
    const CallLog = require("./models/CallLog")

    // Execute query with pagination
    const [logs, totalCount, activeCount] = await Promise.all([
      CallLog.find(filters).sort(sort).limit(Number.parseInt(limit)).skip(skip).lean().exec(),
      CallLog.countDocuments(filters),
      CallLog.countDocuments({
        ...filters,
        "metadata.isActive": true,
      }),
    ])

    // Get unique clients for filter options
    const clientIds = await CallLog.distinct("clientId", {})

    // Response with logs and metadata
    const response = {
      logs,
      pagination: {
        total: totalCount,
        page: Number.parseInt(page),
        limit: Number.parseInt(limit),
        pages: Math.ceil(totalCount / Number.parseInt(limit)),
      },
      stats: {
        total: totalCount,
        active: activeCount,
        clients: clientIds.length,
        timestamp: new Date().toISOString(),
      },
      filters: {
        clientId,
        leadStatus,
        isActive,
        availableClients: clientIds.sort(),
      },
    }

    res.json(response)
  } catch (error) {
    console.error("❌ [LOGS-API] Error fetching logs:", error.message)
    res.status(500).json({
      error: "Failed to fetch logs",
      message: error.message,
      timestamp: new Date().toISOString(),
    })
  }
})

// Get specific call log by ID
app.get("/api/logs/:id", async (req, res) => {
  try {
    const { id } = req.params
    const CallLog = require("./models/CallLog")

    const log = await CallLog.findById(id).lean()

    if (!log) {
      return res.status(404).json({
        error: "Call log not found",
        id: id,
        timestamp: new Date().toISOString(),
      })
    }

    res.json({
      log,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("❌ [LOGS-API] Error fetching log:", error.message)
    res.status(500).json({
      error: "Failed to fetch log",
      message: error.message,
      timestamp: new Date().toISOString(),
    })
  }
})

// Get live statistics
app.get("/api/logs/stats", async (req, res) => {
  try {
    const CallLog = require("./models/CallLog")

    const [totalCalls, activeCalls, todaysCalls, statusBreakdown, clientBreakdown] = await Promise.all([
      CallLog.countDocuments(),
      CallLog.countDocuments({ "metadata.isActive": true }),
      CallLog.countDocuments({
        createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) },
      }),
      CallLog.aggregate([{ $group: { _id: "$leadStatus", count: { $sum: 1 } } }]),
      CallLog.aggregate([
        {
          $group: {
            _id: "$clientId",
            count: { $sum: 1 },
            activeCalls: { $sum: { $cond: ["$metadata.isActive", 1, 0] } },
          },
        },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),
    ])

    const stats = {
      overview: {
        total: totalCalls,
        active: activeCalls,
        today: todaysCalls,
        timestamp: new Date().toISOString(),
      },
      statusBreakdown: statusBreakdown.reduce((acc, item) => {
        acc[item._id] = item.count
        return acc
      }, {}),
      topClients: clientBreakdown,
      server: {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        activeConnections: activeConnections + sipActiveConnections + sanpbxActiveConnections,
        totalConnections: totalConnections + sipTotalConnections + sanpbxTotalConnections,
      },
    }

    res.json(stats)
  } catch (error) {
    console.error("❌ [LOGS-STATS] Error generating stats:", error.message)
    res.status(500).json({
      error: "Failed to generate statistics",
      message: error.message,
      timestamp: new Date().toISOString(),
    })
  }
})

// Clean up stale active calls (utility endpoint)
app.post("/api/logs/cleanup", async (req, res) => {
  try {
    const CallLog = require("./models/CallLog")
    const result = await CallLog.cleanupStaleActiveCalls()

    res.json({
      message: "Cleanup completed",
      modifiedCount: result.modifiedCount,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("❌ [LOGS-CLEANUP] Error during cleanup:", error.message)
    res.status(500).json({
      error: "Failed to cleanup stale calls",
      message: error.message,
      timestamp: new Date().toISOString(),
    })
  }
})

// Terminate active call by streamSid
app.post("/api/calls/terminate", async (req, res) => {
  try {
    const { streamSid, reason } = req.body

    if (!streamSid) {
      return res.status(400).json({
        error: "Missing required parameter",
        message: "streamSid is required",
        timestamp: new Date().toISOString(),
      })
    }

    console.log(
      `🛑 [API-TERMINATE] Terminating call with streamSid: ${streamSid}, reason: ${reason || "manual_termination"}`,
    )

    const result = await terminateCallByStreamSid(streamSid, reason || "manual_termination")

    if (result.success) {
      res.json({
        success: true,
        message: result.message,
        data: {
          streamSid,
          reason: reason || "manual_termination",
          method: result.method,
          timestamp: new Date().toISOString(),
        },
      })
    } else {
      res.status(404).json({
        success: false,
        message: result.message,
        data: {
          streamSid,
          reason: reason || "manual_termination",
          method: result.method,
          timestamp: new Date().toISOString(),
        },
      })
    }
  } catch (error) {
    console.error("❌ [API-TERMINATE] Error terminating call:", error.message)
    res.status(500).json({
      error: "Failed to terminate call",
      message: error.message,
      timestamp: new Date().toISOString(),
    })
  }
})

// Health check endpoint
app.get("/health", async (req, res) => {
  try {
    const dbHealth = await checkDatabaseHealth()
    const connectionState = getConnectionState()

    const health = {
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: {
        ...dbHealth,
        connection: connectionState,
      },
      server: {
        port: PORT,
        environment: NODE_ENV,
        memory: process.memoryUsage(),
      },
      websockets: {
        aitota: {
          clients: wss.clients.size,
          active: activeConnections,
        },
        sip: {
          clients: sipWss.clients.size,
          active: sipActiveConnections,
        },
        sanpbx: {
          clients: sanpbxWss.clients.size,
          active: sanpbxActiveConnections,
        },
      },
    }

    // If database is unhealthy, return 503
    if (dbHealth.status !== "healthy") {
      return res.status(503).json({
        ...health,
        status: "degraded",
        message: "Database connection issues",
      })
    }

    res.json(health)
  } catch (error) {
    res.status(500).json({
      status: "error",
      timestamp: new Date().toISOString(),
      error: error.message,
    })
  }
})

// Server info endpoint
app.get("/api/info", async (req, res) => {
  try {
    const dbStats = await getDatabaseStats()
    const connectionState = getConnectionState()

    res.json({
      server: {
        name: "AITOTA Voice AI Server with SIP Support",
        version: "1.1.0",
        environment: NODE_ENV,
        port: PORT,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        nodeVersion: process.version,
      },
      database: {
        connection: connectionState,
        statistics: dbStats,
      },
      endpoints: {
        websocket: `/ws`,
        sipWebsocket: `/sip-ws`,
        sanpbxWebsocket: `/sanpbx-ws`,
        health: `/health`,
        stats: `/api/stats`,
        info: `/api/info`,
        logs: `/api/logs`,
        logsById: `/api/logs/:id`,
        logsStats: `/api/logs/stats`,
        logsCleanup: `/api/logs/cleanup`,
        callsTerminate: `/api/calls/terminate`,
        clickToCallSupport: `/api/click-to-call-support`,
      },
    })
  } catch (error) {
    res.status(500).json({
      error: "Failed to get server info",
      message: error.message,
    })
  }
})

// Server statistics endpoint
app.get("/api/stats", async (req, res) => {
  try {
    const dbHealth = await checkDatabaseHealth()
    const dbStats = await getDatabaseStats()
    const connectionState = getConnectionState()

    const stats = {
      server: {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        activeConnections: activeConnections + sipActiveConnections + sanpbxActiveConnections,
        totalConnections: totalConnections + sipTotalConnections + sanpbxTotalConnections,
        timestamp: new Date().toISOString(),
      },
      websocket: {
        aitota: {
          clients: wss.clients.size,
          active: activeConnections,
          total: totalConnections,
          connections: Array.from(wss.clients).map((ws) => ({
            id: ws.connectionId,
            connectedAt: ws.connectedAt,
            readyState: ws.readyState,
            clientIP: ws.clientIP?.replace(/^.*:/, ""), // Hide full IP for privacy
          })),
        },
        sip: {
          clients: sipWss.clients.size,
          active: sipActiveConnections,
          total: sipTotalConnections,
          connections: Array.from(sipWss.clients).map((ws) => ({
            id: ws.connectionId,
            connectedAt: ws.connectedAt,
            readyState: ws.readyState,
            clientIP: ws.clientIP?.replace(/^.*:/, ""), // Hide full IP for privacy
          })),
        },
        sanpbx: {
          clients: sanpbxWss.clients.size,
          active: sanpbxActiveConnections,
          total: sanpbxTotalConnections,
          connections: Array.from(sanpbxWss.clients).map((ws) => ({
            id: ws.connectionId,
            connectedAt: ws.connectedAt,
            readyState: ws.readyState,
            clientIP: ws.clientIP?.replace(/^.*:/, ""), // Hide full IP for privacy
          })),
        },
      },
      database: {
        health: dbHealth,
        connection: connectionState,
        statistics: dbStats,
      },
    }

    res.json(stats)
  } catch (error) {
    res.status(500).json({
      error: "Failed to get server statistics",
      message: error.message,
    })
  }
})

// Proxy endpoint for Tata Smartflo Click-to-Call Support
app.post("/api/click-to-call-support", async (req, res) => {
  try {
    const { api_key, customer_number, caller_id, get_call_id, async: asyncFlag } = req.body || {}

    if (!api_key || !customer_number) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameters: api_key and customer_number",
        timestamp: new Date().toISOString(),
      })
    }

    const payload = {
      api_key,
      customer_number,
    }

    if (caller_id) payload.caller_id = caller_id
    if (get_call_id !== undefined) payload.get_call_id = Number(get_call_id) ? 1 : 0
    if (asyncFlag !== undefined) payload.async = Number(asyncFlag) ? 1 : 0

    const CLICK_TO_CALL_URL = "https://api-smartflo.tatateleservices.com/v1/click_to_call_support"

    const upstream = await fetch(CLICK_TO_CALL_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    })

    const text = await upstream.text()
    let json
    try {
      json = JSON.parse(text)
    } catch (_) {
      json = { raw: text }
    }

    return res.status(upstream.status).json(json)
  } catch (error) {
    console.error("❌ [C2C] Click-to-Call proxy error:", error.message)
    return res.status(500).json({
      success: false,
      message: "Failed to initiate click-to-call",
      error: error.message,
      timestamp: new Date().toISOString(),
    })
  }
})

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(`❌ [SERVER] Express error:`, err.stack)
  res.status(500).json({
    error: "Internal Server Error",
    message: NODE_ENV === "development" ? err.message : "Something went wrong!",
  })
})

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: "Not Found",
    message: "The requested resource was not found",
    path: req.path,
  })
})

// Graceful shutdown handling
const gracefulShutdown = (signal) => {
  console.log(`\n🛑 [SERVER] Received ${signal}, shutting down gracefully...`)

  server.close(() => {
    console.log("📞 [SERVER] HTTP server closed")

    // Close all WebSocket connections
    wss.clients.forEach((ws) => {
      ws.terminate()
    })

    sipWss.clients.forEach((ws) => {
      ws.terminate()
    })

    sanpbxWss.clients.forEach((ws) => {
      ws.terminate()
    })

    wss.close(() => {
      console.log("🔌 [SERVER] AITOTA WebSocket server closed")

      sipWss.close(() => {
        console.log("🔌 [SERVER] SIP WebSocket server closed")

        sanpbxWss.close(() => {
          console.log("🔌 [SERVER] SanIPPBX WebSocket server closed")
          console.log("✅ [SERVER] Graceful shutdown complete")
          process.exit(0)
        })
      })
    })
  })
}

// Handle shutdown signals
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"))
process.on("SIGINT", () => gracefulShutdown("SIGINT"))

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("💥 [SERVER] Uncaught Exception:", error)
  gracefulShutdown("UNCAUGHT_EXCEPTION")
})

process.on("unhandledRejection", (reason, promise) => {
  console.error("💥 [SERVER] Unhandled Rejection at:", promise, "reason:", reason)
  gracefulShutdown("UNHANDLED_REJECTION")
})

// Start the server after database initialization
const startServer = async () => {
  try {
    console.log("\n🚀 ====== AITOTA VOICE AI SERVER WITH SIP SUPPORT STARTING ======")
    console.log(`🌍 Environment: ${NODE_ENV}`)
    console.log(`📍 Port: ${PORT}`)

    // Initialize database first
    const dbInitialized = await initializeDatabase()
    if (!dbInitialized) {
      console.error("❌ [SERVER] Failed to initialize database, exiting...")
      process.exit(1)
    }

    // Start HTTP server
    server.listen(PORT, () => {
      console.log("\n✅ ====== SERVER STARTED SUCCESSFULLY ======")
      console.log(`📍 Server running on port ${PORT}`)
      console.log(`🌍 Environment: ${NODE_ENV}`)
      console.log(`🔗 AITOTA WebSocket endpoint: ws://localhost:${PORT}/ws`)
      console.log(`🔗 SIP WebSocket endpoint: ws://localhost:${PORT}/sip-ws`)
      console.log(`🔗 SanIPPBX WebSocket endpoint: ws://localhost:${PORT}/sanpbx-ws`)
      console.log(`🩺 Health check: http://localhost:${PORT}/health`)
      console.log(`📊 Server stats: http://localhost:${PORT}/api/stats`)
      console.log(`📋 Server info: http://localhost:${PORT}/api/info`)
      console.log("\n📊 [SERVER] Live logs API routes registered:")
      console.log("📊 [SERVER] GET /api/logs - Get call logs with filtering")
      console.log("📊 [SERVER] GET /api/logs/:id - Get specific call log")
      console.log("📊 [SERVER] GET /api/logs/stats - Get live statistics")
      console.log("📊 [SERVER] POST /api/logs/cleanup - Cleanup stale active calls")
      console.log("📊 [SERVER] POST /api/calls/terminate - Terminate active call by streamSid")
      console.log("==============================================\n")
    })
  } catch (error) {
    console.error("❌ [SERVER] Failed to start:", error.message)
    process.exit(1)
  }
}

startServer()

// Export server for testing purposes
module.exports = { app, server, wss, sipWss, sanpbxWss }