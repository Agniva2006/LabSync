const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

// ==================== DEFAULT DATABASE SCHEMA ====================

const SHEET_HEADERS = {
  USERS: ['userId', 'username', 'email', 'password', 'role', 'department', 'authorized_rooms', 'fingerprintId', 'faceDescriptor', 'faceStatus'],
  ROOMS: ['roomId', 'roomName', 'securityLevel', 'status'],
  ROOM_ACCESS: ['logId', 'timestamp', 'userId', 'userName', 'department', 'roomId', 'roomName', 'action', 'authMethod', 'status', 'details', 'durationMinutes'],
  NOTIFICATIONS: ['notificationId', 'userId', 'title', 'message', 'type', 'isRead', 'timestamp'],
  REQUESTS: ['requestId', 'userId', 'userName', 'type', 'itemOrRoomId', 'itemOrRoomName', 'purpose', 'status', 'requestDate', 'decisionDate', 'adminComment'],
  INVENTORY: ['itemId', 'name', 'category', 'status', 'location', 'assignedTo', 'lastUpdated'],
  SYSTEM_TELEMETRY: ['telemetryId', 'timestamp', 'deviceId', 'roomId', 'rssi', 'freeHeap', 'uptime']
};

const DEFAULT_SEEDS = {
  USERS: [
    {
      userid: 'USR-001',
      username: 'Agniva Ghosh',
      email: 'agnivaghosh2006@gmail.com',
      password: '$2a$10$Q7NvwZVWG6.QlIZEPE8hMubZoIpbtedjHiLpQCOc5UJPbvEeph8uK', // 'user123'
      role: 'admin',
      department: 'Computer Science & AI',
      authorized_rooms: 'ROOM-001,ROOM-002',
      fingerprintid: '1',
      facedescriptor: '',
      facestatus: 'NOT_ENROLLED'
    },
    {
      userid: 'USR-002',
      username: 'Milan Samanta',
      email: 'milan@iitkgp.ac.in',
      password: '$2a$10$Q7NvwZVWG6.QlIZEPE8hMubZoIpbtedjHiLpQCOc5UJPbvEeph8uK',
      role: 'user',
      department: 'Mechanical Engineering',
      authorized_rooms: 'ROOM-001',
      fingerprintid: '2',
      facedescriptor: '',
      facestatus: 'NOT_ENROLLED'
    }
  ],
  ROOMS: [
    {
      roomid: 'ROOM-001',
      roomname: 'Advanced IoT & Robotics Lab',
      securitylevel: 'LOW',
      status: 'ACTIVE'
    },
    {
      roomid: 'ROOM-002',
      roomname: 'High-Security Biomaterials Vault',
      securitylevel: 'HIGH',
      status: 'ACTIVE'
    }
  ],
  ROOM_ACCESS: [],
  NOTIFICATIONS: [],
  REQUESTS: [],
  INVENTORY: [],
  SYSTEM_TELEMETRY: []
};

// Local JSON DB File Path
const dataDir = path.join(__dirname, '../data');
const localDbPath = path.join(dataDir, 'local_db.json');

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// In-memory local database representation
let localDb = null;

function loadLocalDb() {
  if (localDb) return localDb;
  try {
    if (fs.existsSync(localDbPath)) {
      const raw = fs.readFileSync(localDbPath, 'utf8');
      localDb = JSON.parse(raw);
      console.log(`📂 [DATABASE-LOCAL] Loaded local database from ${localDbPath}`);
    } else {
      localDb = JSON.parse(JSON.stringify(DEFAULT_SEEDS));
      saveLocalDb();
      console.log(`✨ [DATABASE-LOCAL] Seeded initial local database at ${localDbPath}`);
    }
  } catch (err) {
    console.warn(`⚠️ [DATABASE-LOCAL] Error reading local_db.json: ${err.message}, re-initializing seeds`);
    localDb = JSON.parse(JSON.stringify(DEFAULT_SEEDS));
    saveLocalDb();
  }
  return localDb;
}

