const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

// Load credentials from environment variable (Railway) OR local file (development)
let credentials;
if (process.env.GOOGLE_CREDENTIALS) {
  // Running on Railway - parse JSON from environment variable
  try {
    credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    console.log('✅ Using Google credentials from environment variable');
  } catch (error) {
    console.error('❌ Error parsing GOOGLE_CREDENTIALS:', error.message);
    throw new Error('Invalid GOOGLE_CREDENTIALS environment variable');
  }
} else {
  // Running locally - read from file
  const filePath = path.join(__dirname, '../config/service-account.json');
  try {
    credentials = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    console.log('✅ Using Google credentials from local file');
  } catch (error) {
    console.error('❌ Error reading service-account.json:', error.message);
    throw new Error('Service account file not found');
  }
}

// Initialize Google Sheets API
const auth = new google.auth.GoogleAuth({
  credentials: credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });
const spreadsheetId = process.env.SPREADSHEET_ID || '1swE1x8y7xNFaPFZovR9BJ6usq7baM3gGkXqNI8cgWmI';

// Cache for sheetName -> sheetId mapping
const sheetIdCache = new Map();

/**
 * Get Sheet ID for a given Sheet Name (required for batchUpdate structural changes)
 */
async function getSheetId(sheetName) {
  if (sheetIdCache.has(sheetName)) {
    return sheetIdCache.get(sheetName);
  }
  
  const response = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = response.data.sheets.find(s => s.properties.title === sheetName);
  
  if (sheet) {
    sheetIdCache.set(sheetName, sheet.properties.sheetId);
    return sheet.properties.sheetId;
  }
  throw new Error(`Sheet ${sheetName} not found in spreadsheet`);
}

/**
 * Retry wrapper for Google Sheets API calls to handle quota errors
 */
async function withRetry(operation, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (error.code === 429 && attempt < maxRetries) {
        const delay = attempt * 1000 + Math.random() * 500;
        console.warn(`⚠️ Rate limit exceeded. Retrying attempt ${attempt}/${maxRetries} after ${Math.round(delay)}ms...`);
        await new Promise(res => setTimeout(res, delay));
      } else {
        throw error;
      }
    }
  }
}



// Memory cache for sheet data (5 seconds TTL) to prevent API rate limit on sequential calls
const sheetDataCache = new Map();

/**
 * Get all data from a sheet
 * @param {string} sheetName - Name of the sheet tab
 * @returns {Array} Array of objects with headers as keys
 */
async function getSheetData(sheetName) {
  try {
    const now = Date.now();
    if (sheetDataCache.has(sheetName)) {
      const cached = sheetDataCache.get(sheetName);
      if (now - cached.timestamp < 5000) { // 5 seconds TTL
        return cached.data;
      }
    }

    const response = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: `${sheetName}!A1:Z`
    }));
    
    const rows = response.data.values;
    
    if (!rows || rows.length < 2) {
      console.log(`📭 Sheet "${sheetName}" is empty or has only headers`);
      return [];
    }
    
    // Clean headers (remove whitespace)
    const headers = rows[0].map(h => (h || '').trim());
    const data = [];
    
    // Convert rows to objects (skip header row)
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      
      // Skip completely empty rows
      if (!row || row.every(cell => !cell || cell.trim() === '')) {
        continue;
      }
      
      const obj = {};
      headers.forEach((header, index) => {
        obj[header] = (row[index] || '').toString().trim();
      });
      data.push(obj);
    }
    
    // Cache the result
    sheetDataCache.set(sheetName, { timestamp: Date.now(), data });
    
    console.log(`📊 Loaded ${data.length} rows from "${sheetName}"`);
    return data;
  } catch (error) {
    console.error(`❌ Error reading sheet "${sheetName}":`, error.message);
    return [];
  }
}

/**
 * Append a new row to a sheet
 * @param {string} sheetName - Name of the sheet tab
 * @param {Array} rowData - Array of values for the new row
 * @returns {Object} Success status
 */
