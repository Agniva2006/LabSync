const express = require('express');
const { getSheetData, appendRow, updateRow, findRowIndex, logAccessEvent, updatePartialRow } = require('../services/sheetsService');
const router = express.Router();

// ============================================
// HARDWARE ENDPOINTS (ESP32 - No Auth Required)
// ============================================

// POST /api/room-access/verify-fingerprint - Verify fingerprint access (ESP32 calls this)
router.post('/verify-fingerprint', async (req, res) => {
  try {
    const { fingerId, roomId } = req.body;

    if (!fingerId || !roomId) {
      return res.status(400).json({ 
        success: false, 
        message: 'fingerId and roomId are required' 
      });
    }

    // Get all users from the USERS sheet
    const users = await getSheetData('USERS');

    // Find the user with this specific fingerprintId
    // Note: Google Sheets returns everything as strings
    const user = users.find(u => u.fingerprintId === String(fingerId));

    if (!user) {
      return res.json({ 
        success: false, 
        message: 'Fingerprint not registered in system' 
      });
    }

    // Check if the user is authorized for this room
    const authorizedRooms = user.authorized_rooms ? user.authorized_rooms.split(',') : [];
    const cleanRooms = authorizedRooms.map(room => room.trim());

    if (cleanRooms.includes(roomId) || cleanRooms.includes('ALL')) {
      // ACCESS GRANTED
      console.log(`✅ ACCESS GRANTED: ${user.name} (Fingerprint #${fingerId}) → ${roomId}`);
      return res.json({ 
        success: true, 
        message: 'Access Granted',
        userId: user.userId,
        userName: user.name 
      });
    } else {
      // ACCESS DENIED
      console.log(`❌ ACCESS DENIED: ${user.name} (Fingerprint #${fingerId}) not authorized for ${roomId}`);
      return res.json({ 
        success: false, 
        message: 'User not authorized for this room' 
      });
    }

  } catch (error) {
    console.error('Error verifying fingerprint:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ============================================
// ADMIN ENDPOINTS (App-based management)
// ============================================

// GET /api/room-access/rooms - Get all rooms
router.get('/rooms', async (req, res) => {
  try {
    const rooms = await getSheetData('ROOMS');
    res.json({ success: true, data: rooms });
  } catch (error) {
    console.error('Error fetching rooms:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/room-access/add-room - Admin adds new room
router.post('/add-room', async (req, res) => {
  try {
    const { roomName, building, floor } = req.body;
    
    if (!roomName || !building || !floor) {
      return res.status(400).json({ success: false, message: 'All fields required' });
    }
    
    const roomId = `ROOM-${Date.now()}`;
    
    await appendRow('ROOMS', [roomId, roomName, building, floor]);
    
    console.log(`✅ Room added: ${roomName} (${roomId})`);
    res.json({ success: true, message: 'Room added successfully', roomId });
  } catch (error) {
    console.error('Error adding room:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/room-access/assign-permission - Assign room to user
router.post('/assign-permission', async (req, res) => {
  try {
    const { userId, roomId } = req.body;
    
    if (!userId || !roomId) {
      return res.status(400).json({ success: false, message: 'User ID and Room ID required' });
    }
    
    const users = await getSheetData('USERS');
    const userIndex = await findRowIndex('USERS', 'userId', userId);
    
    if (userIndex === -1) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    const user = users.find(u => u.userId === userId);
    let authorizedRooms = user.authorized_rooms ? user.authorized_rooms.split(',') : [];
    
    if (!authorizedRooms.includes(roomId)) {
      authorizedRooms.push(roomId);
      
      // Update user row with new authorized_rooms
      await updateRow('USERS', userIndex, [
        user.userId,
        user.name,
        user.email,
        user.password,
        user.role,
        user.department,
        authorizedRooms.join(',')
      ]);
      
      console.log(`✅ Permission assigned: ${user.name} → ${roomId}`);
    }
    
    res.json({ success: true, message: 'Permission assigned successfully' });
  } catch (error) {
    console.error('Error assigning permission:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================
// LOGGING ENDPOINTS (ESP32 & Simulator)
// ============================================

// POST /api/room-access/log-entry - Log room entry (called by ESP32 or simulator)
router.post('/log-entry', async (req, res) => {
  try {
    const { userId, userName, roomId, roomName } = req.body;
    
    if (!userId || !roomId) {
      return res.status(400).json({ success: false, message: 'User ID and Room ID required' });
    }
    
    // Check if user is authorized for this room
    const users = await getSheetData('USERS');
    const user = users.find(u => u.userId === userId);
    
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    const authorizedRooms = user.authorized_rooms ? user.authorized_rooms.split(',') : [];
    if (!authorizedRooms.includes(roomId)) {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied: User not authorized for this room' 
      });
    }
    
    const { accessId } = await logAccessEvent({
      action: 'ENTRY',
      authMethod: 'SYSTEM',
      status: 'GRANTED',
      userId: userId,
      roomId: roomId
    });
    
    console.log(`🚪 Entry logged: ${userName || user.name} → ${roomName || roomId}`);
    
    res.json({ 
      success: true, 
      message: 'Entry logged successfully', 
      accessId, 
      timestamp 
    });
  } catch (error) {
    console.error('Error logging entry:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/room-access/log-exit - Log room exit WITH DURATION CALCULATION
router.post('/log-exit', async (req, res) => {
  try {
    const { userId, userName, roomId, roomName } = req.body;
    
    if (!userId || !roomId) {
      return res.status(400).json({ success: false, message: 'User ID and Room ID required' });
    }
    
    // Find the latest ENTRY log for this user in this room
    const logs = await getSheetData('ROOM_ACCESS');
    const lastEntry = logs.reverse().find(log => 
      log.userId === userId && 
      log.roomId === roomId && 
      log.action === 'ENTRY'
    );
    
    let durationMinutes = null;
    let entryTime = null;
    
    if (lastEntry) {
      entryTime = new Date(lastEntry.timestamp);
      const exitTime = new Date();
      durationMinutes = Math.floor((exitTime - entryTime) / 60000); // in minutes
      
      // Update the entry log with duration using partial update
      const entryIndex = await findRowIndex('ROOM_ACCESS', 'accessId', lastEntry.accessId);
      if (entryIndex !== -1) {
        await updatePartialRow('ROOM_ACCESS', entryIndex, { durationMinutes: durationMinutes.toString() });
      }
    }
    
    // Log EXIT
    await logAccessEvent({
      action: 'EXIT',
      authMethod: 'SYSTEM',
      status: 'SUCCESS',
      userId: userId,
      roomId: roomId,
      durationMinutes: durationMinutes
    });
    
    console.log(`🚪 Exit logged: ${userName || 'Unknown'} stayed ${durationMinutes || 'N/A'} minutes`);
    
    res.json({ 
      success: true, 
      message: 'Exit logged successfully', 
      durationMinutes,
      entryTime 
    });
  } catch (error) {
    console.error('Error logging exit:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================
// QUERY ENDPOINTS (App-based viewing)
// ============================================

// GET /api/room-access/logs - Get all access logs
router.get('/logs', async (req, res) => {
  try {
    const logs = await getSheetData('ROOM_ACCESS');
    
    // Sort by timestamp descending (newest first)
    logs.sort((a, b) => {
      const dateA = a.timestamp ? new Date(a.timestamp) : new Date(0);
      const dateB = b.timestamp ? new Date(b.timestamp) : new Date(0);
      return dateB - dateA;
    });
    
    res.json({ success: true, data: logs });
  } catch (error) {
    console.error('Error fetching logs:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/room-access/user-permissions/:userId - Get rooms authorized for a user
router.get('/user-permissions/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const users = await getSheetData('USERS');
    const user = users.find(u => u.userId === userId);
    
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    const authorizedRoomIds = user.authorized_rooms 
      ? user.authorized_rooms.split(',').map(r => r.trim()).filter(r => r)
      : [];
    
    const allRooms = await getSheetData('ROOMS');
    const authorizedRooms = allRooms.filter(room => authorizedRoomIds.includes(room.roomId));
    
    res.json({ success: true, data: authorizedRooms });
  } catch (error) {
    console.error('Error fetching user permissions:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/room-access/currently-inside/:roomId - Get who's currently inside a room
router.get('/currently-inside/:roomId', async (req, res) => {
  try {
    const { roomId } = req.params;
    const logs = await getSheetData('ROOM_ACCESS');
    const users = await getSheetData('USERS');
    
    // Filter entry logs for this room
    const entries = logs.filter(log => 
      (log.roomId === roomId || log.roomid === roomId) && 
      (log.action === 'ENTRY' || log.action === 'GRANTED' || log.action === 'REMOTE_UNLOCK')
    );
    
    // Filter exit logs for this room
    const exits = logs.filter(log => 
      (log.roomId === roomId || log.roomid === roomId) && 
      (log.action === 'EXIT')
    );
    
    // Track unique users to show latest active session
    const currentlyInsideMap = new Map();
    const MAX_SESSION_MINUTES = 720; // 12 hours max session cap to avoid stale 936h entries
    
    for (const entry of entries) {
      const uId = entry.userId || entry.userid;
      if (!uId) continue;

      const hasExited = exits.some(exit => 
        (exit.userId === uId || exit.userid === uId) && 
        new Date(exit.timestamp) > new Date(entry.timestamp)
      );
      
      if (!hasExited) {
        const entryTime = new Date(entry.timestamp);
        const durationSoFar = Math.floor((Date.now() - entryTime.getTime()) / 60000);
        
        // Only consider active if entry was within last 12 hours (720 mins)
        if (durationSoFar >= 0 && durationSoFar <= MAX_SESSION_MINUTES) {
          // Resolve full user name from USERS sheet if missing
          const userRecord = users.find(u => u.userId === uId || u.userid === uId);
          const resolvedName = userRecord ? (userRecord.username || userRecord.name) : (entry.userName || uId);

          currentlyInsideMap.set(uId, {
            userId: uId,
            userName: resolvedName,
            entryTime: entry.timestamp,
            durationSoFar: durationSoFar
          });
        }
      }
    }
    
    const currentlyInside = Array.from(currentlyInsideMap.values());
    console.log(`👥 Room ${roomId}: ${currentlyInside.length} active people inside`);
    
    res.json({ success: true, data: currentlyInside });
  } catch (error) {
    console.error('Error fetching current occupancy:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;