function saveLocalDb() {
  if (!localDb) return;
  try {
    fs.writeFileSync(localDbPath, JSON.stringify(localDb, null, 2), 'utf8');
  } catch (err) {
    console.error(`❌ [DATABASE-LOCAL] Error saving local_db.json: ${err.message}`);
  }
}

// Initialize local DB
loadLocalDb();

// ==================== GOOGLE SHEETS API INITIALIZATION ====================

let sheets = null;
let spreadsheetId = process.env.SPREADSHEET_ID || '1swE1x8y7xNFaPFZovR9BJ6usq7baM3gGkXqNI8cgWmI';
let isSheetsConfigured = false;

try {
  let credentials = null;

  if (process.env.GOOGLE_CREDENTIALS) {
    try {
      credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
      console.log('🔑 [DATABASE-INIT] Using Google credentials from GOOGLE_CREDENTIALS environment variable');
    } catch (e) {
      console.warn('⚠️ [DATABASE-INIT] Failed to parse GOOGLE_CREDENTIALS json:', e.message);
    }
  }

  if (!credentials) {
    const filePath = path.join(__dirname, '../config/service-account.json');
    if (fs.existsSync(filePath)) {
      try {
        credentials = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        console.log(`🔑 [DATABASE-INIT] Using Google credentials from local file (${filePath})`);
      } catch (e) {
        console.warn(`⚠️ [DATABASE-INIT] Failed to parse ${filePath}:`, e.message);
      }
    }
  }

  if (credentials) {
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    sheets = google.sheets({ version: 'v4', auth });
    isSheetsConfigured = true;
    console.log(`🌐 [DATABASE-INIT] Google Sheets API initialized for Spreadsheet ID: ${spreadsheetId}`);
  } else {
    console.log('ℹ️ [DATABASE-INIT] No Google service-account.json found. Operating in LOCAL PERSISTENCE MODE (data/local_db.json).');
  }
} catch (initError) {
  console.warn(`⚠️ [DATABASE-INIT] Google Sheets init error (${initError.message}). Operating in LOCAL PERSISTENCE MODE.`);
}

// Cache for sheetName -> sheetId mapping
const sheetIdCache = new Map();
// Memory cache for sheet data (5 seconds TTL) to prevent API rate limit on sequential calls
const sheetDataCache = new Map();

/**
 * Get Sheet ID for a given Sheet Name (required for batchUpdate structural changes)
 */
async function getSheetId(sheetName) {
  if (!isSheetsConfigured || !sheets) return 0;
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
        console.warn(`⚠️ [SHEETS-RATE-LIMIT] Quota exceeded. Retrying attempt ${attempt}/${maxRetries} after ${Math.round(delay)}ms...`);
        await new Promise(res => setTimeout(res, delay));
      } else {
        throw error;
      }
    }
  }
}

// ==================== CRUD OPERATIONS ====================

/**
 * Get all data from a sheet
 * @param {string} sheetName - Name of the sheet tab (USERS, ROOMS, etc.)
 * @returns {Promise<Array>} Array of objects with lowercase headers as keys
 */
