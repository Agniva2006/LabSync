const express = require('express');
const router = express.Router();
const { getSheetData } = require('../services/sheetsService');

// GET /api/dashboard/stats
router.get('/stats', async (req, res) => {
  try {
    const users = await getSheetData('USERS');
    const rooms = await getSheetData('ROOMS');
    const logs = await getSheetData('ROOM_ACCESS');
    
    const today = new Date().toISOString().split('T')[0];
    const todayLogs = logs.filter(log => log.timestamp && log.timestamp.startsWith(today));
    
    res.json({
      totalUsers: users.length,
      activeRooms: rooms.length,
      todayAccess: todayLogs.filter(l => l.status === 'GRANTED').length,
      deniedAccess: todayLogs.filter(l => l.status === 'DENIED').length,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/dashboard/recent-logs
router.get('/recent-logs', async (req, res) => {
  try {
    const logs = await getSheetData('ROOM_ACCESS');
    
    // Get last 20 logs, sorted by timestamp
    const recentLogs = logs
      .slice(-20)
      .reverse()
      .map(log => ({
        userId: log.userId,
        userName: log.userName,
        action: log.action,
        timestamp: log.timestamp,
        status: log.status,
        authMethod: log.authMethod,
      }));
    
    res.json({ logs: recentLogs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;