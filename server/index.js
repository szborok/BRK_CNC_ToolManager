// server/index.js
/**
 * ToolManager REST API Server
 *
 * Provides RESTful endpoints for CNC tool inventory management and matrix processing.
 */

const express = require("express");
const cors = require("cors");
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
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
  Logger.info(`${req.method} ${req.path} [${req.ip}]`);
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
    const errMsg = error && error['message'] || 'Unknown error';
    Logger.error(`Failed to initialize DataManager: ${errMsg}`);
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
    const errMsg = error && error['message'] || 'Unknown error';
    Logger.error(`Failed to get tools: ${errMsg}`);
    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to retrieve tools",
        details: errMsg,
      },
    });
  }
});

/**
 * GET /api/tool-images/:manufacturer/:filename
 * Serve tool type images - tries multiple extensions if exact match not found
 */
app.get("/api/tool-images/:manufacturer/:filename", (req, res) => {
  try {
    const { manufacturer, filename } = req.params;
    const toolImagesPath = config.getToolImagesPath();
    
    // Strip extension from filename to get base name
    const baseFilename = filename.replace(/\.[^.]+$/, '');
    
    // Extensions to try in order
    const extensions = ['.JPG', '.jpg', '.jfif', '.gif', '.png', '.jpeg'];
    
    // Try with provided filename first
    let imagePath = path.join(toolImagesPath, manufacturer, filename);
    let foundPath = null;
    
    if (fsSync.existsSync(imagePath)) {
      foundPath = imagePath;
    } else {
      // Try different extensions
      for (const ext of extensions) {
        imagePath = path.join(toolImagesPath, manufacturer, baseFilename + ext);
        if (fsSync.existsSync(imagePath)) {
          foundPath = imagePath;
          break;
        }
      }
    }

    if (!foundPath) {
      Logger.warn(`Tool image not found: ${manufacturer}/${filename}`);
      return res.status(404).json({ error: "Image not found" });
    }

    // Determine content type from extension
    const ext = path.extname(foundPath).toLowerCase();
    const contentTypes = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".jfif": "image/jpeg",
    };

    const contentType = contentTypes[ext] || "application/octet-stream";

    // Read and serve the file
    const imageBuffer = fsSync.readFileSync(foundPath);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400"); // Cache for 24 hours
    res.send(imageBuffer);

    Logger.info(`Served tool image: ${manufacturer}/${path.basename(foundPath)}`);
  } catch (error) {
    const errMsg = error && error['message'] || 'Unknown error';
    Logger.error(`Failed to serve tool image: ${errMsg}`);
    res.status(500).json({ error: "Failed to serve image" });
  }
});

/**
 * GET /api/tools/matrix
 * Get matrix tools with inventory information for dashboard display
 * NOTE: Must be defined BEFORE /api/tools/:id to avoid route collision
 */
