// utils/TempFileManager.js
/**
 * Manages temporary file operations for ToolManager
 * Ensures read-only access to original files by working with copies
 * Uses organized BRK CNC Management Dashboard structure
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const Logger = require("./Logger");
const config = require("../config");

class TempFileManager {
  constructor(appName = "ToolManager") {
    // Support user-defined working folder like JSONScanner
    if (config.app.userDefinedWorkingFolder) {
      this.tempBasePath = path.join(
        config.app.userDefinedWorkingFolder,
        config.app.tempBaseName || "BRK CNC Management Dashboard"
      );
    } else if (config.app.testMode && config.app.testProcessedDataPath) {
      // Use test_processed_data path for test mode (same as JSONScanner)
      this.tempBasePath = path.join(
        config.app.testProcessedDataPath,
        config.app.tempBaseName || "BRK CNC Management Dashboard"
      );
    } else {
      // Create organized hierarchy: temp/BRK CNC Management Dashboard/AppName/
      this.tempBasePath = path.join(
        os.tmpdir(),
        config.app.tempBaseName || "BRK CNC Management Dashboard"
      );
    }

    this.appName = appName;
    this.appPath = path.join(this.tempBasePath, this.appName);

    if (config.app.usePersistentTempFolder) {
      this.sessionPath = this.appPath; // Work directly in app folder
    } else {
      this.sessionId = this.generateSessionId();
      this.sessionPath = path.join(this.appPath, this.sessionId);
    }

    // Create organized subdirectories for different types of files
    this.inputFilesPath = path.join(this.sessionPath, "input_json_files");
    this.processedFilesPath = path.join(this.sessionPath, "processed_files");
    this.resultsPath = path.join(this.sessionPath, "results");
    this.excelFilesPath = path.join(this.sessionPath, "input_excel_files");

    this.fileHashes = new Map(); // Track file hashes for change detection
    this.copyQueue = new Map(); // Track copy operations
    this.pathMapping = new Map(); // Map temp paths back to original paths
    this.currentSessionId = this.generateSessionId(); // Session tracking like JSONScanner

    this.ensureSessionDirectory();
  }

  /**
   * Generate unique session ID for this scanning session
   */
  generateSessionId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `session_${timestamp}_${random}`;
  }

  /**
   * Ensure session directory exists with organized structure
   */
  ensureSessionDirectory() {
    try {
      // Create main BRK CNC Management Dashboard directory
      if (!fs.existsSync(this.tempBasePath)) {
        fs.mkdirSync(this.tempBasePath, { recursive: true });
        Logger.info(
          `Created BRK CNC Management Dashboard temp directory: ${this.tempBasePath}`
        );
      }

      // Create app-specific directory
      if (!fs.existsSync(this.appPath)) {
        fs.mkdirSync(this.appPath, { recursive: true });
        Logger.info(`Created ${this.appName} app directory: ${this.appPath}`);
      }

      // Create session directory
      if (!fs.existsSync(this.sessionPath)) {
        fs.mkdirSync(this.sessionPath, { recursive: true });
        Logger.info(`Created session directory: ${this.sessionPath}`);
      }

      // Create organized subdirectories
      const subdirs = [
        { path: this.inputFilesPath, name: "input_json_files" },
        { path: this.processedFilesPath, name: "processed_files" },
        { path: this.resultsPath, name: "results" },
        { path: this.excelFilesPath, name: "input_excel_files" },
      ];

      for (const subdir of subdirs) {
        if (!fs.existsSync(subdir.path)) {
          fs.mkdirSync(subdir.path, { recursive: true });
          Logger.info(`Created ${subdir.name} directory: ${subdir.path}`);
        }
      }
      
      Logger.info(`ToolManager directories ready at: ${this.sessionPath}`);
    } catch (error) {
      Logger.error("Failed to create temp directories:", error);
      throw error;
    }
  }

  /**
   * Copy a file or directory structure to temp location
   * @param {string} sourcePath - Original file/directory path
   * @param {string} fileType - Type of file: 'input', 'input_files', 'processed', 'processed_files', 'result', 'results', 'excel', 'excel_files'
   * @param {boolean} preserveStructure - Whether to preserve directory structure
   * @returns {string} - Path to temporary copy
   */
  async copyToTemp(sourcePath, fileType = "input", preserveStructure = true) {
    try {
      const sourceStats = fs.statSync(sourcePath);

      // Determine target directory based on file type (use getPathForType for consistency)
      const targetBasePath = this.getPathForType(fileType);

      const relativePath = this.getRelativePath(sourcePath);
      const tempPath = path.join(targetBasePath, relativePath);

      if (sourceStats.isDirectory()) {
        return await this.copyDirectoryToTemp(sourcePath, tempPath);
      } else {
        return await this.copyFileToTemp(sourcePath, tempPath);
      }
    } catch (error) {
      Logger.error(`Failed to copy ${sourcePath} to temp:`, error);
      throw error;
    }
  }

  /**
   * Copy a single file to temp location
   */
  async copyFileToTemp(sourcePath, tempPath) {
    try {
      // Ensure parent directory exists
      const tempDir = path.dirname(tempPath);
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      // Calculate file hash for change detection
      const sourceHash = await this.calculateFileHash(sourcePath);
      const sourceStats = fs.statSync(sourcePath);

      // Copy file
      fs.copyFileSync(sourcePath, tempPath);

      // Store metadata for change detection
      this.fileHashes.set(sourcePath, {
        hash: sourceHash,
        mtime: sourceStats.mtime,
        tempPath: tempPath,
        originalPath: sourcePath,
      });

      // Store reverse mapping
      this.pathMapping.set(tempPath, sourcePath);

      Logger.info(`Copied file: ${sourcePath} → ${tempPath}`);
      return tempPath;
    } catch (error) {
      Logger.error(`Failed to copy file ${sourcePath}:`, error);
      throw error;
    }
  }

  /**
   * Copy directory structure to temp location
   */
  async copyDirectoryToTemp(sourcePath, tempPath) {
    try {
      if (!fs.existsSync(tempPath)) {
        fs.mkdirSync(tempPath, { recursive: true });
      }

      const items = fs.readdirSync(sourcePath);
      const copiedPaths = [tempPath];

      for (const item of items) {
        const sourceItem = path.join(sourcePath, item);
        const tempItem = path.join(tempPath, item);
        const itemStats = fs.statSync(sourceItem);

        if (itemStats.isDirectory()) {
          const subPaths = await this.copyDirectoryToTemp(sourceItem, tempItem);
          copiedPaths.push(...subPaths);
        } else {
          await this.copyFileToTemp(sourceItem, tempItem);
          copiedPaths.push(tempItem);
        }
      }

      Logger.info(`Copied directory: ${sourcePath} → ${tempPath}`);
      return copiedPaths;
    } catch (error) {
      Logger.error(`Failed to copy directory ${sourcePath}:`, error);
      throw error;
    }
  }

  /**
   * Get path for specific file type
   * @param {string} fileType - Type: 'input', 'processed', 'processed_files', 'result', 'results', 'excel', 'excel_files'
   * @returns {string} - Directory path for the file type
   */
  getPathForType(fileType) {
    switch (fileType) {
      case "processed":
      case "processed_files":
        return this.processedFilesPath;
      case "result":
      case "results":
        return this.resultsPath;
      case "excel":
      case "excel_files":
        return this.excelFilesPath;
      case "input":
      case "input_files":
      default:
        return this.inputFilesPath;
    }
  }

  /**
   * Save content to organized temp location
   * @param {string} filename - Name of file to save
   * @param {string} content - Content to save
   * @param {string} fileType - Type of file for organization
   * @returns {string} - Path where file was saved
   */
  saveToTemp(filename, content, fileType = "result") {
    try {
      const targetDir = this.getPathForType(fileType);
      const filePath = path.join(targetDir, filename);

      fs.writeFileSync(filePath, content, "utf8");
      Logger.info(`📄 Saved ${fileType}: ${filename}`);

      return filePath;
    } catch (error) {
      Logger.error(`Failed to save ${fileType} file ${filename}:`, error);
      throw error;
    }
  }

  /**
   * Calculate MD5 hash of a file for change detection
   */
  async calculateFileHash(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash("md5");
      const stream = fs.createReadStream(filePath);

      stream.on("data", (data) => hash.update(data));
      stream.on("end", () => resolve(hash.digest("hex")));
      stream.on("error", reject);
    });
  }

  /**
   * Get relative path for organizing temp files
   * Uses hash-based approach for very long paths
   */
  getRelativePath(absolutePath) {
    // Create a safe relative path by replacing path separators
    const safePath = absolutePath
      .replace(/:/g, "_COLON_")
      .replace(/\\/g, "_BACKSLASH_")
      .replace(/\//g, "_SLASH_");

    // Check if the resulting safe path would be too long
    const maxLength = 180; // Safe length for most file systems

    if (safePath.length > maxLength) {
      const crypto = require("crypto");
      const hash = crypto.createHash("md5").update(absolutePath).digest("hex");
      const fileName = path.basename(absolutePath);
      const dirName = path.basename(path.dirname(absolutePath));

      // Create a meaningful but short name: hash_directory_filename
      return `${hash.substring(0, 8)}_${dirName}_${fileName}`;
    }

    return safePath;
  }

  /**
   * Get original path from temp path
   */
  getOriginalPath(tempPath) {
    // First check direct mapping
    if (this.pathMapping.has(tempPath)) {
      return this.pathMapping.get(tempPath);
    }

    // Fallback to search in fileHashes
    for (const [originalPath, info] of this.fileHashes) {
      if (info.tempPath === tempPath) {
        return originalPath;
      }
    }
    return null;
  }

  /**
   * Get temp path for original file
   */
  getTempPath(originalPath) {
    const info = this.fileHashes.get(originalPath);
    return info ? info.tempPath : null;
  }

  /**
   * Get all result files from current session
   */
  getResultFiles() {
    if (!fs.existsSync(this.resultsPath)) {
      return [];
    }

    try {
      const files = fs.readdirSync(this.resultsPath);
      return files.map((file) => ({
        filename: file,
        path: path.join(this.resultsPath, file),
        size: fs.statSync(path.join(this.resultsPath, file)).size,
        created: fs.statSync(path.join(this.resultsPath, file)).birthtime,
      }));
    } catch (error) {
      Logger.error(`Failed to get result files: ${error.message}`);
      return [];
    }
  }

  /**
   * Copy result files to a specific destination
   * @param {string} destinationDir - Where to copy the results
   */
  exportResults(destinationDir) {
    try {
      const resultFiles = this.getResultFiles();

      if (resultFiles.length === 0) {
        Logger.warn("No result files to export");
        return false;
      }

      // Ensure destination exists
      if (!fs.existsSync(destinationDir)) {
        fs.mkdirSync(destinationDir, { recursive: true });
      }

      // Copy each result file
      let copiedCount = 0;
      for (const result of resultFiles) {
        const destPath = path.join(destinationDir, result.filename);
        fs.copyFileSync(result.path, destPath);
        copiedCount++;
      }

      Logger.info(
        `Exported ${copiedCount} result file(s) to: ${destinationDir}`
      );
      return true;
    } catch (error) {
      Logger.error(`Failed to export results: ${error.message}`);
      return false;
    }
  }

  /**
   * Clean up temporary files for this session
   * @param {boolean} preserveResults - Whether to preserve result files
   */
  cleanup(preserveResults = false) {
    try {
      if (fs.existsSync(this.sessionPath)) {
        if (preserveResults) {
          // Archive results before cleanup
          this.archiveResults();
        }

        this.removeDirectory(this.sessionPath);
        Logger.info(`Cleaned up session directory: ${this.sessionPath}`);
      }

      this.fileHashes.clear();
      this.copyQueue.clear();
      this.pathMapping.clear();
    } catch (error) {
      Logger.warn(`Failed to cleanup temp directory: ${error.message}`);
    }
  }

  /**
   * Remove directory recursively
   */
  removeDirectory(dirPath) {
    if (fs.existsSync(dirPath)) {
      const items = fs.readdirSync(dirPath);

      for (const item of items) {
        const itemPath = path.join(dirPath, item);
        const stats = fs.statSync(itemPath);

        if (stats.isDirectory()) {
          this.removeDirectory(itemPath);
        } else {
          fs.unlinkSync(itemPath);
        }
      }

      fs.rmdirSync(dirPath);
    }
  }

  /**
   * Archive results to a permanent location before cleanup
   */
  archiveResults() {
    try {
      if (!fs.existsSync(this.resultsPath)) {
        Logger.info("No results to archive");
        return;
      }

      // Create archive directory in app path
      const archiveDir = path.join(this.appPath, "archived_results");
      if (!fs.existsSync(archiveDir)) {
        fs.mkdirSync(archiveDir, { recursive: true });
      }

      // Create timestamped archive folder
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const sessionArchiveDir = path.join(
        archiveDir,
        `${this.sessionId}_${timestamp}`
      );
      fs.mkdirSync(sessionArchiveDir, { recursive: true });

      // Copy all results to archive
      const resultFiles = fs.readdirSync(this.resultsPath);
      for (const file of resultFiles) {
        const sourcePath = path.join(this.resultsPath, file);
        const targetPath = path.join(sessionArchiveDir, file);
        fs.copyFileSync(sourcePath, targetPath);
      }

      Logger.info(
        `Archived ${resultFiles.length} result file(s) to: ${sessionArchiveDir}`
      );
    } catch (error) {
      Logger.warn(`Failed to archive results: ${error.message}`);
    }
  }

  /**
   * Get session information
   */
  getSessionInfo() {
    const resultFiles = this.getResultFiles();

    return {
      sessionId: this.sessionId,
      sessionPath: this.sessionPath,
      tempBasePath: this.tempBasePath,
      appName: this.appName,
      appPath: this.appPath,
      trackedFiles: this.fileHashes.size,
      trackedPaths: Array.from(this.fileHashes.keys()),
      resultFiles: resultFiles.length,
      organizationPaths: {
        inputFiles: this.inputFilesPath,
        processedFiles: this.processedFilesPath,
        results: this.resultsPath,
        excelFiles: this.excelFilesPath,
      },
    };
  }

  /**
   * Clean up old temp sessions (older than 24 hours)
   */
  static cleanupOldSessions(appName = null) {
    try {
      const tempBasePath = path.join(
        os.tmpdir(),
        "BRK CNC Management Dashboard"
      );

      if (!fs.existsSync(tempBasePath)) {
        return;
      }

      // If appName specified, clean only that app's sessions
      const appsToClean = appName ? [appName] : fs.readdirSync(tempBasePath);

      for (const app of appsToClean) {
        const appPath = path.join(tempBasePath, app);

        if (!fs.existsSync(appPath) || !fs.statSync(appPath).isDirectory()) {
          continue;
        }

        const sessions = fs
          .readdirSync(appPath)
          .filter(
            (item) =>
              item.startsWith("session_") &&
              fs.statSync(path.join(appPath, item)).isDirectory()
          );

        const now = Date.now();
        const maxAge = 24 * 60 * 60 * 1000; // 24 hours

        for (const session of sessions) {
          const sessionPath = path.join(appPath, session);
          const stats = fs.statSync(sessionPath);

          if (now - stats.mtime.getTime() > maxAge) {
            const manager = new TempFileManager(app);
            manager.removeDirectory(sessionPath);
            Logger.info(`Cleaned up old session: ${app}/${session}`);
          }
        }
      }
    } catch (error) {
      Logger.warn(`Failed to cleanup old sessions: ${error.message}`);
    }
  }

  /**
   * Check if a file has changed compared to its temp copy (like JSONScanner)
   * @param {string} sourcePath - Source file path
   * @param {string} tempPath - Temp file path
   * @returns {boolean} - True if file has changed or doesn't exist in temp
   */
  async hasFileChanged(sourcePath, tempPath) {
    try {
      // If temp file doesn't exist, consider it changed
      if (!fs.existsSync(tempPath)) {
        return true;
      }

      // Check stored hash information
      const storedInfo = this.fileHashes.get(sourcePath);
      const sourceStats = fs.statSync(sourcePath);

      if (!storedInfo) {
        // No stored info, consider changed
        return true;
      }

      // Quick check: modification time
      if (sourceStats.mtime.getTime() !== storedInfo.mtime.getTime()) {
        // File might have changed, verify with hash
        const currentHash = await this.calculateFileHash(sourcePath);

        if (currentHash !== storedInfo.hash) {
          return true;
        }
      }

      return false;
    } catch (error) {
      Logger.warn(
        `Error checking file changes for ${sourcePath}: ${error.message}`
      );
      return true; // Assume changed if we can't determine
    }
  }

  /**
   * Get session information (like JSONScanner)
   * @returns {Object} - Session information
   */
  getSessionInfo() {
    return {
      sessionId: this.currentSessionId,
      tempPath: this.sessionPath,
      trackedFiles: this.fileHashes.size,
      isPersistent: config.app.usePersistentTempFolder,
    };
  }
}

module.exports = TempFileManager;
