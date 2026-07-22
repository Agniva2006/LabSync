const express = require('express');
const router = express.Router();
const { getSheetData, appendRow, updateRow, findRowIndex } = require('../services/sheetsService');

// GET /api/inventory - Get all equipment
router.get('/', async (req, res) => {
  try {
    const data = await getSheetData('OBJECTS');
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching inventory:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ✅ UPDATED: GET /api/inventory/active-borrows - Get active borrows WITH equipment details
router.get('/active-borrows', async (req, res) => {
  try {
    const data = await getSheetData('ACTIVE_BORROWS');
    const allEquipment = await getSheetData('OBJECTS');
    
    // Filter only active borrows
    let active = data.filter(item => (item.status || '').toLowerCase() === 'active');
    
    // ✅ Enrich with equipment details
    active = active.map(borrow => {
      const equipment = allEquipment.find(eq => eq.objectId === borrow.objectId);
      return {
        ...borrow,
        objectName: equipment ? equipment.objectName : 'Unknown Equipment',
        room: equipment ? equipment.room : 'Unknown',
        category: equipment ? equipment.category : '',
        imageUrl: equipment ? equipment.imageUrl : ''
      };
    });
    
    console.log(`📦 Active borrows: ${active.length} records`);
    res.json({ success: true, data: active });
  } catch (error) {
    console.error('Error fetching active borrows:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ✅ UPDATED: GET /api/inventory/borrow-history/:userId - Get borrow history WITH equipment details
router.get('/borrow-history/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    
    if (!userId) {
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }
    
    const allBorrows = await getSheetData('ACTIVE_BORROWS');
    const allEquipment = await getSheetData('OBJECTS');
    
    // Filter borrows for this specific user
    let userBorrows = allBorrows.filter(item => item.userId === userId);
    
    // ✅ Enrich borrow records with equipment details
    userBorrows = userBorrows.map(borrow => {
      const equipment = allEquipment.find(eq => eq.objectId === borrow.objectId);
      return {
        ...borrow,
        objectName: equipment ? equipment.objectName : 'Unknown Equipment',
        room: equipment ? equipment.room : 'Unknown',
        category: equipment ? equipment.category : '',
        imageUrl: equipment ? equipment.imageUrl : ''
      };
    });
    
    // Sort by borrowTime descending (newest first)
    userBorrows.sort((a, b) => {
      const dateA = a.borrowTime ? new Date(a.borrowTime) : new Date(0);
      const dateB = b.borrowTime ? new Date(b.borrowTime) : new Date(0);
      return dateB - dateA;
    });
    
    console.log(`📚 Borrow history for ${userId}: ${userBorrows.length} records`);
    res.json({ success: true, data: userBorrows });
  } catch (error) {
    console.error('Error fetching borrow history:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/inventory/add - Add new equipment
router.post('/add', async (req, res) => {
  try {
    const { objectId, objectName, room, status, qrCode, category, imageUrl, description } = req.body;
    
    if (!objectId || !objectName || !room) {
      return res.status(400).json({ success: false, message: 'Object ID, name, and room are required' });
    }
    
    await appendRow('OBJECTS', [
      objectId, 
      objectName, 
      room, 
      status || 'Available', 
      qrCode || '', 
      category || '', 
      imageUrl || '', 
      description || ''
    ]);
    
    console.log(`✅ Equipment added: ${objectName} (${objectId})`);
    res.json({ success: true, message: 'Equipment added successfully' });
  } catch (error) {
    console.error('Error adding equipment:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/inventory/update/:objectId - Update equipment status
router.put('/update/:objectId', async (req, res) => {
  try {
    const { objectId } = req.params;
    const updates = req.body;
    
    if (!objectId) {
      return res.status(400).json({ success: false, message: 'Object ID is required' });
    }
    
    const data = await getSheetData('OBJECTS');
    const rowIndex = await findRowIndex('OBJECTS', 'objectId', objectId);
    
    if (rowIndex === -1) {
      return res.status(404).json({ success: false, message: 'Equipment not found' });
    }
    
    const currentRow = data.find(item => item.objectId === objectId);
    const updatedRow = [
      currentRow.objectId,
      updates.objectName || currentRow.objectName,
      updates.room || currentRow.room,
      updates.status || currentRow.status,
      currentRow.qrCode || '',
      updates.category || currentRow.category,
      updates.imageUrl || currentRow.imageUrl || '',
      updates.description || currentRow.description || ''
    ];
    
    await updateRow('OBJECTS', rowIndex, updatedRow);
    
    console.log(`✅ Equipment updated: ${objectId}`);
    res.json({ success: true, message: 'Equipment updated successfully' });
  } catch (error) {
    console.error('Error updating equipment:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE /api/inventory/delete/:objectId - Delete equipment (Optional)
router.delete('/delete/:objectId', async (req, res) => {
  try {
    const { objectId } = req.params;
    
    if (!objectId) {
      return res.status(400).json({ success: false, message: 'Object ID is required' });
    }
    
    const rowIndex = await findRowIndex('OBJECTS', 'objectId', objectId);
    
    if (rowIndex === -1) {
      return res.status(404).json({ success: false, message: 'Equipment not found' });
    }
    
    res.status(501).json({ 
      success: false, 
      message: 'Delete functionality not implemented. Use update to change status to "Deleted"' 
    });
  } catch (error) {
    console.error('Error deleting equipment:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== BORROW EQUIPMENT ====================
router.post('/borrow', async (req, res) => {
  try {
    const { equipmentId, userId } = req.body;
    
    console.log(`📦 Borrow request: ${equipmentId} by ${userId}`);
    
    if (!equipmentId || !userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Equipment ID and User ID are required' 
      });
    }
    
    const allEquipment = await getSheetData('OBJECTS');
    const equipmentIndex = allEquipment.findIndex(e => 
      e.objectId === equipmentId || e.qrCode === equipmentId
    );
    
    if (equipmentIndex === -1) {
      return res.json({ success: false, message: 'Equipment not found' });
    }
    
    const equipment = allEquipment[equipmentIndex];
    
    if ((equipment.status || '').toLowerCase() === 'borrowed') {
      return res.json({ success: false, message: 'Equipment is already borrowed' });
    }
    
    const rowIndex = equipmentIndex + 2;
    const updatedRow = [
      equipment.objectId,
      equipment.objectName,
      equipment.room,
      'Borrowed',
      equipment.qrCode || '',
      equipment.category || '',
      equipment.imageUrl || '',
      equipment.description || ''
    ];
    
    await updateRow('OBJECTS', rowIndex, updatedRow);
    
    const borrowId = `BORROW-${Date.now()}`;
    const borrowTime = new Date().toISOString();
    
    await appendRow('ACTIVE_BORROWS', [
      borrowId,
      equipment.objectId,
      equipment.objectName,
      userId,
      borrowTime,
      '',
      'Active'
    ]);
    
    console.log(`✅ Equipment ${equipmentId} borrowed by ${userId}`);
    
    res.json({
      success: true,
      message: 'Equipment borrowed successfully',
      object: { ...equipment, status: 'Borrowed', borrowedBy: userId, borrowTime }
    });
    
  } catch (error) {
    console.error('❌ Borrow error:', error);
    res.status(500).json({ success: false, message: 'Error borrowing equipment: ' + error.message });
  }
});

// ==================== RETURN EQUIPMENT ====================
router.post('/return', async (req, res) => {
  try {
    const { equipmentId, userId } = req.body;
    
    console.log(`📦 Return request: ${equipmentId} by ${userId}`);
    
    if (!equipmentId || !userId) {
      return res.status(400).json({ success: false, message: 'Equipment ID and User ID are required' });
    }
    
    const allEquipment = await getSheetData('OBJECTS');
    const equipmentIndex = allEquipment.findIndex(e => 
      e.objectId === equipmentId || e.qrCode === equipmentId
    );
    
    if (equipmentIndex === -1) {
      return res.json({ success: false, message: 'Equipment not found' });
    }
    
    const equipment = allEquipment[equipmentIndex];
    
    if ((equipment.status || '').toLowerCase() !== 'borrowed') {
      return res.json({ success: false, message: 'Equipment is not currently borrowed' });
    }
    
    const allBorrows = await getSheetData('ACTIVE_BORROWS');
    const borrowIndex = allBorrows.findIndex(b => 
      b.objectId === equipmentId && (b.status || '').toLowerCase() === 'active'
    );
    
    if (borrowIndex === -1) {
      return res.json({ success: false, message: 'No active borrow record found' });
    }
    
    const borrowRecord = allBorrows[borrowIndex];
    
    if (borrowRecord.userId !== userId) {
      return res.json({ success: false, message: 'This equipment is borrowed by another user' });
    }
    
    const equipmentRowIndex = equipmentIndex + 2;
    const updatedEquipmentRow = [
      equipment.objectId,
      equipment.objectName,
      equipment.room,
      'Available',
      equipment.qrCode || '',
      equipment.category || '',
      equipment.imageUrl || '',
      equipment.description || ''
    ];
    await updateRow('OBJECTS', equipmentRowIndex, updatedEquipmentRow);
    
    const borrowRowIndex = borrowIndex + 2;
    const returnTime = new Date().toISOString();
    const updatedBorrowRow = [
      borrowRecord.borrowId || borrowRecord.id || `BORROW-${Date.now()}`,
      borrowRecord.objectId,
      borrowRecord.objectName || equipment.objectName,
      borrowRecord.userId,
      borrowRecord.borrowTime,
      returnTime,
      'Returned'
    ];
    await updateRow('ACTIVE_BORROWS', borrowRowIndex, updatedBorrowRow);
    
    console.log(`✅ Equipment ${equipmentId} returned by ${userId}`);
    
    res.json({
      success: true,
      message: 'Equipment returned successfully',
      object: { ...equipment, status: 'Available' }
    });
    
  } catch (error) {
    console.error('❌ Return error:', error);
    res.status(500).json({ success: false, message: 'Error returning equipment: ' + error.message });
  }
});

// ==================== 🆕 FINGERPRINT VERIFIED (ESP32 TRIGGER) ====================
router.post('/fingerprint-verified', async (req, res) => {
  try {
    const { roomId, userId, fingerId } = req.body;
    
    console.log(`🔓 [DUAL AUTH STEP 1] Fingerprint verified: User ${userId}, Finger ID ${fingerId} in Room ${roomId}`);
    
    // TODO: In the future, this endpoint will trigger the ESP32-CAM to capture a face
    // and verify it against the enrolled face for this userId.
    // For now, we grant access based on fingerprint alone to unblock the hardware flow.
    
    res.json({ 
      success: true, 
      message: 'Fingerprint verified. Access Granted!',
      data: { roomId, userId, fingerId, nextStep: 'face_verification_pending' }
    });
    
  } catch (error) {
    console.error('❌ Fingerprint verification error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error: ' + error.message 
    });
  }
});

module.exports = router;
