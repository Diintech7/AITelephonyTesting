const mongoose = require("mongoose");

// MongoDB connection configuration
const connectDatabase = async () => {
  try {
    const mongoUri = process.env.MONGODB_URI;
    
    if (!mongoUri) {
      throw new Error("MONGODB_URI is not defined in environment variables");
    }

    console.log("🔌 [DATABASE] Connecting to MongoDB...");

    // Mongoose connection options
    const options = {
      // Connection management
      maxPoolSize: 10, // Maintain up to 10 socket connections
      serverSelectionTimeoutMS: 5000, // Keep trying to send operations for 5 seconds
      socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
      family: 4, // Use IPv4, skip trying IPv6
      
      // Buffer management
      bufferCommands: false, // Disable mongoose buffering
      bufferMaxEntries: 0, // Disable mongoose buffering
      
      // Retry logic
      retryWrites: true,
      retryReads: true,
    };

    // Connect to MongoDB
    await mongoose.connect(mongoUri);

    console.log("✅ [DATABASE] Connected to MongoDB successfully");
    console.log(`📍 [DATABASE] Database: ${mongoose.connection.name}`);
    console.log(`🌐 [DATABASE] Host: ${mongoose.connection.host}:${mongoose.connection.port}`);

    // Connection event handlers
    mongoose.connection.on("error", (error) => {
      console.error("❌ [DATABASE] Connection error:", error.message);
    });

    mongoose.connection.on("disconnected", () => {
      console.warn("⚠️ [DATABASE] Disconnected from MongoDB");
    });

    mongoose.connection.on("reconnected", () => {
      console.log("🔄 [DATABASE] Reconnected to MongoDB");
    });

    // Graceful shutdown handler
    process.on("SIGINT", async () => {
      try {
        await mongoose.connection.close();
        console.log("🔌 [DATABASE] Connection closed through app termination");
      } catch (error) {
        console.error("❌ [DATABASE] Error closing connection:", error.message);
      }
    });

    return mongoose.connection;

  } catch (error) {
    console.error("❌ [DATABASE] Failed to connect:", error.message);
    
    // Exit process if database connection fails
    console.error("💥 [DATABASE] Exiting due to connection failure...");
    process.exit(1);
  }
};

// Database health check
const checkDatabaseHealth = async () => {
  try {
    if (mongoose.connection.readyState === 1) {
      // Test the connection with a simple operation
      await mongoose.connection.db.admin().ping();
      return {
        status: "healthy",
        readyState: mongoose.connection.readyState,
        host: mongoose.connection.host,
        port: mongoose.connection.port,
        name: mongoose.connection.name,
      };
    } else {
      return {
        status: "unhealthy",
        readyState: mongoose.connection.readyState,
        message: "Database not connected",
      };
    }
  } catch (error) {
    return {
      status: "error",
      readyState: mongoose.connection.readyState,
      error: error.message,
    };
  }
};

// Get database statistics
const getDatabaseStats = async () => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return { error: "Database not connected" };
    }

    const stats = await mongoose.connection.db.stats();
    
    return {
      collections: stats.collections,
      objects: stats.objects,
      avgObjSize: stats.avgObjSize,
      dataSize: stats.dataSize,
      storageSize: stats.storageSize,
      indexes: stats.indexes,
      indexSize: stats.indexSize,
      ok: stats.ok,
    };
  } catch (error) {
    return { error: error.message };
  }
};

// Connection state helper
const getConnectionState = () => {
  const states = {
    0: "disconnected",
    1: "connected",
    2: "connecting",
    3: "disconnecting",
  };
  
  return {
    state: states[mongoose.connection.readyState],
    readyState: mongoose.connection.readyState,
    host: mongoose.connection.host,
    port: mongoose.connection.port,
    name: mongoose.connection.name,
  };
};

module.exports = {
  connectDatabase,
  checkDatabaseHealth,
  getDatabaseStats,
  getConnectionState,
};