async function getSheetData(sheetName) {
  const startTime = Date.now();
  const cacheKey = sheetName.toUpperCase();

  // 1. Check in-memory cache
  const cached = sheetDataCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < 5000)) {
    return cached.data;
  }

  // 2. Try Google Sheets if configured
  if (isSheetsConfigured && sheets) {
    try {
      const response = await withRetry(() => sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A1:Z`
      }));

      const rows = response.data.values;
      if (!rows || rows.length < 2) {
        console.log(`📭 [DATABASE-READ] Sheets "${sheetName}" is empty or has only headers (${Date.now() - startTime}ms)`);
        sheetDataCache.set(cacheKey, { timestamp: Date.now(), data: [] });
        return [];
      }

      // Clean headers to lowercase
      const headers = rows[0].map(h => (h || '').trim());
      const data = [];

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.every(cell => !cell || cell.trim() === '')) continue;
        const obj = {
          _rowNumber: i + 1 // Exact physical Google Sheet Row Number (1-indexed, header is row 1)
        };
        headers.forEach((header, index) => {
          const key = header.toLowerCase();
          obj[key] = (row[index] || '').toString().trim();
          // Also keep original key
          obj[header] = obj[key];
        });
        data.push(obj);
      }

      sheetDataCache.set(cacheKey, { timestamp: Date.now(), data });
      console.log(`📊 [DATABASE-READ] (Sheets) Loaded ${data.length} row(s) from "${sheetName}" (${Date.now() - startTime}ms)`);
      
      // Mirror to local DB for backup — cleanly merge to preserve all users & biometrics
      const userMap = new Map();
      (localDb[cacheKey] || []).forEach(item => {
        const id = (item.userid || item.userId || item.id || '').toLowerCase();
        if (id) userMap.set(id, item);
      });

      data.forEach(sheetItem => {
        const id = (sheetItem.userid || sheetItem.userId || sheetItem.id || '').toLowerCase();
        if (id) {
          const localMatch = userMap.get(id) || {};
          userMap.set(id, {
            ...localMatch,
            ...sheetItem,
            _rowNumber: sheetItem._rowNumber || localMatch._rowNumber,
            fingerprintid: (sheetItem.fingerprintid && sheetItem.fingerprintid !== '') ? sheetItem.fingerprintid : (localMatch.fingerprintid || localMatch.fingerprintId || ''),
            fingerprintId: (sheetItem.fingerprintId && sheetItem.fingerprintId !== '') ? sheetItem.fingerprintId : (localMatch.fingerprintId || localMatch.fingerprintid || ''),
            facedescriptor: (sheetItem.facedescriptor && sheetItem.facedescriptor.length > 50) ? sheetItem.facedescriptor : (localMatch.facedescriptor || localMatch.faceDescriptor || ''),
            faceDescriptor: (sheetItem.faceDescriptor && sheetItem.faceDescriptor.length > 50) ? sheetItem.faceDescriptor : (localMatch.faceDescriptor || localMatch.facedescriptor || ''),
            facestatus: (sheetItem.facestatus && sheetItem.facestatus !== 'NOT_ENROLLED') ? sheetItem.facestatus : (localMatch.facestatus || localMatch.faceStatus || sheetItem.facestatus || 'NOT_ENROLLED'),
            faceStatus: (sheetItem.faceStatus && sheetItem.faceStatus !== 'NOT_ENROLLED') ? sheetItem.faceStatus : (localMatch.faceStatus || localMatch.facestatus || sheetItem.faceStatus || 'NOT_ENROLLED'),
          });
        }
      });

      localDb[cacheKey] = Array.from(userMap.values());
      saveLocalDb();
      return data;
    } catch (sheetErr) {
      console.warn(`⚠️ [DATABASE-READ] Sheets read error for "${sheetName}" (${sheetErr.message}). Falling back to local DB.`);
    }
  }

  // 3. Fallback to Local JSON DB
  const data = localDb[cacheKey] || [];
  sheetDataCache.set(cacheKey, { timestamp: Date.now(), data });
  console.log(`📊 [DATABASE-READ] (Local DB) Loaded ${data.length} row(s) from "${sheetName}" (${Date.now() - startTime}ms)`);
  return data;
}

/**
 * Append a new row to a sheet
 * @param {string} sheetName - Name of the sheet tab
 * @param {Array} rowData - Array of values for the new row
 * @returns {Promise<Object>} Success status
 */
async function appendRow(sheetName, rowData) {
  const startTime = Date.now();
  const cacheKey = sheetName.toUpperCase();
  sheetDataCache.delete(cacheKey);

  // Update local DB representation
  const headers = SHEET_HEADERS[cacheKey] || [];
  const rowObj = {};
  headers.forEach((h, idx) => {
    const val = rowData[idx] !== undefined ? String(rowData[idx]) : '';
    rowObj[h.toLowerCase()] = val;
    rowObj[h] = val;
  });

  if (!localDb[cacheKey]) localDb[cacheKey] = [];
  if (cacheKey === 'NOTIFICATIONS') {
    rowObj['read'] = rowObj['isread'] || rowObj['isRead'] || 'false';
    rowObj['createdAt'] = rowObj['timestamp'] || new Date().toISOString();
  }
  localDb[cacheKey].push(rowObj);
  saveLocalDb();

  // If online, also push to Google Sheets
  if (isSheetsConfigured && sheets) {
    try {
      const response = await withRetry(() => sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        resource: { values: [rowData] }
      }));
      console.log(`✅ [DATABASE-WRITE] (Sheets) Row appended to "${sheetName}" (${Date.now() - startTime}ms)`);
      return { success: true, updates: response.data.updates };
    } catch (sheetErr) {
      console.warn(`⚠️ [DATABASE-WRITE] Sheets append failed for "${sheetName}" (${sheetErr.message}). Saved locally.`);
      return { success: true, localOnly: true };
    }
  }

  console.log(`✅ [DATABASE-WRITE] (Local DB) Row appended to "${sheetName}" (${Date.now() - startTime}ms)`);
  return { success: true, localOnly: true };
}

/**
 * Append multiple rows to a sheet
 */
async function appendRows(sheetName, rowsArray) {
  if (!Array.isArray(rowsArray) || rowsArray.length === 0) {
    return { success: true, count: 0 };
  }
  for (const row of rowsArray) {
    await appendRow(sheetName, row);
  }
  return { success: true, count: rowsArray.length };
}

/**
 * Update an existing row in a sheet
 * @param {string} sheetName - Name of the sheet tab
 * @param {number} rowIndex - Row number (1-indexed, including header: row 2 = 1st data row)
 * @param {Array} rowData - Array of values to update
 */
async function updateRow(sheetName, rowIndex, rowData) {
  const startTime = Date.now();
  const cacheKey = sheetName.toUpperCase();
  sheetDataCache.delete(cacheKey);

  // Update local DB
  const headers = SHEET_HEADERS[cacheKey] || [];
  const rowObj = { _rowNumber: rowIndex };
  headers.forEach((h, idx) => {
    const val = rowData[idx] !== undefined ? String(rowData[idx]) : '';
    rowObj[h.toLowerCase()] = val;
    rowObj[h] = val;
  });

  if (!localDb[cacheKey]) localDb[cacheKey] = [];
  
  // Find matching row in localDb by ID or by _rowNumber
  const primaryKey = headers[0] ? headers[0].toLowerCase() : 'id';
  const targetId = String(rowObj[primaryKey] || '').toLowerCase();
  
  const existingIdx = localDb[cacheKey].findIndex(item => {
    if (targetId && String(item[primaryKey] || item[headers[0]] || '').toLowerCase() === targetId) return true;
    if (item._rowNumber && item._rowNumber === rowIndex) return true;
    return false;
  });

  if (existingIdx !== -1) {
    localDb[cacheKey][existingIdx] = { ...localDb[cacheKey][existingIdx], ...rowObj };
  } else {
    localDb[cacheKey].push(rowObj);
  }
  saveLocalDb();

  // If online, update Google Sheets
  if (isSheetsConfigured && sheets) {
    try {
      const response = await withRetry(() => sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!A${rowIndex}`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [rowData] }
      }));
      console.log(`✅ [DATABASE-WRITE] (Sheets) Row ${rowIndex} updated in "${sheetName}" (${Date.now() - startTime}ms)`);
      return { success: true, updates: response.data.updatedCells };
    } catch (sheetErr) {
      console.warn(`⚠️ [DATABASE-WRITE] Sheets update failed for row ${rowIndex} in "${sheetName}" (${sheetErr.message}). Saved locally.`);
      return { success: true, localOnly: true };
    }
  }

  console.log(`✅ [DATABASE-WRITE] (Local DB) Row ${rowIndex} updated in "${sheetName}" (${Date.now() - startTime}ms)`);
  return { success: true, localOnly: true };
}

