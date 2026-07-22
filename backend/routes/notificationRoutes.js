const express = require('express');
const router = express.Router();
const { getUserNotifications, markAsRead, markAllAsRead, deleteNotification } = require('../services/notificationService');

// GET /api/notifications - Get all notifications for user
router.get('/', async (req, res) => {
  try {
    const userId = req.query.userId || req.headers['x-user-id'];
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required',
      });
    }

    const result = await getUserNotifications(userId);
    res.json(result);
  } catch (error) {
    console.error('❌ Error fetching notifications:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch notifications',
    });
  }
});

// PUT /api/notifications/:notifId/read - Mark as read
router.put('/:notifId/read', async (req, res) => {
  try {
    const { notifId } = req.params;
    const success = await markAsRead(notifId);
    
    if (success) {
      res.json({ success: true, message: 'Notification marked as read' });
    } else {
      res.status(500).json({ success: false, message: 'Failed to mark as read' });
    }
  } catch (error) {
    console.error('❌ Error marking notification as read:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to mark as read',
    });
  }
});

// PUT /api/notifications/read-all - Mark all as read
router.put('/read-all', async (req, res) => {
  try {
    const userId = req.query.userId || req.headers['x-user-id'];
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required',
      });
    }

    const success = await markAllAsRead(userId);
    
    if (success) {
      res.json({ success: true, message: 'All notifications marked as read' });
    } else {
      res.status(500).json({ success: false, message: 'Failed to mark all as read' });
    }
  } catch (error) {
    console.error('❌ Error marking all as read:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to mark all as read',
    });
  }
});

// DELETE /api/notifications/:notifId - Delete notification
router.delete('/:notifId', async (req, res) => {
  try {
    const { notifId } = req.params;
    const success = await deleteNotification(notifId);
    
    if (success) {
      res.json({ success: true, message: 'Notification deleted' });
    } else {
      res.status(500).json({ success: false, message: 'Failed to delete notification' });
    }
  } catch (error) {
    console.error('❌ Error deleting notification:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to delete notification',
    });
  }
});

module.exports = router;