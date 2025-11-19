// server/index.js
/**
 * ToolManager REST API Server
 *
 * Provides RESTful endpoints for CNC tool inventory management and matrix processing.
 */

const express = require("express");
const cors = require("cors");
const config = require("../config");
const Logger = require("../utils/Logger");
const DataManager = require("../src/DataManager");
const Executor = require("../src/Executor");

const app = express();
const PORT = 3002;
let executor = null;

// Middleware
app.use(
  cors({
    origin: ["http://localhost:5173", "http://localhost:3000"],
    credentials: true,
  })
);
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  Logger.info(`${req.method} ${req.path}`, { ip: req.ip });
  next();
});

// Initialize DataManager
let dataManager = null;

async function initializeDataManager() {
  try {
    dataManager = new DataManager();
    await dataManager.initialize();
    Logger.info("DataManager initialized successfully");
    return true;
  } catch (error) {
    Logger.error("Failed to initialize DataManager", { error: error.message });
    return false;
  }
}

// ===== API ROUTES =====

/**
 * GET /api/status
 * Health check and service status
 */
app.get("/api/status", (req, res) => {
  res.json({
    status: "running",
    mode: config.app.autoMode ? "auto" : "manual",
    testMode: config.app.testMode,
    version: "2.0.0",
    timestamp: new Date().toISOString(),
    dataManager: dataManager ? "initialized" : "not initialized",
  });
});

/**
 * GET /api/tools
 * List all tools in inventory
 */
app.get("/api/tools", async (req, res) => {
  try {
    const status = req.query.status; // filter by status: in_use|available
    const isMatrix = req.query.isMatrix; // filter by isMatrix: true|false

    if (!dataManager) {
      Logger.error("❌ API Request Failed: DataManager not initialized");
      return res.status(503).json({
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "DataManager not initialized",
        },
      });
    }

    // Build filter object
    const filter = {};
    if (status) filter.status = status;
    if (isMatrix !== undefined) filter.isMatrix = isMatrix === "true";

    // Get real tools from DataManager
    Logger.info("📡 Dashboard requested tools list");
    const tools = await dataManager.getAllTools(filter);
    const stats = await dataManager.getToolUsageStats();
    Logger.info(`📊 Returning ${tools.length} tools to Dashboard`);

    const response = {
      tools,
      total: tools.length,
      stats,
    };
    
    // Log first 2 tools as sample
    if (tools.length > 0) {
      Logger.info(`📦 Sample tool data: ${JSON.stringify(tools.slice(0, 2), null, 2)}`);
    }

    res.json(response);
  } catch (error) {
    Logger.error("Failed to get tools", { error: error.message });
    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to retrieve tools",
        details: error.message,
      },
    });
  }
});

/**
 * GET /api/tool-images/:manufacturer/:filename
 * Serve tool type images
 */
app.get("/api/tool-images/:manufacturer/:filename", (req, res) => {
  const fs = require("fs");
  const path = require("path");

  try {
    const { manufacturer, filename } = req.params;
    const toolImagesPath = config.getToolImagesPath();
    const imagePath = path.join(toolImagesPath, manufacturer, filename);

    // Check if file exists
    if (!fs.existsSync(imagePath)) {
      Logger.warn(`Tool image not found: ${manufacturer}/${filename}`);
      return res.status(404).json({ error: "Image not found" });
    }

    // Determine content type from extension
    const ext = path.extname(filename).toLowerCase();
    const contentTypes = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".jfif": "image/jpeg",
    };

    const contentType = contentTypes[ext] || "application/octet-stream";

    // Read and serve the file
    const imageBuffer = fs.readFileSync(imagePath);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400"); // Cache for 24 hours
    res.send(imageBuffer);

    Logger.info(`Served tool image: ${manufacturer}/${filename}`);
  } catch (error) {
    Logger.error("Failed to serve tool image", { error: error.message });
    res.status(500).json({ error: "Failed to serve image" });
  }
});

