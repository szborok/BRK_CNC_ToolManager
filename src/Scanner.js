// path: src/Scanner.js
/**
 * Handles automatic or manual scanning of Excel files (tool inventory)
 * and JSON files (tool usage data - same logic as json_scanner).
 */

const fs = require("fs");
const path = require("path");
const config = require("../config");
const Logger = require("../utils/Logger");
const { getDirectories } = require("../utils/FileUtils");
const Project = require("./Project");
const TempFileManager = require("../utils/TempFileManager");

class Scanner {
  constructor() {
    this.projects = [];
    this.running = false;
    this.tempManager = new TempFileManager("ToolManager");
  }

  /**
   * Start the scanner.
   * In AUTO mode, the Executor will control scanning.
   * In MANUAL mode, this enables manual scanning capability.
   */
  start() {
    this.running = true;
    Logger.info(
      `Scanner started in ${config.app.autoMode ? "AUTO" : "MANUAL"} mode`
    );
  }

  /**
   * Stop scanning after the current cycle.
   * In test mode, preserve temp data for inspection.
   */
  stop() {
    this.running = false;
    Logger.warn("Scanner stopped after finishing current project.");

    // Don't clean up in persistent folder mode or test mode
    if (config.app.usePersistentTempFolder) {
      Logger.info("📁 Persistent temp folder mode: Preserving data for reuse");
    } else if (config.app.testMode) {
      Logger.info("🧪 Test mode: Preserving temp data for inspection");
    } else {
      // Production mode with non-persistent folders can clean up
      if (this.tempManager && typeof this.tempManager.cleanup === "function") {
        this.tempManager.cleanup();
      }
    }
  }

  /**
   * Perform one scan for JSON projects (same structure as json_scanner).
   * Each project folder contains positions with JSON files for tool usage analysis.
   * @param {string} customPath - Custom path for manual mode (optional)
   */
  /**
   * Performs a single scan iteration following the defined workflow:
   * 1. Process ONE Excel file and save results
   * 2. Find ALL JSON files
   * 3. Copy ALL JSON files to temp folder
   * 4. Fix/sanitize ALL JSON files
   * 5. Process ALL sanitized JSON files
   * 6. Generate consolidated report
   * 7. Clean temp folder
   * @param {string} customPath - Custom path for manual mode (optional)
   */
  async performScan(customPath = null) {
    try {
      // Get the JSON scan path (this is what we actually scan)
      const jsonScanPath = customPath || config.getJsonScanPath();

      if (!jsonScanPath) {
        Logger.error("No JSON scan path available.");
        return [];
      }

      Logger.info(`🔍 Scanning for tool usage analysis: ${jsonScanPath}`);

      // Step 1 & 2: Find and process ONE Excel file, save results
      const excelData = await this.processExcelFile();

      // Step 3: Find ALL JSON files for tool usage analysis
      const allJsonFiles = this.findAllJsonFiles(jsonScanPath);
      Logger.info(
        `🔍 Found ${allJsonFiles.length} JSON file(s) for tool usage analysis.`
      );

      if (allJsonFiles.length === 0) {
        Logger.info(`📭 No JSON files found in this scan`);
        return [];
      }

      // Step 4: Copy ALL JSON files to temp folder
      const tempJsonFiles = await this.copyJsonFilesToTemp(allJsonFiles);
      Logger.info(
        `📁 Copied ${tempJsonFiles.length} JSON file(s) to temp folder`
      );

      // Step 5: Fix/sanitize ALL JSON files in temp folder
      const sanitizedFiles = await this.sanitizeAllJsonFiles(tempJsonFiles);
      Logger.info(`🔧 Sanitized ${sanitizedFiles.length} JSON file(s)`);

      // Step 6: Process ALL sanitized JSON files
      const processedData = await this.processAllJsonFiles(sanitizedFiles);
      Logger.info(
        `📊 Processed ${processedData.length} JSON file(s) for tool usage data`
      );

      // Step 7: Generate consolidated report
      await this.generateConsolidatedReport(excelData, processedData);
      Logger.info(`📄 Generated consolidated report`);

      // Step 8: Clean temp folder (only in production mode without persistent folders)
      if (!config.app.testMode && !config.app.usePersistentTempFolder) {
        await this.cleanTempFolder();
        Logger.info(`🧹 Cleaned temp folder`);
      } else if (config.app.usePersistentTempFolder) {
        Logger.info(`📁 Persistent temp folder mode: Preserving data for reuse`);
      } else {
        Logger.info(`🧪 Test mode: Preserving temp data for inspection`);
      }

      Logger.info(
        `Successfully processed ${allJsonFiles.length} JSON file(s) for tool usage analysis.`
      );
      return processedData;
    } catch (err) {
      Logger.error(`Scanner failed: ${err.message}`);
      // Clean temp folder on error (only in production mode without persistent folders)
      if (!config.app.testMode && !config.app.usePersistentTempFolder) {
        try {
          await this.cleanTempFolder();
        } catch (cleanupErr) {
          Logger.error(`Failed to cleanup temp folder: ${cleanupErr.message}`);
        }
      } else {
        Logger.info(
          `🧪 Preserving temp data despite error for inspection (${config.app.usePersistentTempFolder ? 'persistent mode' : 'test mode'})`
        );
      }
      return [];
    }
  }

