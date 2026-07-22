const { getSheetData, appendRow, findRowIndex, updateRow } = require('../services/sheetsService');

// --- VERIFY FINGERPRINT (FOR ESP32 HARDWARE) ---
exports.verifyFingerprint = async (req, res) => {
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
      return res.json({ 
        success: true, 
        message: 'Access Granted',
        userId: user.userId,
        userName: user.name 
      });
    } else {
      return res.json({ 
        success: false, 
        message: 'User not authorized for this room' 
      });
    }

  } catch (error) {
    console.error('Error verifying fingerprint:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// --- LOG ROOM ENTRY ---
exports.logRoomAccess = async (req, res) => {
  try {
    const { fingerId, roomId, roomName, action } = req.body;

    const users = await getSheetData('USERS');
    const user = users.find(u => u.fingerprintId === String(fingerId));

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const logId = `ACC-${Date.now()}`;
    const timestamp = new Date().toISOString();

    await appendRow('ROOM_ACCESS', [
      logId,
      user.userId,
      user.name,
      roomId,
      roomName,
      action,
      timestamp
    ]);

    res.json({ success: true, message: 'Access logged successfully' });

  } catch (error) {
    console.error('Error logging room access:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};