app.get("/api/tools/matrix", async (req, res) => {
  try {
    if (!dataManager) {
      return res.status(503).json({
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "DataManager not initialized",
        },
      });
    }

    // Read matrix inventory from Excel processing results
    const resultsPath = dataManager.resultsPath;
    const excelResultPath = path.join(resultsPath, "excel_processing_result.json");
    
    let matrixTools = [];
    
    try {
      const fileContents = await fs.readFile(excelResultPath, "utf8");
      const excelData = JSON.parse(fileContents);
      const toolInventory = excelData.toolInventory || [];
      
      // Load matrix tool definitions to filter by learned categories
      const definitionsPath = path.join(__dirname, '../config/matrix-tool-definitions.json');
      let matrixCodePatterns = ['8400', '8410', '8420', '8201', '8211', '8221', '1525', '8521', '7620', '7624'];
      let baseDiameters = {};
      
      if (fsSync.existsSync(definitionsPath)) {
        try {
          const definitions = JSON.parse(fsSync.readFileSync(definitionsPath, 'utf8'));
          matrixCodePatterns = [];
          
          // Build lookup map from categories->tools array
          for (const category of Object.values(definitions.categories || {})) {
            matrixCodePatterns.push(...(category.codePatterns || []));
            
            // Index tools by their toolCode for fast lookup
            if (category.tools && Array.isArray(category.tools)) {
              category.tools.forEach(tool => {
                baseDiameters[tool.toolCode] = {
                  diameter: tool.diameter,
                  toolLife: tool.toolLife,
                  codePrefix: tool.codePrefix
                };
              });
            }
          }
        } catch (err) {
          Logger.warn(`Could not load matrix definitions: ${err && err['message'] || 'Unknown error'}`);
        }
      }
      
      // Function to get tool data from configuration
      const getToolData = (toolCode) => {
        if (!toolCode) return { diameter: 0, toolLife: 0, codePrefix: '' };
        
        // Look up exact tool code first (handles variants like _1, _2)
        if (baseDiameters[toolCode]) {
          return {
            diameter: baseDiameters[toolCode].diameter || 0,
            toolLife: baseDiameters[toolCode].toolLife || 0,
            codePrefix: baseDiameters[toolCode].codePrefix || ''
          };
        }
        
        // Fallback to base code (without suffix)
        const baseCode = toolCode.split('_')[0];
        if (baseDiameters[baseCode]) {
          return {
            diameter: baseDiameters[baseCode].diameter || 0,
            toolLife: baseDiameters[baseCode].toolLife || 0,
            codePrefix: baseDiameters[baseCode].codePrefix || ''
          };
        }
        
        return { diameter: 0, toolLife: 0, codePrefix: '' };
      };
      
      // Filter to only show matrix tools (matching learned patterns)
      const filteredTools = toolInventory.filter(tool => {
        const code = tool.toolCode || '';
        return matrixCodePatterns.some(pattern => code.includes(pattern));
      });
      
      Logger.info(`📦 Loaded ${toolInventory.length} tools from Excel, filtered to ${filteredTools.length} matrix tools (ECUT/MFC/XF/XFEED)`);
      
      // Function to get family code and image URL
      const getImageUrl = (toolCode) => {
        if (!toolCode) return null;
        
        // Extract family code: remove RT- prefix and last 3 digits (diameter code)
        // Examples: RT-8400300 -> 8400, RT-15250391 -> 15250, RT-X7620300 -> 7620
        let cleaned = toolCode.replace('RT-', '').split('_')[0]; // Remove RT- and variant suffix
        
        // Handle XFEED tools (RT-X7620300): remove the X prefix
        if (cleaned.startsWith('X')) {
          cleaned = cleaned.substring(1);
        }
        
        // For 4-digit codes: 8400, 8201, etc. -> family is first 4 digits
        // For 5-digit codes: 15250, 15251 -> family is first 5 digits (all digits minus last 3)
        let familyCode;
        if (cleaned.length >= 6) {
          // 5-digit family + 3-digit diameter (e.g., 15250300)
          familyCode = cleaned.slice(0, -3);
        } else {
          // 4-digit family code (e.g., 8400, 7620)
          familyCode = cleaned.slice(0, 4);
        }
        
        return `/api/images/tools/${familyCode}.png`;
      };
      
      // Transform Excel inventory to dashboard format
      matrixTools = filteredTools.map(tool => {
        const quantity = tool.quantity || 0;
        const warningThreshold = Math.max(3, Math.floor(quantity * 0.3));
        
        // Determine category from tool code
        const code = tool.toolCode || '';
        let category = 'OTHER';
        if (code.includes('8400') || code.includes('8410') || code.includes('8420')) category = 'ECUT';
        else if (code.includes('8201') || code.includes('8211') || code.includes('8221')) category = 'MFC';
        else if (code.includes('1525') || code.includes('8521')) category = 'XF';
        else if (code.includes('7620') || code.includes('7624')) category = 'XFEED';
        
        // Get tool data from configuration (includes codePrefix from JSON)
        const data = getToolData(tool.toolCode);
        
        return {
          toolId: tool.toolCode,
          diameter: data.diameter,
          toolLife: data.toolLife,
          toolType: category,
          category: category,
          codePrefix: data.codePrefix,
          setupTime: 0, // Not available in Excel data
          inPool: quantity,
          warningThreshold: warningThreshold,
          imageUrl: getImageUrl(tool.toolCode)
        };
      });
    } catch (error) {
      const errMsg = error && error['message'] || 'Unknown error';
      Logger.warn(`Could not read Excel processing results: ${errMsg}`);
      // Fallback: try to get from tools array (will have usage but no inventory)
      const tools = await dataManager.getAllTools({ isMatrix: true });
      matrixTools = tools.map(tool => ({
        toolId: tool.id,
        diameter: 0,
        toolType: tool.name || "Unknown",
        setupTime: 0,
        inPool: 0,
        warningThreshold: 3,
        imageUrl: null
      }));
    }

    Logger.info(`📊 Returning ${matrixTools.length} matrix tools to Dashboard`);

    res.json({
      tools: matrixTools,
      total: matrixTools.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    const errMsg = error && error['message'] || 'Unknown error';
    Logger.error(`Failed to get matrix tools: ${errMsg}`);
    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to retrieve matrix tools",
        details: errMsg,
      },
    });
  }
});