async function appendRow(sheetName, rowData) {
  try {
    const response = await withRetry(() => sheets.spreadsheets.values.append({
      spreadsheetId: spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      resource: {
        values: [rowData]
      }
    }));
    
    // Invalidate cache
    sheetDataCache.delete(sheetName);

    console.log(`✅ Row appended to "${sheetName}"`);
    return { success: true, updates: response.data.updates };
  } catch (error) {
    console.error(`❌ Error appending to "${sheetName}":`, error.message);
    throw error;
  }
}

/**
 * Append multiple rows to a sheet in a single batch call (Sub-second latency)
 * @param {string} sheetName - Name of the sheet tab
 * @param {Array<Array>} rowsArray - Array of row arrays to append
 * @returns {Object} Success status
 */
async function appendRows(sheetName, rowsArray) {
  try {
    if (!Array.isArray(rowsArray) || rowsArray.length === 0) {
      return { success: true, count: 0 };
    }

    const response = await withRetry(() => sheets.spreadsheets.values.append({
      spreadsheetId: spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      resource: {
        values: rowsArray
      }
    }));

    // Invalidate cache
    sheetDataCache.delete(sheetName);

    console.log(`✅ Batch ${rowsArray.length} row(s) appended to "${sheetName}" in 1 API call!`);
    return { success: true, updates: response.data.updates, count: rowsArray.length };
  } catch (error) {
    console.error(`❌ Error batch appending to "${sheetName}":`, error.message);
    throw error;
  }
}

/**
 * Update an existing row in a sheet
 * @param {string} sheetName - Name of the sheet tab
 * @param {number} rowIndex - Row number (1-indexed, including header)
 * @param {Array} rowData - Array of values to update
 * @returns {Object} Success status
 */
