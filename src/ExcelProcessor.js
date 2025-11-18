// src/services/ExcelProcessor.js
/**
 * Excel processor for extracting tool inventory from the daily Excel file
 */
const ExcelJS = require('exceljs');
const fs = require('fs');
const Logger = require('../utils/Logger');

class ExcelProcessor {
  /**
   * Process the main Excel file to extract tool inventory
   * @param {string} filePath - Path to Excel file
   * @returns {Object} - Processed tool inventory
   */
  static async processMainExcel(filePath) {
    try {
      Logger.info(`Processing Excel file: ${filePath}`);
      
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(filePath);
      const worksheet = workbook.worksheets[0]; // First sheet
      
      // Convert to array of arrays for easier processing
      const rawData = [];
      worksheet.eachRow((row, rowNumber) => {
        rawData.push(row.values.slice(1)); // Remove first empty element
      });
      
      // Find the header row with "Tételkód" and "Mennyiség"
      const headerRowIndex = this.findHeaderRow(rawData);
      
      if (headerRowIndex === -1) {
        throw new Error('Could not find header row with "Tételkód" and "Mennyiség"');
      }
      
      Logger.info(`Found header row at index: ${headerRowIndex + 1}`);
      
      // Extract tool inventory data
      const toolInventory = this.extractToolInventory(rawData, headerRowIndex);
      
      Logger.info(`Extracted ${Object.keys(toolInventory).length} unique tool codes`);
      
      return {
        success: true,
        processedAt: new Date().toISOString(),
        sourceFile: filePath,
        toolInventory,
        summary: this.generateSummary(toolInventory)
      };
      
    } catch (error) {
      Logger.error(`Excel processing failed: ${error.message}`);
      return {
        success: false,
        error: error.message,
        processedAt: new Date().toISOString(),
        sourceFile: filePath
      };
    }
  }

  /**
   * Find the header row containing "Tételkód" and "Mennyiség"
   * @param {Array} rawData - Raw Excel data
   * @returns {number} - Index of header row, -1 if not found
   */
  static findHeaderRow(rawData) {
    for (let i = 0; i < rawData.length; i++) {
      const row = rawData[i];
      if (row && Array.isArray(row)) {
        // Look for "Tételkód" and "Mennyiség" in the same row
        const hasItemCode = row.some(cell => 
          typeof cell === 'string' && cell.trim().toLowerCase().includes('tételkód')
        );
        const hasQuantity = row.some(cell => 
          typeof cell === 'string' && cell.trim().toLowerCase().includes('mennyiség')
        );
        
        if (hasItemCode && hasQuantity) {
          return i;
        }
      }
    }
    return -1;
  }

  /**
   * Extract tool inventory from raw data
   * @param {Array} rawData - Raw Excel data
   * @param {number} headerRowIndex - Index of header row
   * @returns {Object} - Tool inventory object
   */
  static extractToolInventory(rawData, headerRowIndex) {
    const headerRow = rawData[headerRowIndex];
    
    // Find column indices
    const itemCodeColumnIndex = this.findColumnIndex(headerRow, 'tételkód');
    const quantityColumnIndex = this.findColumnIndex(headerRow, 'mennyiség');
    
    if (itemCodeColumnIndex === -1 || quantityColumnIndex === -1) {
      throw new Error('Could not find required columns in header row');
    }
    
    Logger.info(`Item code column: ${itemCodeColumnIndex + 1}, Quantity column: ${quantityColumnIndex + 1}`);
    
    const toolInventory = {};
    
    // Process data rows (skip header row)
    for (let i = headerRowIndex + 1; i < rawData.length; i++) {
      const row = rawData[i];
      
      if (row && Array.isArray(row)) {
        const itemCode = row[itemCodeColumnIndex];
        const quantity = row[quantityColumnIndex];
        
        // Validate data
        if (this.isValidToolEntry(itemCode, quantity)) {
          const cleanItemCode = this.cleanItemCode(itemCode);
          const numQuantity = parseInt(quantity);
          
          // Accumulate quantities for the same tool code
          if (toolInventory[cleanItemCode]) {
            toolInventory[cleanItemCode] += numQuantity;
          } else {
            toolInventory[cleanItemCode] = numQuantity;
          }
        }
      }
    }
    
    return toolInventory;
  }

  /**
   * Find column index by searching for text in header row
   * @param {Array} headerRow - Header row data
   * @param {string} searchText - Text to search for
   * @returns {number} - Column index, -1 if not found
   */
  static findColumnIndex(headerRow, searchText) {
    for (let i = 0; i < headerRow.length; i++) {
      const cell = headerRow[i];
      if (typeof cell === 'string' && 
          cell.trim().toLowerCase().includes(searchText.toLowerCase())) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Validate if a tool entry is valid
   * @param {any} itemCode - Item code value
   * @param {any} quantity - Quantity value
   * @returns {boolean} - True if valid
   */
  static isValidToolEntry(itemCode, quantity) {
    // Item code should be a non-empty string
    if (!itemCode || typeof itemCode !== 'string' || itemCode.trim().length === 0) {
      return false;
    }
    
    // Quantity should be a positive number
    const numQuantity = parseInt(quantity);
    if (isNaN(numQuantity) || numQuantity <= 0) {
      return false;
    }
    
    return true;
  }

  /**
   * Clean item code string
   * @param {string} itemCode - Raw item code
   * @returns {string} - Cleaned item code
   */
  static cleanItemCode(itemCode) {
    return itemCode.trim().toUpperCase();
  }

  /**
   * Generate summary statistics
   * @param {Object} toolInventory - Tool inventory object
   * @returns {Object} - Summary statistics
   */
  static generateSummary(toolInventory) {
    const totalUniqueTools = Object.keys(toolInventory).length;
    const totalQuantity = Object.values(toolInventory).reduce((sum, qty) => sum + qty, 0);
    
    // Find top 10 most available tools
    const sortedTools = Object.entries(toolInventory)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 10);
    
    return {
      totalUniqueTools,
      totalQuantity,
      averageQuantityPerTool: totalUniqueTools > 0 ? (totalQuantity / totalUniqueTools).toFixed(2) : 0,
      topTools: sortedTools.map(([code, qty]) => ({ code, quantity: qty }))
    };
  }

  /**
   * Save processed inventory to JSON file
   * @param {Object} processedData - Processed inventory data
   * @param {string} outputPath - Output file path
   */
  static saveInventoryToJson(processedData, outputPath) {
    try {
      const outputDir = require('path').dirname(outputPath);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      
      fs.writeFileSync(outputPath, JSON.stringify(processedData, null, 2));
      Logger.info(`Inventory saved to: ${outputPath}`);
      
    } catch (error) {
      Logger.error(`Failed to save inventory: ${error.message}`);
      throw error;
    }
  }
}

module.exports = ExcelProcessor;