/**
 * GET /api/tools/matrix/usage
 * Get matrix tools with usage time from JSON files
 */
app.get("/api/tools/matrix/usage", async (req, res) => {
  try {
    if (!dataManager) {
      return res.status(503).json({
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "DataManager not initialized",
        },
      });
    }

    // Get matrix tools with inventory
    const matrixResponse = await fetch("http://localhost:3002/api/tools/matrix");
    if (!matrixResponse.ok) {
      throw new Error("Failed to fetch matrix tools");
    }
    const matrixData = await matrixResponse.json();
    const matrixTools = matrixData.tools || [];

    // Get all tool usage data from processed JSON files
    const allTools = await dataManager.getAllTools({ isMatrix: true });
    
    // Build usage map by extracting matrix code patterns from tool IDs
    // Matrix tools from Excel: RT-8201300 (code pattern: 8201)
    // Processed tools from JSON: FRA-P8201-S15.2R0_H100W16L100X (code pattern: 8201)
    const usageMap = {};
    
    for (const tool of allTools) {
      const usageMinutes = tool.usageMinutes || tool.runningTime || 0;
      if (usageMinutes > 0) {
        // Extract matrix code pattern from tool ID
        // Look for patterns like P8201, P8400, P15250, etc.
        const match = tool.id.match(/P(\d{4,5})/);
        if (match) {
          const codePattern = match[1]; // e.g., "8201", "8400", "15250"
          usageMap[codePattern] = (usageMap[codePattern] || 0) + usageMinutes;
        }
      }
    }

    // Merge usage data with inventory data by matching code patterns
    const toolsWithUsage = matrixTools.map(tool => {
      // Extract code pattern from matrix tool ID (RT-8201300 -> 8201)
      let codePattern = '';
      if (tool.codePrefix) {
        codePattern = tool.codePrefix;
      } else {
        const match = tool.toolId.match(/RT-([X]?)(\d{4,5})/);
        if (match) {
          codePattern = match[2];
        }
      }
      
      return {
        ...tool,
        usageMinutes: usageMap[codePattern] || 0
      };
    });

    Logger.info(`📊 Returning ${toolsWithUsage.length} matrix tools with usage data`);

    res.json({
      tools: toolsWithUsage,
      total: toolsWithUsage.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    const errMsg = error && error['message'] || 'Unknown error';
    Logger.error(`Failed to get matrix tool usage: ${errMsg}`);
    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to retrieve matrix tool usage",
        details: errMsg,
      },
    });
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
    const errMsg = error && error['message'] || 'Unknown error';
    Logger.error(`Failed to get tool ${req.params.id}: ${errMsg}`);
    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to retrieve tool details",
        details: errMsg,
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
    const errMsg = error && error['message'] || 'Unknown error';
    Logger.error(`Failed to get projects: ${errMsg}`);
    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to retrieve projects",
        details: errMsg,
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
    const errMsg = error && error['message'] || 'Unknown error';
    Logger.error(`Failed to get upcoming requirements: ${errMsg}`);
    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to retrieve upcoming requirements",
        details: errMsg,
      },
    });
  }
});

/**
 * POST /api/scan
 * Simple endpoint for AutoRunProcessor to trigger tool scan
 */
app.post("/api/scan", async (req, res) => {
  try {
    if (!executor) {
      executor = new Executor(dataManager);
    }

    const result = await executor.processFiles();
    
    // Get tool count from DataManager
    const tools = await dataManager.getAllTools();
    const toolCount = tools.length;

    res.json({
      success: true,
      message: `${toolCount} tools scanned`,
      toolCount
    });
  } catch (error) {
    const errMsg = error && error['message'] || 'Unknown error';
    Logger.error(`Tool scan failed: ${errMsg}`);
    res.status(500).json({
      error: {
        code: "SCAN_FAILED",
        message: errMsg
      }
    });
  }
});

/**
 * POST /api/trigger-scan
 * Trigger a scan cycle (called by JSONScanner when new files found)
 * BLOCKS until processing completes to ensure sequential execution
 */