  /**
   * Group JSON files by their project folders (same logic as json_scanner)
   */
  groupJsonFilesByProject(allJsonFiles) {
    const projectFolders = new Map();

    for (const jsonFile of allJsonFiles) {
      // Use the project name from extractProjectInfoFromPath (already calculated correctly)
      const projectName = jsonFile.projectName; // This should be the project base (e.g., W5270NS01003)
      const machineFolder = jsonFile.directory; // Directory containing the JSON file (machine folder)
      const positionPath = path.dirname(machineFolder); // Position folder (e.g., W5270NS01001A)
      const projectPath = path.dirname(positionPath); // Project folder (e.g., W5270NS01001)

      if (!projectFolders.has(projectName)) {
        projectFolders.set(projectName, {
          name: projectName,
          path: projectPath,
          positions: [],
          jsonFiles: [],
        });
      }

      const projectFolder = projectFolders.get(projectName);
      projectFolder.positions.push(
        jsonFile.positionName || path.basename(positionPath)
      );
      projectFolder.jsonFiles.push(jsonFile);
    }

    return Array.from(projectFolders.values());
  }

  /**
   * Returns all discovered projects.
   */
  getProjects() {
    return this.projects;
  }

  /**
   * Recursively finds all JSON files in the given directory tree.
   * Same logic as json_scanner for tool usage data extraction.
   * @param {string} rootPath - Root directory to start searching
   * @returns {Array} - Array of JSON file objects with metadata
   */
  findAllJsonFiles(rootPath) {
    const jsonFiles = [];

    if (!fs.existsSync(rootPath)) {
      Logger.warn(`JSON scan path does not exist: ${rootPath}`);
      return jsonFiles;
    }

    const scanDirectory = (dirPath) => {
      try {
        const items = fs.readdirSync(dirPath, { withFileTypes: true });

        for (const item of items) {
          const fullPath = path.join(dirPath, item.name);

          if (item.isDirectory()) {
            // Recursively scan subdirectories
            scanDirectory(fullPath);
          } else if (item.isFile() && item.name.endsWith(".json")) {
            // Skip generated files (_fixed, _result suffixes)
            if (
              item.name.includes("_fixed") ||
              item.name.includes("_result")
            ) {
              continue;
            }

            // Extract project information from filename and path
            const fileInfo = this.extractProjectInfoFromPath(
              fullPath,
              item.name
            );
            if (fileInfo) {
              jsonFiles.push(fileInfo);
            }
          }
        }
      } catch (err) {
        Logger.warn(`Cannot scan directory ${dirPath}: ${err.message}`);
      }
    };

    scanDirectory(rootPath);
    return jsonFiles;
  }

