const { getSheetData, appendRow, updateRow, findRowIndex } = require('../services/sheetsService');

// Get all notifications for a user
exports.getUserNotifications = async (req, res) => {
  try {
    // Get userId from query parameter (for testing without JWT)
    const userId = req.query.userId;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'userId query parameter required' 
      });
    }

    const notifications = await getSheetData('NOTIFICATIONS');
    
    // Filter and sort by newest first
    const userNotifications = notifications
      .filter(notif => notif.userId === userId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    const unreadCount = userNotifications.filter(n => n.read === 'FALSE').length;
    
    res.json({
      success: true,
      count: userNotifications.length,
      unreadCount,
      data: userNotifications
    });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Mark notification as read
exports.markAsRead = async (req, res) => {
  try {
    const { notifId } = req.params;
    const rowIndex = await findRowIndex('NOTIFICATIONS', 'notifId', notifId);
    
    if (rowIndex === -1) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }
    
    await updateRow('NOTIFICATIONS', rowIndex, [null, null, null, 'TRUE', null, null, null, null, null]);
    
    res.json({ success: true, message: 'Notification marked as read' });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Mark all notifications as read
exports.markAllAsRead = async (req, res) => {
  try {
    const userId = req.query.userId;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'userId query parameter required' 
      });
    }
    
    const notifications = await getSheetData('NOTIFICATIONS');
    const unreadNotifications = notifications.filter(
      n => n.userId === userId && n.read === 'FALSE'
    );
    
    let updatedCount = 0;
    for (const notif of unreadNotifications) {
      const rowIndex = await findRowIndex('NOTIFICATIONS', 'notifId', notif.notifId);
      if (rowIndex !== -1) {
        await updateRow('NOTIFICATIONS', rowIndex, [null, null, null, 'TRUE', null, null, null, null, null]);
        updatedCount++;
      }
    }
    
    res.json({ 
      success: true, 
      message: `Marked ${updatedCount} notifications as read`,
      updatedCount 
    });
  } catch (error) {
    console.error('Error marking all as read:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Delete notification
exports.deleteNotification = async (req, res) => {
  try {
    const { notifId } = req.params;
    const rowIndex = await findRowIndex('NOTIFICATIONS', 'notifId', notifId);
    
    if (rowIndex === -1) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }
    
    // Clear the row
    await updateRow('NOTIFICATIONS', rowIndex, ['', '', '', '', '', '', '', '', '']);
    
    res.json({ success: true, message: 'Notification deleted' });
  } catch (error) {
    console.error('Error deleting notification:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Create notification (helper function)
exports.createNotification = async (userId, type, message, priority = 'medium', actionUrl = '', metadata = '') => {
  try {
    const notifId = `NOTIF-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const timestamp = new Date().toISOString();
    
    const rowData = [
      notifId,
      userId,
      message,
      'FALSE', // read status
      type,
      priority,
      timestamp,
      actionUrl,
      metadata
    ];
    
    await appendRow('NOTIFICATIONS', rowData);
    console.log(`🔔 Notification created: ${notifId} for user ${userId}`);
    return { success: true, notifId };
  } catch (error) {
    console.error('Error creating notification:', error);
    return { success: false, error: error.message };
  }
};