app.post("/api/trigger-scan", async (req, res) => {
  try {
    Logger.info("📡 Received trigger from JSONScanner - starting tool analysis...");

    // Process synchronously and wait for completion
    if (!executor) {
      executor = new Executor(dataManager);
    }

    // Process files without exiting
    await executor.processFiles();
    
    Logger.info(`✅ Tool analysis completed`);

    // Send response AFTER processing completes
    res.json({
      success: true,
      message: "Tool analysis scan completed",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const errMsg = error && error['message'] || 'Unknown error';
    Logger.error(`Failed to trigger tool analysis: ${errMsg}`);
    res.status(500).json({
      error: {
        code: "TRIGGER_ERROR",
        message: "Failed to trigger tool analysis",
        details: errMsg,
      },
    });
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

    Logger.info(`Configuration updated from Dashboard: testMode=${testMode}, autoMode=${autoRun}, workingFolder=${workingFolder}, scanPaths=${scanPaths?.length || 0}`);

    // Start or stop Executor based on autoRun
    if (autoRun && !executor) {
      Logger.info("Starting Executor after config update...");
      executor = new Executor(dataManager);
      executor.start().catch((error) => {
        const errMsg = error && error['message'] || 'Unknown error';
        Logger.error(`Executor error: ${errMsg}`);
      });
    } else if (!autoRun && executor) {
      Logger.info("Stopping Executor (manual mode enabled)...");
      await executor.stop();
      executor = null;
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
    const errMsg = error && error['message'] || 'Unknown error';
    Logger.error(`Failed to apply configuration: ${errMsg}`);
    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to apply configuration",
        details: errMsg,
      },
    });
  }
});

// 404 handler
// ===== STATIC FILE SERVING =====
// MUST come BEFORE 404 handler
const toolImagesPath = path.join(__dirname, '../../BRK_CNC_CORE/assets/tool_images_new/FRA');
app.use('/api/images/tools', express.static(toolImagesPath));
Logger.info(`📷 Serving tool images from: ${toolImagesPath}`);

// 404 handler (must be after all routes and static middleware)
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
  const errMsg = err && err['message'] || 'Unknown error';
  const errStack = err && err['stack'] || '';
  Logger.error(`Unhandled error: ${errMsg} ${errStack}`);
  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "Internal server error",
      details: process.env.NODE_ENV === "development" ? errMsg : undefined,
    },
  });
});

// Start server
async function startServer() {
  try {
    Logger.info("Starting ToolManager API Server...");

    // Try to load unified config and auto-configure
    try {
      const unifiedConfigPath = path.join(__dirname, '../../BRK_CNC_CORE/BRK_SETUP_WIZARD_CONFIG.json');
      
      if (fsSync.existsSync(unifiedConfigPath)) {
        const unifiedConfig = JSON.parse(fsSync.readFileSync(unifiedConfigPath, 'utf8'));
        Logger.info("✅ Found unified config - auto-configuring from filesystem");
        
        // Apply unified config
        if (unifiedConfig.modules?.matrixTools) {
          const toolConfig = unifiedConfig.modules.matrixTools;
          config.app.testMode = unifiedConfig.demoMode || false;
          config.app.autoMode = toolConfig.mode === 'auto';
          config.app.workingFolder = unifiedConfig.storage?.tempPath || config.app.workingFolder;
          
          Logger.info(`📡 Auto-configured from BRK_SETUP_WIZARD_CONFIG.json: testMode=${config.app.testMode}, autoMode=${config.app.autoMode}, dataPath=${toolConfig.dataPath}`);
        }
      } else {
        Logger.info("⚠️ No unified config found - using defaults");
      }
    } catch (error) {
      const errMsg = error && error['message'] || 'Unknown error';
      Logger.info(`⚠️ Could not load unified config - using defaults: ${errMsg}`);
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
        const errMsg = error && error['message'] || 'Unknown error';
        Logger.error(`Executor error: ${errMsg}`);
      });
      Logger.info("Executor started successfully");
    }

    // Static image middleware moved to line 622 (before 404 handler)

    const server = app.listen(PORT, () => {
      console.log(`API Server running on http://localhost:${PORT}`);
    });
    
    // Handle port binding errors
    server.on('error', (err) => {
      if (err && err['code'] === 'EADDRINUSE') {
        Logger.error(`❌ Port ${PORT} is already in use. Please stop the conflicting service.`);
        process.exit(1);
      } else {
        const errMsg = err && err['message'] || 'Unknown error';
        Logger.error(`❌ Server error: ${errMsg}`);
        process.exit(1);
      }
    });
  } catch (error) {
    const errMsg = error && error['message'] || 'Unknown error';
    Logger.error(`Failed to start server: ${errMsg}`);
    process.exit(1);
  }
}

// Start if run directly
if (require.main === module) {
  startServer();
}

module.exports = { app, startServer };