  /**
   * Extracts project information from JSON file path and name.
   * Same logic as json_scanner for tool usage data extraction.
   * @param {string} fullPath - Full path to the JSON file
   * @param {string} fileName - Name of the JSON file
   * @returns {Object|null} - Project info object or null if not a valid project file
   */
  extractProjectInfoFromPath(fullPath, fileName) {
    // Match project pattern: W5270NS01003A.json or BRK_W5270NS01003A.json
    const cleanFileName = fileName.replace(/^BRK_/, '');
    const projectMatch = cleanFileName.match(
      /^(W\d{4}[A-Z]{2}\d{2,})([A-Z]+)\.json$/
    );

    if (projectMatch) {
      const projectBase = projectMatch[1]; // W5270NS01003
      const position = projectMatch[2] || "A"; // A, B, C, etc. (default to A if not specified)
      const positionName = projectBase + position; // W5270NS01003A

      return {
        fullPath: fullPath,
        fileName: fileName,
        projectBase: projectBase,
        projectName: projectBase, // Use project base for grouping, not position name
        positionName: positionName, // Full position name for reference
        position: position,
        directory: path.dirname(fullPath),
      };
    }

    return null;
  }

  /**
   * Recursively finds all Excel files in the given directory tree.
   * @param {string} rootPath - Root directory to start searching
   * @returns {Array} - Array of Excel file objects with metadata
   */
  findAllExcelFiles(rootPath) {
    const excelFiles = [];

    if (!fs.existsSync(rootPath)) {
      Logger.warn(`Excel scan path does not exist: ${rootPath}`);
      return excelFiles;
    }

    const searchDirectory = (dirPath) => {
      try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dirPath, entry.name);

          if (entry.isDirectory()) {
            // Recursively search subdirectories
            searchDirectory(fullPath);
          } else if (entry.isFile() && this.isExcelFile(entry.name)) {
            excelFiles.push({
              fullPath: fullPath,
              fileName: entry.name,
              directory: dirPath,
            });
          }
        }
      } catch (err) {
        Logger.warn(`Cannot read directory ${dirPath}: ${err.message}`);
      }
    };

    searchDirectory(rootPath);
    return excelFiles;
  }

  /**
   * Check if a file is an Excel file based on extension.
   * @param {string} fileName - Name of the file
   * @returns {boolean} - True if file is Excel format
   */
  isExcelFile(fileName) {
    const extension = path.extname(fileName).toLowerCase();
    return [".xlsx", ".xls", ".xlsm"].includes(extension);
  }

  // ============ NEW WORKFLOW METHODS ============

  /**
   * Step 1 & 2: Find and process ALL Excel files (matrix inventory), save consolidated results
   */
  async processExcelFile() {
    const excelScanPath = config.getExcelScanPath();
    const excelFiles = this.findAllExcelFiles(excelScanPath);

    if (excelFiles.length === 0) {
      Logger.warn(`📭 No Excel files found in: ${excelScanPath}`);
      return null;
    }

    Logger.info(`📊 Processing ${excelFiles.length} Excel file(s) for matrix inventory`);

    try {
      const ExcelProcessor = require("./ExcelProcessor");
      const consolidatedInventory = new Map(); // Use Map to combine duplicate tool codes
      const processedFiles = [];

      // Process ALL Excel files
      for (const excelFile of excelFiles) {
        try {
          Logger.info(`  � Processing: ${excelFile.fileName}`);
          
          // Copy Excel file to organized temp structure first
          const tempExcelPath = await this.tempManager.copyToTemp(
            excelFile.fullPath,
            "excel_files"
          );

          // Use ExcelProcessor to read actual Excel data from temp copy
          const excelData = await ExcelProcessor.processMainExcel(tempExcelPath);

          // Check if processing was successful
          if (!excelData.success) {
            Logger.error(`    ✗ Excel processing failed: ${excelData.error}`);
            processedFiles.push({
              fileName: excelFile.fileName,
              toolCount: 0,
              error: excelData.error
            });
            continue;
          }

          // Accumulate tool inventory from this file
          if (excelData.toolInventory) {
            for (const [toolCode, quantity] of Object.entries(excelData.toolInventory)) {
              if (consolidatedInventory.has(toolCode)) {
                consolidatedInventory.set(toolCode, consolidatedInventory.get(toolCode) + quantity);
              } else {
                consolidatedInventory.set(toolCode, quantity);
              }
            }
          }

          processedFiles.push({
            fileName: excelFile.fileName,
            toolCount: Object.keys(excelData.toolInventory || {}).length
          });

          Logger.info(`    ✓ ${Object.keys(excelData.toolInventory || {}).length} tools extracted`);
        } catch (fileErr) {
          Logger.error(`    ✗ Failed to process ${excelFile.fileName}: ${fileErr.message}`);
        }
      }

      // Convert consolidated Map to array format
      const toolInventoryArray = [];
      for (const [toolCode, quantity] of consolidatedInventory.entries()) {
        toolInventoryArray.push({
          toolCode: toolCode,
          description: "", // ExcelProcessor doesn't extract descriptions yet
          quantity: quantity,
        });
      }

      const result = {
        processedAt: new Date().toISOString(),
        filesProcessed: processedFiles,
        totalFiles: excelFiles.length,
        toolInventory: toolInventoryArray,
        totalUniqueTools: toolInventoryArray.length,
        totalQuantity: Array.from(consolidatedInventory.values()).reduce((sum, qty) => sum + qty, 0)
      };

      // Save consolidated Excel processing results to organized temp structure
      await this.tempManager.saveToTemp(
        "excel_processing_result.json",
        JSON.stringify(result, null, 2),
        "results"
      );

      Logger.info(
        `💾 Consolidated matrix inventory saved: ${result.totalUniqueTools} unique tools, ${result.totalQuantity} total quantity`
      );
      return result;
    } catch (err) {
      Logger.error(`Failed to process Excel files: ${err.message}`);

      // Return placeholder data on error
      const result = {
        processedAt: new Date().toISOString(),
        toolInventory: [],
        error: err.message,
      };

      return result;
    }
  }

  /**
   * Step 4: Copy ALL JSON files to temp folder using organized structure
   */
  async copyJsonFilesToTemp(allJsonFiles) {
    const tempFiles = [];

    for (const jsonFile of allJsonFiles) {
      try {
        // Copy using organized temp structure
        const tempPath = await this.tempManager.copyToTemp(
          jsonFile.fullPath,
          "input_files"
        );

        tempFiles.push({
          originalPath: jsonFile.fullPath,
          tempPath: tempPath,
          fileName: path.basename(jsonFile.fullPath),
          projectInfo: jsonFile,
        });
      } catch (err) {
        Logger.error(
          `Failed to copy ${jsonFile.fullPath} to temp: ${err.message}`
        );
      }
    }

    Logger.info(
      `📁 Copied ${tempFiles.length} JSON file(s) to organized temp structure`
    );
    return tempFiles;
  }

  /**
   * Step 5: Fix/sanitize ALL JSON files in temp folder using organized structure
   */
  async sanitizeAllJsonFiles(tempJsonFiles) {
    const sanitizedFiles = [];

    for (const tempFile of tempJsonFiles) {
      try {
        Logger.info(`🔧 Sanitizing: ${tempFile.fileName}`);

        // Read the temp file
        const rawContent = fs.readFileSync(tempFile.tempPath, "utf8");

        // Sanitize the content (same logic as Project.sanitizeJsonContent)
        const sanitizedContent = this.sanitizeJsonContent(rawContent);

        // Save sanitized content to processed_files folder using organized structure
        const sanitizedPath = await this.tempManager.saveToTemp(
          tempFile.fileName,
          sanitizedContent,
          "processed_files"
        );

        sanitizedFiles.push({
          ...tempFile,
          sanitizedPath: sanitizedPath,
          sanitized: true,
        });
      } catch (err) {
        Logger.error(`Failed to sanitize ${tempFile.fileName}: ${err.message}`);
      }
    }

    Logger.info(
      `🔧 Sanitized ${sanitizedFiles.length} JSON file(s) to processed_files folder`
    );
    return sanitizedFiles;
  }

  /**
   * Step 6: Process ALL sanitized JSON files using organized structure
   */
  async processAllJsonFiles(sanitizedFiles) {
    const processedData = [];

    for (const file of sanitizedFiles) {
      try {
        Logger.info(`📊 Processing: ${file.fileName}`);

        // Read and parse the sanitized JSON from processed_files folder
        const jsonContent = JSON.parse(
          fs.readFileSync(file.sanitizedPath, "utf8")
        );

        // Extract tool usage data
        const toolUsageData = this.extractToolUsageData(
          jsonContent,
          file.projectInfo
        );

        processedData.push({
          fileName: file.fileName,
          originalPath: file.originalPath,
          projectInfo: file.projectInfo,
          toolUsage: toolUsageData,
          processedAt: new Date().toISOString(),
        });
      } catch (err) {
        Logger.error(`Failed to process ${file.fileName}: ${err.message}`);
      }
    }

    Logger.info(
      `📊 Processed ${processedData.length} JSON file(s) for tool usage data`
    );
    return processedData;
  }

  /**
   * Step 7: Generate consolidated report using organized structure
   */
  async generateConsolidatedReport(excelData, processedJsonData) {
    const Results = require("./Results");
    const results = new Results(this.tempManager);

    // Generate the consolidated report
    await results.generateConsolidatedReport(excelData, processedJsonData);
  }

  /**
   * Step 8: Clean temp folder using organized structure
   */
  async cleanTempFolder() {
    // Safety check: don't clean in test mode or persistent folder mode
    if (config.app.testMode) {
      Logger.warn(`🚫 Cleanup blocked in test mode - temp data preserved`);
      return;
    }
    
    if (config.app.usePersistentTempFolder) {
      Logger.warn(`🚫 Cleanup blocked in persistent folder mode - temp data preserved for reuse`);
      return;
    }

    await this.tempManager.cleanup();
    Logger.info(`🧹 Cleaned organized temp session`);
  }

  /**
   * Sanitize JSON content (same logic as Project.sanitizeJsonContent)
   */
  sanitizeJsonContent(jsonString) {
    // Fix unquoted NaN values which are invalid JSON
    let sanitized = jsonString.replace(/:\s*NaN\s*,/g, ": null,");
    sanitized = sanitized.replace(/:\s*NaN\s*}/g, ": null}");
    sanitized = sanitized.replace(/:\s*NaN\s*]/g, ": null]");

    // Fix infinity values if they exist
    sanitized = sanitized.replace(/:\s*Infinity\s*,/g, ": null,");
    sanitized = sanitized.replace(/:\s*Infinity\s*}/g, ": null}");
    sanitized = sanitized.replace(/:\s*-Infinity\s*,/g, ": null,");
    sanitized = sanitized.replace(/:\s*-Infinity\s*}/g, ": null}");

    return sanitized;
  }

  /**
   * Extract tool usage data from JSON content
   */
  extractToolUsageData(jsonContent, projectInfo) {
    const toolUsage = {
      project: projectInfo.projectName || "UNKNOWN",
      position: projectInfo.positionName || "UNKNOWN",
      machine: jsonContent.machine || "UNKNOWN",
      operator: jsonContent.operator || "UNKNOWN",
      operations: [],
      totalTime: 0,
      toolsUsed: new Set(),
    };

    if (jsonContent.operations && Array.isArray(jsonContent.operations)) {
      for (const operation of jsonContent.operations) {
        const opData = {
          programName: operation.programName || "UNKNOWN",
          toolName: operation.toolName || "UNKNOWN",
          operationTime: operation.operationTime || 0,
          maxSpeed: operation.maxSpeed || 0,
          maxFeed: operation.maxFeed || 0,
        };

        toolUsage.operations.push(opData);
        toolUsage.totalTime += opData.operationTime;
        if (opData.toolName !== "UNKNOWN") {
          toolUsage.toolsUsed.add(opData.toolName);
        }
      }
    }

    // Convert Set to Array for JSON serialization
    toolUsage.toolsUsed = Array.from(toolUsage.toolsUsed);

    return toolUsage;
  }

  /**
   * Scan with path resolution for manual mode compatibility.
   * This is called by Executor.runManualMode().
   */
  async scanWithPathResolution() {
    return await this.performScan();
  }

  /**
   * Get processed projects (compatibility method).
   */
  getProjects() {
    return this.projects;
  }
}

module.exports = Scanner;
