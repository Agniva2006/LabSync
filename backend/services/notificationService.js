const { getSheetData, appendRow, findRowIndex, updateRow } = require('./sheetsService');

// ==================== CREATE NOTIFICATION ====================
async function createNotification(userId, title, message, type = 'info') {
  try {
    const notifId = `NOTIF-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
    const timestamp = new Date().toISOString();

    await appendRow('NOTIFICATIONS', [
      notifId,
      userId,
      title,
      message,
      type,      // info | success | warning | error | REQUEST | ACCESS_GRANTED | ACCESS_DENIED
      'false',   // read status
      timestamp,
    ]);

    console.log(`📬 Notification created for ${userId}: ${title}`);
    return notifId;
  } catch (error) {
    console.error('❌ Error creating notification:', error.message);
    return null;
  }
}

// ==================== GET USER NOTIFICATIONS ====================
async function getUserNotifications(userId) {
  try {
    const notifications = await getSheetData('NOTIFICATIONS');
    const userNotifs = notifications
      .filter(n => (n.userId || n.userid) === userId && n.read !== 'DELETED')
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const unreadCount = userNotifs.filter(n => n.read === 'false').length;

    return {
      success: true,
      data: userNotifs,
      unreadCount,
      count: userNotifs.length,
    };
  } catch (error) {
    console.error('❌ Error fetching notifications:', error.message);
    return { success: false, data: [], unreadCount: 0, count: 0 };
  }
}

// ==================== MARK AS READ ====================
async function markAsRead(notifId) {
  try {
    const notifications = await getSheetData('NOTIFICATIONS');
    const notif = notifications.find(n => (n.notifId || n.notifid) === notifId);

    if (!notif) {
      console.warn(`⚠️ Notification ${notifId} not found`);
      return false;
    }

    // Try camelCase first, then lowercase column name
    let rowIndex = await findRowIndex('NOTIFICATIONS', 'notifId', notifId);
    if (rowIndex === -1) {
      rowIndex = await findRowIndex('NOTIFICATIONS', 'notifid', notifId);
    }
    if (rowIndex === -1) return false;

    await updateRow('NOTIFICATIONS', rowIndex, [
      notif.notifId || notif.notifid,
      notif.userId || notif.userid,
      notif.title,
      notif.message,
      notif.type || 'info',
      'true', // mark as read
      notif.timestamp,
    ]);

    return true;
  } catch (error) {
    console.error('❌ Error marking notification as read:', error.message);
    return false;
  }
}

// ==================== MARK ALL AS READ ====================
async function markAllAsRead(userId) {
  try {
    const notifications = await getSheetData('NOTIFICATIONS');
    const unread = notifications.filter(
      n => (n.userId || n.userid) === userId && n.read === 'false'
    );

    for (const notif of unread) {
      const notifId = notif.notifId || notif.notifid;
      const rowIndex = await findRowIndex('NOTIFICATIONS', 'notifId', notifId)
        .then(r => r !== -1 ? r : findRowIndex('NOTIFICATIONS', 'notifid', notifId));

      if (rowIndex !== -1) {
        await updateRow('NOTIFICATIONS', rowIndex, [
          notifId,
          notif.userId || notif.userid,
          notif.title,
          notif.message,
          notif.type || 'info',
          'true',
          notif.timestamp,
        ]);
      }
    }

    console.log(`✅ Marked ${unread.length} notifications as read for ${userId}`);
    return true;
  } catch (error) {
    console.error('❌ Error marking all as read:', error.message);
    return false;
  }
}

// ==================== DELETE NOTIFICATION ====================
async function deleteNotification(notifId) {
  try {
    const notifications = await getSheetData('NOTIFICATIONS');
    // FIX: was notifications[notifId] (wrong), now find()
    const notif = notifications.find(n => (n.notifId || n.notifid) === notifId);

    if (!notif) return false;

    let rowIndex = await findRowIndex('NOTIFICATIONS', 'notifId', notifId);
    if (rowIndex === -1) rowIndex = await findRowIndex('NOTIFICATIONS', 'notifid', notifId);
    if (rowIndex === -1) return false;

    await updateRow('NOTIFICATIONS', rowIndex, [
      notif.notifId || notif.notifid,
      notif.userId || notif.userid,
      notif.title,
      notif.message,
      notif.type || 'info',
      'DELETED',
      notif.timestamp,
    ]);

    return true;
  } catch (error) {
    console.error('❌ Error deleting notification:', error.message);
    return false;
  }
}

module.exports = {
  createNotification,
  getUserNotifications,
  markAsRead,
  markAllAsRead,
  deleteNotification,
};