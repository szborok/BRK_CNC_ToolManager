// config.js
const path = require("path");

const config = {
  app: {
    mode: 'auto', // 'test' = test data + manual trigger, 'manual' = production + manual trigger, 'auto' = production + autorun
    useTestPaths: true, // Override to use test-data paths even in auto mode
    scanIntervalMs: 60000, // 60 seconds - same as json_scanner
    logLevel: "info",
    enableDetailedLogging: true,

    // Read-only processing settings (like JSONScanner)
    usePersistentTempFolder: true, // Use organized temp structure
    tempBaseName: "BRK CNC Management Dashboard", // Organized temp folder name
    userDefinedWorkingFolder: path.join(
      __dirname,
      "..",
      "BRK_CNC_CORE",
      "test-data",
      "working_data"
    ), // Default to test-data working folder

    // Test mode temp path - points to centralized BRK_CNC_CORE test-data
    testProcessedDataPath: path.join(
      __dirname,
      "..",
      "BRK_CNC_CORE",
      "test-data",
      "working_data"
    ), // Test mode temp base path
  },
  storage: {
    type: process.env.STORAGE_TYPE || "auto", // 'auto', 'local', 'mongodb'
    retentionPolicy: {
      backupDays: null, // No auto cleanup for ToolManager
      cleanupOldData: false, // Don't auto-delete tool data
    },
  },
  mongodb: {
    uri: process.env.MONGODB_URI || "mongodb://localhost:27017",
    database: process.env.MONGODB_DATABASE || "cnc_tools", // ToolManager database
    options: {
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    },
  },
  processing: {
    preventReprocessing: true,
    moveAfterProcessing: true,
    generateReports: true,
  },
  scheduling: {
    // Mode for determining job completion dates
    // Options: "estimated", "json_embedded", "schedule_file"
    completionDateMode: "estimated",

    // Days to add to creation date when using "estimated" mode
    estimatedCompletionDays: 5,

    // Fallback to estimated mode if other modes fail
    fallbackToEstimated: true,
  },
  files: {
    jsonExtension: ".json",
    fixedSuffix: "BRK_fixed",
    resultSuffix: "BRK_result",
  },
  paths: {
    // Shared resources (used by both test and production)
    toolImagesPath: path.join(__dirname, "..", "BRK_CNC_CORE", "train-data", "tool_images"),

    test: {
  // Read-only test case folders (DO NOT MODIFY) - uses centralized BRK_CNC_CORE test-data
  testDataPath: path.join(__dirname, "..", "BRK_CNC_CORE", "test-data", "source_data"),

      // Sample Excel files for development - to identify monitored tools
      sampleExcelPath: path.join(
        __dirname,
        "..",
        "BRK_CNC_CORE",
        "train-data",
        "matrix_tools"
      ),

      // All processing happens in BRK temp structure - no separate working directories needed

      // JSON files from CNC machines (from centralized test data)
      jsonScanPath: path.join(
        __dirname,
        "..",
        "BRK_CNC_CORE",
        "test-data",
        "source_data",
        "json_files"
      ),

      // Excel files directory (scan for any Excel files here in test mode)
      excelScanPath: path.join(
        __dirname,
        "..",
        "BRK_CNC_CORE",
        "train-data",
        "matrix_tools"
      ),

      // Configuration files (schedule file can be in test_source_data if needed)
      scheduleFile: path.join(
        __dirname,
        "..",
        "BRK_CNC_CORE",
        "test-data",
        "source_data",
        "schedules",
        "production_schedule.json"
      ),
    },
    production: {
      // Excel files directory (scan for Excel files in production)
      excelScanPath: "C:\\Production\\Matrix",

      // JSON files from CNC machines (production path - root of JSON nest)
      jsonScanPath: "C:\\Production\\CNC_Data",
      scheduleFile: "C:\\Production\\Schedules\\production_schedule.json",

      // All processing happens in BRK temp structure: C:/Production/BRK CNC Management Dashboard/ToolManager/
    },
  },
};