/**
 * GET /api/tools/:id
 * Get specific tool details
 */
app.get("/api/tools/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!dataManager) {
      return res.status(503).json({
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "DataManager not initialized",
        },
      });
    }

    // Get real tool from DataManager
    const tool = await dataManager.getToolById(id);

    if (!tool) {
      return res.status(404).json({
        error: {
          code: "NOT_FOUND",
          message: `Tool with ID ${id} not found`,
        },
      });
    }

    res.json(tool);
  } catch (error) {
    Logger.error(`Failed to get tool ${req.params.id}`, {
      error: error.message,
    });
    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to retrieve tool details",
        details: error.message,
      },
    });
  }
});

/**
 * GET /api/projects
 * List matrix processing projects
 */
app.get("/api/projects", async (req, res) => {
  try {
    if (!dataManager) {
      return res.status(503).json({
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "DataManager not initialized",
        },
      });
    }

    // Get real projects from DataManager
    const projects = await dataManager.getProjects();

    res.json({
      projects,
      total: projects.length,
    });
  } catch (error) {
    Logger.error("Failed to get projects", { error: error.message });
    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to retrieve projects",
        details: error.message,
      },
    });
  }
});

/**
 * GET /api/analysis/upcoming
 * Get upcoming tool requirements
 */
app.get("/api/analysis/upcoming", async (req, res) => {
  try {
    if (!dataManager) {
      return res.status(503).json({
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "DataManager not initialized",
        },
      });
    }

    // Get real upcoming analysis from DataManager
    const upcomingData = await dataManager.getUpcomingTools();

    res.json({
      ...upcomingData,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    Logger.error("Failed to get upcoming requirements", {
      error: error.message,
    });
    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to retrieve upcoming requirements",
        details: error.message,
      },
    });
  }
});

/**
 * GET /api/tool-images/:manufacturer/:filename
 * Serve tool type images
 */
app.get("/api/tool-images/:manufacturer/:filename", (req, res) => {
  const fs = require("fs");
  const path = require("path");

  try {
    const { manufacturer, filename } = req.params;
    const toolImagesPath = config.getToolImagesPath();
    const imagePath = path.join(toolImagesPath, manufacturer, filename);

    // Check if file exists
    if (!fs.existsSync(imagePath)) {
      Logger.warn(`Tool image not found: ${manufacturer}/${filename}`);
      return res.status(404).json({ error: "Image not found" });
    }

    // Determine content type from extension
    const ext = path.extname(filename).toLowerCase();
    const contentTypes = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".jfif": "image/jpeg",
    };

    const contentType = contentTypes[ext] || "application/octet-stream";

    // Read and serve the file
    const imageBuffer = fs.readFileSync(imagePath);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400"); // Cache for 24 hours
    res.send(imageBuffer);

    Logger.info(`Served tool image: ${manufacturer}/${filename}`);
  } catch (error) {
    Logger.error("Failed to serve tool image", { error: error.message });
    res.status(500).json({ error: "Failed to serve image" });
  }
});

/**
 * POST /api/config
 * Receive configuration from Dashboard and activate backend
 */
app.post("/api/config", async (req, res) => {
  try {
    const { testMode, scanPaths, workingFolder, autoRun = false } = req.body;

    if (typeof testMode !== "boolean") {
      return res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "testMode (boolean) is required",
        },
      });
    }

    // Update configuration
    config.app.testMode = testMode;
    config.app.autoMode = autoRun; // Only activate scanning if explicitly requested

    if (workingFolder) {
      config.app.userDefinedWorkingFolder = workingFolder;
    }

    if (scanPaths?.jsonFiles) {
      config.paths.json = scanPaths.jsonFiles;
    }
    if (scanPaths?.excelFiles) {
      config.paths.excel = scanPaths.excelFiles;
    }

    Logger.info("Configuration updated from Dashboard", {
      testMode,
      autoMode: autoRun,
      workingFolder,
      scanPaths,
    });

    // Start Executor only if autoRun is true
    if (autoRun && !executor) {
      Logger.info("Starting Executor after config update...");
      executor = new Executor(dataManager);
      executor.start().catch((error) => {
        Logger.error("Executor error", { error: error.message });
      });
    }

    res.json({
      success: true,
      message: "Configuration applied successfully",
      config: {
        testMode: config.app.testMode,
        autoMode: config.app.autoMode,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    Logger.error("Failed to apply configuration", { error: error.message });
    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to apply configuration",
        details: error.message,
      },
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: `Route ${req.method} ${req.path} not found`,
    },
  });
});

