const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getSheetData, appendRow, appendRows, findRowIndex, updateRow, deleteRow } = require('../services/sheetsService');
const { createNotification } = require('../services/notificationService');
const { validateRequest, schemas } = require('../middleware/validationMiddleware');

// ==================== GET /api/admin/stats ====================
router.get('/stats', async (req, res) => {
  try {
    const [objects, users, borrows, requests] = await Promise.all([
      getSheetData('OBJECTS'),
      getSheetData('USERS'),
      getSheetData('ACTIVE_BORROWS'),
      getSheetData('EQUIPMENT_REQUESTS'),
    ]);

    const pendingRequests = requests.filter(r => (r.status || '').toLowerCase() === 'pending').length;
    const enrolledFaces = users.filter(u => (u.facestatus || u.faceStatus || '') === 'ENROLLED').length;
    const enrolledFingerprints = users.filter(u => (u.fingerprintid || u.fingerprintId || '') !== '').length;

    res.json({
      success: true,
      data: {
        totalEquipment: objects.length,
        availableEquipment: objects.filter(o => (o.status || '').toLowerCase() === 'available').length,
        borrowedEquipment: objects.filter(o => (o.status || '').toLowerCase() === 'borrowed').length,
        totalUsers: users.filter(u => (u.role || '') !== 'admin').length,
        totalAdmins: users.filter(u => (u.role || '') === 'admin').length,
        activeBorrows: borrows.filter(b => (b.status || '').toLowerCase() === 'active').length,
        pendingRequests,
        enrolledFaces,
        enrolledFingerprints,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== GET /api/admin/equipment ====================
router.get('/equipment', async (req, res) => {
  try {
    const data = await getSheetData('OBJECTS');
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== GET /api/admin/users ====================
router.get('/users', async (req, res) => {
  try {
    const users = await getSheetData('USERS');
    // Strip passwords from response
    const safeUsers = users.map(u => ({
      userId: u.userid || u.userId,
      name: u.username || u.name,
      email: u.email,
      role: u.role,
      department: u.department,
      authorizedRooms: u.authorized_rooms || '',
      fingerprintId: u.fingerprintid || u.fingerprintId || '',
      faceStatus: u.facestatus || u.faceStatus || 'NOT_ENROLLED',
    }));
    res.json({ success: true, data: safeUsers });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== GET /api/admin/logs ====================
router.get('/logs', async (req, res) => {
  try {
    const logs = await getSheetData('ROOM_ACCESS');
    logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json({ success: true, data: logs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== PUT /api/admin/users/:userId/authorize-room ====================
router.put('/users/:userId/authorize-room', validateRequest(schemas.authorizeRoom), async (req, res) => {
  try {
    const { userId } = req.params;
    const { roomId, action } = req.body;

    const users = await getSheetData('USERS');
    const user = users.find(u => (u.userid || u.userId) === userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    let rooms = (user.authorized_rooms || '').split(',').map(r => r.trim()).filter(Boolean);

    if (action === 'add' && !rooms.includes(roomId)) {
      rooms.push(roomId);
    } else if (action === 'remove') {
      rooms = rooms.filter(r => r !== roomId);
    }

    let rowIndex = await findRowIndex('USERS', 'userid', userId);
    if (rowIndex === -1) rowIndex = await findRowIndex('USERS', 'userId', userId);

    if (rowIndex !== -1) {
      await updateRow('USERS', rowIndex, [
        user.userid || user.userId,
        user.username || user.name,
        user.email,
        user.password,
        user.role,
        user.department,
        rooms.join(','),
        user.fingerprintid || user.fingerprintId || '',
        user.facedescriptor || user.faceDescriptor || '',
        user.facestatus || user.faceStatus || 'NOT_ENROLLED',
      ]);
    }

    await createNotification(
      userId,
      action === 'add' ? '🔓 Room Access Granted' : '🔒 Room Access Revoked',
      `Your access to room ${roomId} has been ${action === 'add' ? 'granted' : 'revoked'} by admin.`,
      action === 'add' ? 'success' : 'warning'
    );

    res.json({ success: true, message: `Room access ${action}ed`, authorizedRooms: rooms.join(',') });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== PUT /api/admin/users/:userId/role ====================
router.put('/users/:userId/role', validateRequest(schemas.roleUpdate), async (req, res) => {
  try {
    const { userId } = req.params;
    const { role } = req.body;

    const users = await getSheetData('USERS');
    const user = users.find(u => (u.userid || u.userId) === userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    let rowIndex = await findRowIndex('USERS', 'userid', userId);
    if (rowIndex === -1) rowIndex = await findRowIndex('USERS', 'userId', userId);

    if (rowIndex !== -1) {
      await updateRow('USERS', rowIndex, [
        user.userid || user.userId,
        user.username || user.name,
        user.email,
        user.password,
        role,
        user.department,
        user.authorized_rooms || '',
        user.fingerprintid || user.fingerprintId || '',
        user.facedescriptor || user.faceDescriptor || '',
        user.facestatus || user.faceStatus || 'NOT_ENROLLED',
      ]);
    }

    res.json({ success: true, message: `User role updated to ${role}` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== POST /api/admin/users/bulk-import ====================
router.post('/users/bulk-import', async (req, res) => {
  try {
    const { users } = req.body;
    if (!Array.isArray(users) || users.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid data: users array required' });
    }

    const defaultHash = await bcrypt.hash('LabSync@123', 10);
    const rowsToInsert = [];
    const baseTimestamp = Date.now();

    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      if (!user.name || !user.email) continue;

      const userHash = user.password ? await bcrypt.hash(user.password, 10) : defaultHash;
      const userId = `USR-${baseTimestamp + i}-${Math.floor(Math.random() * 1000)}`;

      rowsToInsert.push([
        userId,
        user.name,
        user.email,
        userHash,
        user.role || 'user',
        user.department || '',
        user.authorized_rooms || '',
        '',   // fingerprintId
        '',   // faceDescriptor
        'NOT_ENROLLED',
      ]);
    }

    if (rowsToInsert.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid user rows to import' });
    }

    // Execute single batch append API call
    const result = await appendRows('USERS', rowsToInsert);

    res.json({
      success: true,
      message: `Imported ${rowsToInsert.length} users successfully in 1 batch operation`,
      importedCount: rowsToInsert.length,
    });
  } catch (error) {
    console.error('❌ Bulk import error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== GET /api/admin/users/export ====================
router.get('/users/export', async (req, res) => {
  try {
    const users = await getSheetData('USERS');
    let csv = 'userId,name,email,role,department,authorized_rooms,fingerprintId,faceStatus\n';
    users.forEach(u => {
      csv += `${u.userid || u.userId},"${u.username || u.name}",${u.email},${u.role},${u.department},"${u.authorized_rooms || ''}",${u.fingerprintid || u.fingerprintId || ''},${u.facestatus || u.faceStatus || 'NOT_ENROLLED'}\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=users.csv');
    res.send(csv);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== POST /api/admin/users/delete ====================
router.post('/users/delete', async (req, res) => {
  try {
    const { userIds } = req.body;
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ success: false, message: 'userIds array is required' });
    }

    let deletedCount = 0;
    for (const userId of userIds) {
      let rowIndex = await findRowIndex('USERS', 'userid', userId);
      if (rowIndex === -1) rowIndex = await findRowIndex('USERS', 'userId', userId);

      if (rowIndex !== -1) {
        await deleteRow('USERS', rowIndex);
        deletedCount++;
        console.log(`🗑️ Deleted user: ${userId} (row ${rowIndex})`);
      } else {
        console.warn(`⚠️ User not found for deletion: ${userId}`);
      }
    }

    res.json({ success: true, message: `Deleted ${deletedCount} of ${userIds.length} users` });
  } catch (error) {
    console.error('❌ Delete users error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;