/**
 * Find row index by column name and value (1-indexed row number for Sheets)
 */
async function findRowIndex(sheetName, columnName, value) {
  try {
    const data = await getSheetData(sheetName);
    if (!data || data.length === 0) return -1;

    const normSearch = String(value || '').trim().toLowerCase();
    const colLower = String(columnName).trim().toLowerCase();

    const matchedRow = data.find(row => {
      const cellVal = String(row[colLower] || row[columnName] || '').trim().toLowerCase();
      return cellVal === normSearch;
    });

    if (!matchedRow) return -1;
    // Always use true Google Sheets row number attached during read
    return matchedRow._rowNumber || (data.indexOf(matchedRow) + 2);
  } catch (err) {
    console.error(`❌ [DATABASE-FIND] Error finding row in "${sheetName}":`, err.message);
    return -1;
  }
}

/**
 * Delete a row from a sheet
 */
async function deleteRow(sheetName, rowIndex) {
  const cacheKey = sheetName.toUpperCase();
  sheetDataCache.delete(cacheKey);

  // Remove from local DB by _rowNumber or fallback to array index
  if (localDb[cacheKey]) {
    const idx = localDb[cacheKey].findIndex(item => item._rowNumber === rowIndex);
    if (idx !== -1) {
      localDb[cacheKey].splice(idx, 1);
    } else {
      const arrayIndex = rowIndex - 2;
      if (arrayIndex >= 0 && arrayIndex < localDb[cacheKey].length) {
        localDb[cacheKey].splice(arrayIndex, 1);
      }
    }
    saveLocalDb();
  }

  if (isSheetsConfigured && sheets) {
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
                  startIndex: rowIndex - 1,
                  endIndex: rowIndex
                }
              }
            }
          ]
        }
      }));
      console.log(`✅ [DATABASE-DELETE] (Sheets) Row ${rowIndex} deleted in "${sheetName}"`);
      return { success: true };
    } catch (sheetErr) {
      console.warn(`⚠️ [DATABASE-DELETE] Sheets delete failed (${sheetErr.message}). Removed locally.`);
    }
  }

  console.log(`✅ [DATABASE-DELETE] (Local DB) Row ${rowIndex} deleted in "${sheetName}"`);
  return { success: true };
}

