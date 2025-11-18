#!/usr/bin/env node
/**
 * Generate matrix tool definitions from Excel inventory files
 * Learns tool categories, codes, and diameter patterns from train-data
 */

const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

const TRAIN_DATA_PATH = path.join(__dirname, '..', '..', 'BRK_CNC_CORE', 'train-data', 'matrix_tools');
const OUTPUT_PATH = path.join(__dirname, '..', 'config', 'matrix-tool-definitions.json');

// Ensure output directory exists
const outputDir = path.dirname(OUTPUT_PATH);
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

console.log('🔍 Scanning Excel files for matrix tool definitions...\n');

const excelFiles = [
  { file: 'E-Cut készlet.xlsx', category: 'ECUT' },
  { file: 'MFC készlet.xlsx', category: 'MFC' },
  { file: 'XF simitó.xlsx', category: 'XF' },
  { file: 'XFeed szerszámok.xlsx', category: 'XFEED' }
];

const matrixDefinitions = {
  version: '1.0.0',
  generatedAt: new Date().toISOString(),
  sourceFiles: [],
  categories: {}
};

(async () => {
for (const { file, category } of excelFiles) {
  const filePath = path.join(TRAIN_DATA_PATH, file);
  
  if (!fs.existsSync(filePath)) {
    console.warn(`⚠️  File not found: ${file}`);
    continue;
  }

  console.log(`📊 Processing: ${file}`);
  
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const worksheet = workbook.worksheets[0];
    const data = [];
    worksheet.eachRow((row) => {
      data.push(row.values.slice(1)); // Remove first empty element
    });
    
    // Find header row
    let headerRowIndex = -1;
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      if (row && Array.isArray(row)) {
        const hasItemCode = row.some(cell => 
          typeof cell === 'string' && cell.trim().toLowerCase().includes('tételkód')
        );
        if (hasItemCode) {
          headerRowIndex = i;
          break;
        }
      }
    }
    
    if (headerRowIndex === -1) {
      console.warn(`  ⚠️  Could not find header row`);
      continue;
    }
    
    const headerRow = data[headerRowIndex];
    const itemCodeCol = headerRow.findIndex(cell => 
      typeof cell === 'string' && cell.trim().toLowerCase().includes('tételkód')
    );
    
    // Description is typically in the first column (index 0), before item code
    const descriptionCol = 0;
    
    console.log(`  ✓ Found header at row ${headerRowIndex + 1}`);
    console.log(`  ✓ Item code column: ${itemCodeCol + 1}, Description column: ${descriptionCol + 1}`);
    
    const tools = [];
    const toolCodePatterns = new Set();
    const diameterMap = new Map(); // toolCode -> diameter
    
    // Process data rows
    for (let i = headerRowIndex + 1; i < data.length; i++) {
      const row = data[i];
      if (!row || !Array.isArray(row)) continue;
      
      const itemCode = row[itemCodeCol];
      const description = row[descriptionCol];
      
      if (!itemCode || typeof itemCode !== 'string') continue;
      
      const cleanCode = itemCode.trim();
      const cleanDesc = description ? String(description).trim() : '';
      
      // Extract tool code pattern (RT-8400300 -> 8400)
      const match = cleanCode.match(/RT-(\d{4})/);
      if (match) {
        const codePrefix = match[1];
        toolCodePatterns.add(codePrefix);
        
        // Extract diameter from description (ø5,7 -> 5.7)
        const diamMatch = cleanDesc.match(/ø(\d+[,.]?\d*)/);
        if (diamMatch) {
          const diameter = parseFloat(diamMatch[1].replace(',', '.'));
          diameterMap.set(cleanCode, diameter);
        }
        
        tools.push({
          toolCode: cleanCode,
          codePrefix,
          description: cleanDesc,
          diameter: diameterMap.get(cleanCode) || null
        });
      }
    }
    
    console.log(`  ✓ Extracted ${tools.length} tools`);
    console.log(`  ✓ Code patterns: ${Array.from(toolCodePatterns).join(', ')}`);
    
    matrixDefinitions.categories[category] = {
      name: category,
      excelFile: file,
      toolCount: tools.length,
      codePatterns: Array.from(toolCodePatterns),
      tools: tools.slice(0, 5), // Sample first 5 for reference
      diameterRange: {
        min: Math.min(...Array.from(diameterMap.values()).filter(d => d)),
        max: Math.max(...Array.from(diameterMap.values()).filter(d => d))
      }
    };
    
    matrixDefinitions.sourceFiles.push({
      file,
      category,
      toolCount: tools.length,
      processedAt: new Date().toISOString()
    });
    
    console.log('');
    
  } catch (error) {
    console.error(`  ✗ Error processing ${file}: ${error.message}\n`);
  }
}

// Add matching rules
matrixDefinitions.matchingRules = {
  description: 'Match tools by category code prefix (4 digits after RT-) and diameter',
  ignoreVariants: 'Tool codes with _1, _2 suffixes are variants of the same tool',
  diameterTolerance: 0.01,
  examples: [
    {
      matrixCode: 'RT-8400300',
      category: 'ECUT',
      codePrefix: '8400',
      diameter: 5.7,
      description: 'ø5,7/6x56/12 r0.1 z4'
    }
  ]
};

// Write to file
fs.writeFileSync(OUTPUT_PATH, JSON.stringify(matrixDefinitions, null, 2), 'utf8');

console.log('\n✅ Matrix tool definitions generated successfully!');
console.log(`📁 Output: ${OUTPUT_PATH}`);
console.log(`📊 Total categories: ${Object.keys(matrixDefinitions.categories).length}`);
console.log(`🔧 Total tools: ${Object.values(matrixDefinitions.categories).reduce((sum, cat) => sum + cat.tools.length, 0)}\n`);

})();

// Write output
fs.writeFileSync(OUTPUT_PATH, JSON.stringify(matrixDefinitions, null, 2));
console.log(`✅ Matrix definitions saved to: ${OUTPUT_PATH}`);
console.log(`📊 Total categories: ${Object.keys(matrixDefinitions.categories).length}`);
console.log(`🔧 Total tools: ${matrixDefinitions.sourceFiles.reduce((sum, f) => sum + f.toolCount, 0)}`);