// Error handler
app.use((err, req, res, next) => {
  Logger.error("Unhandled error", { error: err.message, stack: err.stack });
  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "Internal server error",
      details: process.env.NODE_ENV === "development" ? err.message : undefined,
    },
  });
});

// Start server
async function startServer() {
  try {
    Logger.info("Starting ToolManager API Server...");

    // Try to load unified config and auto-configure
    try {
      const fs = require('fs');
      const path = require('path');
      const unifiedConfigPath = path.join(__dirname, '../../BRK_CNC_CORE/BRK_SETUP_WIZARD_CONFIG.json');
      
      if (fs.existsSync(unifiedConfigPath)) {
        const unifiedConfig = JSON.parse(fs.readFileSync(unifiedConfigPath, 'utf8'));
        Logger.info("✅ Found unified config - auto-configuring from filesystem");
        
        // Apply unified config
        if (unifiedConfig.modules?.matrixTools) {
          const toolConfig = unifiedConfig.modules.matrixTools;
          config.app.testMode = unifiedConfig.demoMode || false;
          config.app.autoMode = toolConfig.mode === 'auto';
          config.app.workingFolder = unifiedConfig.storage?.tempPath || config.app.workingFolder;
          
          Logger.info("📡 Auto-configured from BRK_SETUP_WIZARD_CONFIG.json", {
            testMode: config.app.testMode,
            autoMode: config.app.autoMode,
            dataPath: toolConfig.dataPath
          });
        }
      } else {
        Logger.info("⚠️ No unified config found - using defaults");
      }
    } catch (error) {
      Logger.info("⚠️ Could not load unified config - using defaults", { error: error.message });
    }

    const initialized = await initializeDataManager();
    if (!initialized) {
      Logger.error(
        "Failed to initialize DataManager - server will start but data access will be limited"
      );
    }

    // Start Executor if in auto mode
    if (config.app.autoMode) {
      Logger.info("Starting Executor in AUTO mode...");
      executor = new Executor(dataManager);
      // Don't await - let it run in background
      executor.start().catch((error) => {
        Logger.error("Executor error", { error: error.message });
      });
      Logger.info("Executor started successfully");
    }

    const server = app.listen(PORT, () => {
      Logger.info(
        `🚀 ToolManager API Server running on http://localhost:${PORT}`
      );
      console.log(
        `🚀 ToolManager API Server running on http://localhost:${PORT}`
      );
      console.log(`📊 Mode: ${config.app.testMode ? "TEST" : "PRODUCTION"}`);
      console.log(
        `🔄 Auto-run: ${config.app.autoMode ? "ENABLED" : "DISABLED"}`
      );
      console.log(`📡 API endpoints available at http://localhost:${PORT}/api`);
    });
    
    // Handle port binding errors
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        Logger.error(`❌ Port ${PORT} is already in use. Please stop the conflicting service.`);
        console.error(`❌ Port ${PORT} is already in use. Please stop the conflicting service.`);
        process.exit(1);
      } else {
        Logger.error(`❌ Server error: ${err.message}`);
        console.error(`❌ Server error: ${err.message}`);
        process.exit(1);
      }
    });
  } catch (error) {
    Logger.error("Failed to start server", { error: error.message });
    console.error("❌ Failed to start server:", error.message);
    process.exit(1);
  }
}

// Start if run directly
if (require.main === module) {
  startServer();
}

module.exports = { app, startServer };