/**
 * Update specific columns in a row
 */
async function updatePartialRow(sheetName, rowIndex, updates) {
  try {
    const data = await getSheetData(sheetName);
    const arrayIndex = rowIndex - 2;
    const existing = data[arrayIndex] || {};

    const cacheKey = sheetName.toUpperCase();
    const headers = SHEET_HEADERS[cacheKey] || Object.keys(existing);

    const merged = { ...existing };
    for (const [k, v] of Object.entries(updates)) {
      merged[k.toLowerCase()] = v;
      merged[k] = v;
    }

    const rowData = headers.map(h => {
      const val = merged[h.toLowerCase()] !== undefined ? merged[h.toLowerCase()] : (merged[h] || '');
      return String(val);
    });

    return await updateRow(sheetName, rowIndex, rowData);
  } catch (err) {
    console.error(`❌ [DATABASE-UPDATE-PARTIAL] Error in "${sheetName}":`, err.message);
    throw err;
  }
}

// ==================== ASYNC WRITE-BEHIND ACCESS LOG QUEUE ====================
let accessLogQueue = [];
let logFlushTimer = null;

async function flushAccessLogs() {
  if (accessLogQueue.length === 0) return;
  const batch = accessLogQueue.splice(0, accessLogQueue.length);

  if (isSheetsConfigured && sheets) {
    try {
      await withRetry(() => sheets.spreadsheets.values.append({
        spreadsheetId,
        range: 'ROOM_ACCESS!A1',
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        resource: { values: batch }
      }));
      console.log(`✅ [AUDIT-BATCH] Successfully flushed ${batch.length} access log(s) to Google Sheets`);
    } catch (err) {
      console.warn(`⚠️ [AUDIT-BATCH] Failed to flush logs to Google Sheets (${err.message}). Retained in local DB.`);
    }
  }
}