// Backward compatibility helpers
Object.defineProperty(config.app, 'testMode', {
  get() { return this.mode === 'test'; },
  set(val) { this.mode = val ? 'test' : (this.mode === 'manual' ? 'manual' : 'auto'); }
});

Object.defineProperty(config.app, 'autoMode', {
  get() { return this.mode === 'auto'; },
  set(val) { this.mode = val ? 'auto' : 'manual'; }
});

config.getScanPath = function () {
  // Returns JSON scan path since that's what we actually scan for data
  return this.getJsonScanPath();
};

config.getExcelScanPath = function () {
  const useTest = this.app.mode === 'test' || this.app.useTestPaths;
  return useTest ? this.paths.test.excelScanPath : this.paths.production.excelScanPath;
};

config.getSampleExcelPath = function () {
  // Only available in test mode - for development reference
  const useTest = this.app.mode === 'test' || this.app.useTestPaths;
  return useTest ? this.paths.test.sampleExcelPath : null;
};

config.getJsonScanPath = function () {
  const useTest = this.app.mode === 'test' || this.app.useTestPaths;
  return useTest ? this.paths.test.jsonScanPath : this.paths.production.jsonScanPath;
};

config.getScheduleFilePath = function () {
  const useTest = this.app.mode === 'test' || this.app.useTestPaths;
  return useTest ? this.paths.test.scheduleFile : this.paths.production.scheduleFile;
};

config.getCompletionDate = function (creationDate, projectData = null) {
  const createdDate = new Date(creationDate);

  switch (this.scheduling.completionDateMode) {
    case "json_embedded":
      // Try to extract completion date from JSON data
      if (projectData && projectData.completionDate) {
        return new Date(projectData.completionDate);
      }
      // Fall through to fallback if enabled
      if (this.scheduling.fallbackToEstimated) {
        return this.calculateEstimatedDate(createdDate);
      }
      return null;

    case "schedule_file":
      // Try to get date from external schedule file
      const scheduledDate = this.getScheduledDate(projectData);
      if (scheduledDate) {
        return scheduledDate;
      }
      // Fall through to fallback if enabled
      if (this.scheduling.fallbackToEstimated) {
        return this.calculateEstimatedDate(createdDate);
      }
      return null;

    case "estimated":
    default:
      return this.calculateEstimatedDate(createdDate);
  }
};

config.calculateEstimatedDate = function (creationDate) {
  const estimatedDate = new Date(creationDate);
  estimatedDate.setDate(
    estimatedDate.getDate() + this.scheduling.estimatedCompletionDays
  );
  return estimatedDate;
};

config.getScheduledDate = function (projectData) {
  // TODO: Implement schedule file reading logic
  // This would read from the schedule file and match project data
  // For now, return null to fall back to estimated mode
  return null;
};

config.initialize = function () {
  console.log("✓ ToolManager configuration initialized");
  console.log(
    `✓ Mode: ${this.app.testMode ? "TEST" : "PRODUCTION"} - ${
      this.app.autoMode ? "AUTO" : "MANUAL"
    }`
  );
  console.log(`✓ Scan interval: ${this.app.scanIntervalMs / 1000} seconds`);
  console.log(`✓ JSON scan path: ${this.getJsonScanPath()}`);
  console.log(`✓ Excel scan path: ${this.getExcelScanPath()}`);
  if (this.app.testMode && this.getSampleExcelPath()) {
    console.log(`✓ Sample Excel path: ${this.getSampleExcelPath()}`);
  }
  console.log(`✓ Completion date mode: ${this.scheduling.completionDateMode}`);
  if (this.scheduling.completionDateMode === "estimated") {
    console.log(
      `✓ Estimated completion days: ${this.scheduling.estimatedCompletionDays}`
    );
  }

  // Note about test mode
  if (this.app.testMode) {
    console.log(
      "📁 Reading JSON from json_scanner test data, Matrix Excel from test_data/"
    );
  }
};

module.exports = config;