async function updateRow(sheetName, rowIndex, rowData) {
  try {
    // Validate row index
    if (rowIndex < 2) {
      throw new Error(`Invalid row index: ${rowIndex}. Must be >= 2 (row 1 is header)`);
    }
    
    const response = await withRetry(() => sheets.spreadsheets.values.update({
      spreadsheetId: spreadsheetId,
      range: `${sheetName}!A${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [rowData]
      }
    }));
    
    console.log(`✅ Row ${rowIndex} updated in "${sheetName}"`);
    return { success: true, updates: response.data.updatedCells };
  } catch (error) {
    console.error(`❌ Error updating row ${rowIndex} in "${sheetName}":`, error.message);
    throw error;
  }
}

/**
 * Find row index by column name and value
 * @param {string} sheetName - Name of the sheet tab
 * @param {string} columnName - Name of the column to search
 * @param {string} value - Value to find
 * @returns {number} Row number (1-indexed) or -1 if not found
 */
async function findRowIndex(sheetName, columnName, value) {
  try {
    console.log(`🔍 Searching for "${columnName}" = "${value}" in "${sheetName}"`);
    
    const data = await getSheetData(sheetName);
    
    if (!data || data.length === 0) {
      console.log(`📭 No data found in "${sheetName}"`);
      return -1;
    }
    
    // Normalize search value
    const searchValue = String(value).trim();
    
    // Find matching row
    const rowIndex = data.findIndex(row => {
      const cellValue = String(row[columnName] || '').trim();
      return cellValue === searchValue;
    });
    
    if (rowIndex === -1) {
      console.log(`❌ Value "${value}" not found in column "${columnName}"`);
      console.log(`   Available values:`, data.slice(0, 5).map(r => r[columnName]));
      return -1;
    }
    
    // Convert array index to Google Sheets row number
    // Array index 0 = Row 2 in Google Sheets (Row 1 is header)
    const googleSheetsRowNumber = rowIndex + 2;
    
    console.log(`✅ Found "${value}" at row ${googleSheetsRowNumber}`);
    return googleSheetsRowNumber;
  } catch (error) {
    console.error(`❌ Error finding row index in "${sheetName}":`, error.message);
    return -1;
  }
}

/**
 * Delete a row from a sheet (clears all cells in the row)
 * @param {string} sheetName - Name of the sheet tab
 * @param {number} rowIndex - Row number (1-indexed)
 * @returns {Object} Success status
 */
async function deleteRow(sheetName, rowIndex) {
  try {
    const sheetId = await getSheetId(sheetName);
    
    await withRetry(() => sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId: sheetId,
                dimension: 'ROWS',
                startIndex: rowIndex - 1, // 0-indexed, inclusive
                endIndex: rowIndex        // 0-indexed, exclusive
              }
            }
          }
        ]
      }
    }));
    
    console.log(`✅ Row ${rowIndex} physically deleted in "${sheetName}"`);
    return { success: true };
  } catch (error) {
    console.error(`❌ Error deleting row ${rowIndex} from "${sheetName}":`, error.message);
    throw error;
  }
}

/**
 * Update specific columns in a row (partial update)
 * @param {string} sheetName - Name of the sheet tab
 * @param {number} rowIndex - Row number (1-indexed)
 * @param {Object} updates - Object with column names as keys and new values
 * @returns {Object} Success status
 */
async function updatePartialRow(sheetName, rowIndex, updates) {
  try {
    // Get current row data
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: `${sheetName}!A${rowIndex}:Z${rowIndex}`
    });
    
    const currentRow = response.data.values[0] || [];
    
    // Get headers to map column names to indices
    const headerResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: `${sheetName}!A1:Z1`
    });
    
    const headers = headerResponse.data.values[0].map(h => (h || '').trim());
    
    // Update specific columns
    Object.keys(updates).forEach(columnName => {
      const columnIndex = headers.indexOf(columnName);
      if (columnIndex !== -1) {
        currentRow[columnIndex] = updates[columnName];
      } else {
        console.warn(`⚠️ Column "${columnName}" not found in "${sheetName}"`);
      }
    });
    
    // Update the row
    await updateRow(sheetName, rowIndex, currentRow);
    
    console.log(`✅ Partial update completed for row ${rowIndex} in "${sheetName}"`);
    return { success: true };
  } catch (error) {
    console.error(`❌ Error updating partial row ${rowIndex} in "${sheetName}":`, error.message);
    throw error;
  }
}

/**
 * Robustly log an access event to ROOM_ACCESS, pulling details from USERS and ROOMS
 */
async function logAccessEvent({ action, authMethod, status, userId, roomId, details, durationMinutes }) {
  try {
    let userName = 'Unknown';
    let department = 'N/A';
    let roomName = 'Unknown Room';

    // Fetch User Info
    if (userId && userId !== 'SYSTEM') {
      const users = await getSheetData('USERS');
      const user = users.find(u => u.userid === userId || u.userId === userId);
      if (user) {
        userName = user.username || user.name || userName;
        department = user.department || department;
      }
    } else if (userId === 'SYSTEM') {
      userName = 'System Process';
      department = 'System';
    }

    // Fetch Room Info
    if (roomId && roomId !== 'UNKNOWN') {
      const rooms = await getSheetData('ROOMS');
      const room = rooms.find(r => r.roomId === roomId || r.roomid === roomId);
      if (room) {
        roomName = room.roomName || room.roomname || roomName;
      }
    }

    const accessId = `LOG-${Date.now()}`;
    const timestamp = new Date().toISOString();

    const rowData = [
      accessId,
      timestamp,
      userId || 'N/A',
      userName,
      department,
      roomId || 'N/A',
      roomName,
      action || 'UNKNOWN',
      authMethod || 'UNKNOWN',
      status || 'UNKNOWN',
      details || '',
      durationMinutes ? String(durationMinutes) : ''
    ];

    await appendRow('ROOM_ACCESS', rowData);
    console.log(`📝 Central Log: [${action}] ${userName} → ${roomName} (${status})`);
    return { success: true, accessId };
  } catch (error) {
    console.error('❌ Central Log Error:', error.message);
    // Don't throw, just swallow the error so it doesn't break the main request
    return { success: false, error: error.message };
  }
}

module.exports = {
  getSheetData,
  appendRow,
  appendRows,
  updateRow,
  findRowIndex,
  deleteRow,
  updatePartialRow,
  logAccessEvent
};