function queueAccessLog(rowData) {
  accessLogQueue.push(rowData);
  if (accessLogQueue.length >= 5) {
    if (logFlushTimer) {
      clearTimeout(logFlushTimer);
      logFlushTimer = null;
    }
    flushAccessLogs();
  } else if (!logFlushTimer) {
    logFlushTimer = setTimeout(() => {
      logFlushTimer = null;
      flushAccessLogs();
    }, 4000); // Flush every 4 seconds
  }
}

/**
 * Robustly log an access event to ROOM_ACCESS (Immediate Local DB + Batched Sheets)
 */
async function logAccessEvent({ action, authMethod, status, userId, roomId, details, durationMinutes }) {
  try {
    let userName = 'Unknown';
    let department = 'N/A';
    let roomName = roomId || 'Unknown Room';

    // Fetch User Info
    if (userId && userId !== 'SYSTEM') {
      try {
        const users = await getSheetData('USERS');
        const normUser = String(userId).toLowerCase();
        const user = users.find(u => String(u.userid || u.userId || '').toLowerCase() === normUser);
        if (user) {
          userName = user.username || user.name || userName;
          department = user.department || department;
        }
      } catch (e) { /* non-critical */ }
    } else if (userId === 'SYSTEM') {
      userName = 'System Process';
      department = 'System';
    }

    // Fetch Room Info
    if (roomId && roomId !== 'UNKNOWN') {
      try {
        const rooms = await getSheetData('ROOMS');
        const normRoom = String(roomId).toLowerCase();
        const room = rooms.find(r => String(r.roomid || r.roomId || '').toLowerCase() === normRoom);
        if (room) {
          roomName = room.roomname || room.roomName || roomName;
        }
      } catch (e) { /* non-critical */ }
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

    // 1. Immediately record in localDb (0ms latency, zero drop)
    if (!localDb['ROOM_ACCESS']) localDb['ROOM_ACCESS'] = [];
    const headers = SHEET_HEADERS['ROOM_ACCESS'] || [];
    const rowObj = {};
    headers.forEach((h, idx) => {
      const val = rowData[idx] !== undefined ? String(rowData[idx]) : '';
      rowObj[h.toLowerCase()] = val;
      rowObj[h] = val;
    });
    localDb['ROOM_ACCESS'].push(rowObj);
    saveLocalDb();

    // 2. Queue for batched Google Sheets append (avoids 429 quota limits)
    queueAccessLog(rowData);

    console.log(`📝 [AUDIT-LOG] [${action}] User: ${userName} (${userId}) | Room: ${roomName} (${roomId}) | Method: ${authMethod} | Status: ${status}`);
    return { success: true, accessId };
  } catch (error) {
    console.error('❌ [AUDIT-LOG] Log error:', error.message);
    return { success: false, error: error.message };
  }
}

function getLocalDbData(sheetName) {
  const cacheKey = sheetName.toUpperCase();
  return localDb[cacheKey] || [];
}

module.exports = {
  getSheetData,
  getLocalDbData,
  appendRow,
  appendRows,
  updateRow,
  findRowIndex,
  deleteRow,
  updatePartialRow,
  logAccessEvent,
  isSheetsConfigured: () => isSheetsConfigured
};