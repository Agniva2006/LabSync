const express = require('express');
const router = express.Router();
const { getSheetData, appendRow, findRowIndex, updateRow } = require('../services/sheetsService');
const { createNotification } = require('../services/notificationService');
const { validateRequest, schemas } = require('../middleware/validationMiddleware');

// ==================== HELPER FUNCTIONS ====================

function normalizeStatus(status) {
  if (!status) return '';
  return String(status).trim().toLowerCase();
}

function safeParseDate(dateStr) {
  if (!dateStr) return new Date(0);
  try {
    return new Date(dateStr);
  } catch (e) {
    return new Date(0);
  }
}

// Helper to safely get value from row (handles both camelCase and lowercase)
function getVal(row, ...keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') {
      return row[key];
    }
  }
  return '';
}

// ==================== 1. CREATE REQUEST ====================
router.post('/create', validateRequest(schemas.createRequest), async (req, res) => {
  try {
    const { userId, userName, equipmentId, equipmentName, roomId, purpose, duration } = req.body;

    console.log('📥 CREATE REQUEST - Incoming data:', { userId, userName, equipmentId, equipmentName, roomId, purpose, duration });

    // Check for duplicate pending request
    const existingRequests = await getSheetData('EQUIPMENT_REQUESTS');
    const duplicatePending = existingRequests.find(r => 
      getVal(r, 'userid', 'userId') === userId && 
      getVal(r, 'equipment', 'equipmentId') === equipmentId && 
      normalizeStatus(r.status) === 'pending'
    );

    if (duplicatePending) {
      console.log('⚠️ Duplicate pending request found');
      return res.status(400).json({ 
        success: false, 
        message: 'You already have a pending request for this equipment' 
      });
    }

    const requestId = `REQ-${Date.now().toString().slice(-6)}`;
    const requestedAt = new Date().toISOString();

    // Save to EQUIPMENT_REQUESTS sheet (matches your column headers exactly)
    await appendRow('EQUIPMENT_REQUESTS', [
      requestId,                          // requestid
      userId,                             // userid
      userName || 'Unknown User',         // username
      equipmentId,                        // equipment
      equipmentName || equipmentId,       // equipmentname
      roomId || 'Unknown',                // roomid
      purpose || 'Lab work',              // purpose
      duration || '1 hour',               // duration
      'pending',                          // status
      requestedAt,                        // requestedat
      '',                                 // approvedat
      '',                                 // adminid
      ''                                  // admincomment
    ]);

    console.log(`✅ Request created: ${requestId}`);

    // Notify Admins
    try {
      const users = await getSheetData('USERS');
      const admins = users.filter(u => normalizeStatus(u.role) === 'admin');
      
      console.log(`📬 Notifying ${admins.length} admin(s)...`);
      
      for (const admin of admins) {
        const adminId = getVal(admin, 'userid', 'userId');
        await createNotification(
          adminId, 
          '📋 New Equipment Request', 
          `${userName || 'A user'} requested ${equipmentName || equipmentId} for ${duration || '1 hour'}`, 
          'REQUEST'
        );
      }
    } catch (notifError) {
      console.error('⚠️ Failed to send notifications:', notifError.message);
    }

    res.status(201).json({ 
      success: true, 
      message: 'Request submitted successfully',
      requestId 
    });
  } catch (error) {
    console.error('❌ Error creating request:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Failed to create request' 
    });
  }
});

// ==================== 2. GET USER REQUESTS ====================
router.get('/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    console.log(`📡 GET USER REQUESTS - Fetching for userId: "${userId}"`);

    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID is required' 
      });
    }

    const requests = await getSheetData('EQUIPMENT_REQUESTS');
    console.log(`📊 Total requests in sheet: ${requests.length}`);

    // Log first request to see actual column names
    if (requests.length > 0) {
      console.log('🔍 Sample request keys:', Object.keys(requests[0]));
      console.log('🔍 Sample request:', requests[0]);
    }

    const userRequests = requests
      .filter(r => {
        // ✅ Use getVal to handle both lowercase and camelCase
        const rowUserId = getVal(r, 'userid', 'userId');
        const matchesUser = rowUserId === userId;
        const notDeleted = normalizeStatus(r.status) !== 'deleted';
        
        if (matchesUser) {
          console.log(`  🔍 Found: ${getVal(r, 'requestid', 'requestId')} | Status: ${r.status} | Equipment: ${getVal(r, 'equipmentname', 'equipmentName')}`);
        }
        
        return matchesUser && notDeleted;
      })
      .sort((a, b) => {
        const dateA = safeParseDate(getVal(a, 'requestedat', 'requestedAt'));
        const dateB = safeParseDate(getVal(b, 'requestedat', 'requestedAt'));
        return dateB - dateA;
      });

    console.log(`✅ Found ${userRequests.length} requests for user ${userId}`);

    res.json({ 
      success: true, 
      data: userRequests,
      count: userRequests.length
    });
  } catch (error) {
    console.error('❌ Error fetching user requests:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Failed to fetch requests' 
    });
  }
});

// ==================== 3. GET ALL REQUESTS (Admin) ====================
router.get('/all', async (req, res) => {
  try {
    console.log('📡 GET ALL REQUESTS - Fetching for admin dashboard');

    const requests = await getSheetData('EQUIPMENT_REQUESTS');
    const activeRequests = requests
      .filter(r => normalizeStatus(r.status) !== 'deleted')
      .sort((a, b) => {
        const dateA = safeParseDate(getVal(a, 'requestedat', 'requestedAt'));
        const dateB = safeParseDate(getVal(b, 'requestedat', 'requestedAt'));
        return dateB - dateA;
      });

    const pending = activeRequests.filter(r => normalizeStatus(r.status) === 'pending').length;
    const approved = activeRequests.filter(r => normalizeStatus(r.status) === 'approved').length;
    const rejected = activeRequests.filter(r => normalizeStatus(r.status) === 'rejected').length;

    console.log(`✅ Total: ${activeRequests.length} | Pending: ${pending} | Approved: ${approved} | Rejected: ${rejected}`);

    res.json({ 
      success: true, 
      data: activeRequests,
      pending,
      approved,
      rejected,
      total: activeRequests.length
    });
  } catch (error) {
    console.error('❌ Error fetching all requests:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Failed to fetch requests' 
    });
  }
});

// ==================== 4. APPROVE REQUEST ====================
router.put('/:requestId/approve', async (req, res) => {
  try {
    const { requestId } = req.params;
    const { adminId } = req.body;

    console.log(`✅ APPROVE REQUEST - RequestId: ${requestId}, AdminId: ${adminId}`);

    const requests = await getSheetData('EQUIPMENT_REQUESTS');
    const request = requests.find(r => getVal(r, 'requestid', 'requestId') === requestId);

    if (!request) {
      return res.status(404).json({ 
        success: false, 
        message: 'Request not found' 
      });
    }

    if (normalizeStatus(request.status) !== 'pending') {
      return res.status(400).json({ 
        success: false, 
        message: `Request is already ${request.status}` 
      });
    }

    // Get values using helper
    const reqUserId = getVal(request, 'userid', 'userId');
    const reqUserName = getVal(request, 'username', 'userName');
    const reqEquipmentId = getVal(request, 'equipment', 'equipmentId');
    const reqEquipmentName = getVal(request, 'equipmentname', 'equipmentName');
    const reqRoomId = getVal(request, 'roomid', 'roomId');
    const reqPurpose = getVal(request, 'purpose');
    const reqDuration = getVal(request, 'duration');
    const reqRequestedAt = getVal(request, 'requestedat', 'requestedAt');

    // Update Request Status
    const reqIndex = await findRowIndex('EQUIPMENT_REQUESTS', 'requestid', requestId);
    if (reqIndex === -1) {
      // Try camelCase as fallback
      const reqIndex2 = await findRowIndex('EQUIPMENT_REQUESTS', 'requestId', requestId);
      if (reqIndex2 === -1) {
        return res.status(404).json({ 
          success: false, 
          message: 'Request row not found in sheet' 
        });
      }
    }

    const finalReqIndex = reqIndex !== -1 ? reqIndex : await findRowIndex('EQUIPMENT_REQUESTS', 'requestId', requestId);

    await updateRow('EQUIPMENT_REQUESTS', finalReqIndex, [
      requestId,
      reqUserId, 
      reqUserName, 
      reqEquipmentId, 
      reqEquipmentName, 
      reqRoomId, 
      reqPurpose, 
      reqDuration, 
      'approved', 
      reqRequestedAt, 
      new Date().toISOString(), 
      adminId || 'system', 
      'Approved'
    ]);

    console.log(`✅ Request ${requestId} marked as approved`);

    // Change Equipment Status to 'reserved'
    const objects = await getSheetData('OBJECTS');
    let objIndex = await findRowIndex('OBJECTS', 'objectid', reqEquipmentId);
    if (objIndex === -1) {
      objIndex = await findRowIndex('OBJECTS', 'objectId', reqEquipmentId);
    }
    
    if (objIndex !== -1) {
      const currentObj = objects[objIndex];
      
      // Preserve ALL existing columns
      const updatedRow = [
        getVal(currentObj, 'objectid', 'objectId') || reqEquipmentId,
        getVal(currentObj, 'name', 'objectName') || reqEquipmentName,
        getVal(currentObj, 'category') || '',
        getVal(currentObj, 'roomid', 'roomId') || reqRoomId,
        'reserved',
        getVal(currentObj, 'qrcode', 'qrCode') || '',
        getVal(currentObj, 'description') || '',
        getVal(currentObj, 'condition') || 'good',
        getVal(currentObj, 'purchasedate', 'purchaseDate') || '',
        getVal(currentObj, 'lastmaintenance', 'lastMaintenance') || ''
      ];
      
      await updateRow('OBJECTS', objIndex, updatedRow);
      console.log(`✅ Equipment ${reqEquipmentId} status changed to 'reserved'`);
    } else {
      console.warn(`⚠️ Equipment ${reqEquipmentId} not found in OBJECTS sheet`);
    }

    // Notify User
    try {
      await createNotification(
        reqUserId, 
        '✅ Request Approved!', 
        `Your request for ${reqEquipmentName} has been approved. You can now borrow it.`, 
        'APPROVED'
      );
      console.log(`📬 Notification sent to user ${reqUserId}`);
    } catch (notifError) {
      console.error('⚠️ Failed to send notification:', notifError.message);
    }

    res.json({ 
      success: true, 
      message: 'Request approved and equipment reserved' 
    });
  } catch (error) {
    console.error('❌ Error approving request:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Failed to approve request' 
    });
  }
});

// ==================== 5. REJECT REQUEST ====================
router.put('/:requestId/reject', async (req, res) => {
  try {
    const { requestId } = req.params;
    const { adminId, reason } = req.body;

    console.log(`❌ REJECT REQUEST - RequestId: ${requestId}, AdminId: ${adminId}, Reason: ${reason}`);

    const requests = await getSheetData('EQUIPMENT_REQUESTS');
    const request = requests.find(r => getVal(r, 'requestid', 'requestId') === requestId);

    if (!request) {
      return res.status(404).json({ 
        success: false, 
        message: 'Request not found' 
      });
    }

    if (normalizeStatus(request.status) !== 'pending') {
      return res.status(400).json({ 
        success: false, 
        message: `Request is already ${request.status}` 
      });
    }

    const reqUserId = getVal(request, 'userid', 'userId');
    const reqUserName = getVal(request, 'username', 'userName');
    const reqEquipmentId = getVal(request, 'equipment', 'equipmentId');
    const reqEquipmentName = getVal(request, 'equipmentname', 'equipmentName');
    const reqRoomId = getVal(request, 'roomid', 'roomId');
    const reqPurpose = getVal(request, 'purpose');
    const reqDuration = getVal(request, 'duration');
    const reqRequestedAt = getVal(request, 'requestedat', 'requestedAt');

    let reqIndex = await findRowIndex('EQUIPMENT_REQUESTS', 'requestid', requestId);
    if (reqIndex === -1) {
      reqIndex = await findRowIndex('EQUIPMENT_REQUESTS', 'requestId', requestId);
    }

    if (reqIndex === -1) {
      return res.status(404).json({ 
        success: false, 
        message: 'Request row not found' 
      });
    }

    await updateRow('EQUIPMENT_REQUESTS', reqIndex, [
      requestId,
      reqUserId, 
      reqUserName, 
      reqEquipmentId, 
      reqEquipmentName, 
      reqRoomId, 
      reqPurpose, 
      reqDuration, 
      'rejected', 
      reqRequestedAt, 
      new Date().toISOString(), 
      adminId || 'system', 
      reason || 'Rejected by admin'
    ]);

    console.log(`✅ Request ${requestId} marked as rejected`);

    // Notify User
    try {
      await createNotification(
        reqUserId, 
        '❌ Request Rejected', 
        `Your request for ${reqEquipmentName} was rejected. ${reason ? 'Reason: ' + reason : ''}`, 
        'REJECTED'
      );
      console.log(`📬 Rejection notification sent to user ${reqUserId}`);
    } catch (notifError) {
      console.error('⚠️ Failed to send notification:', notifError.message);
    }

    res.json({ 
      success: true, 
      message: 'Request rejected successfully' 
    });
  } catch (error) {
    console.error('❌ Error rejecting request:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Failed to reject request' 
    });
  }
});

// ==================== 6. DELETE REQUEST (Soft Delete) ====================
router.delete('/:requestId', async (req, res) => {
  try {
    const { requestId } = req.params;
    console.log(`🗑️ DELETE REQUEST - RequestId: ${requestId}`);

    const requests = await getSheetData('EQUIPMENT_REQUESTS');
    const request = requests.find(r => getVal(r, 'requestid', 'requestId') === requestId);

    if (!request) {
      return res.status(404).json({ 
        success: false, 
        message: 'Request not found' 
      });
    }

    let reqIndex = await findRowIndex('EQUIPMENT_REQUESTS', 'requestid', requestId);
    if (reqIndex === -1) {
      reqIndex = await findRowIndex('EQUIPMENT_REQUESTS', 'requestId', requestId);
    }

    if (reqIndex === -1) {
      return res.status(404).json({ 
        success: false, 
        message: 'Request row not found' 
      });
    }

    await updateRow('EQUIPMENT_REQUESTS', reqIndex, [
      requestId,
      getVal(request, 'userid', 'userId'), 
      getVal(request, 'username', 'userName'), 
      getVal(request, 'equipment', 'equipmentId'), 
      getVal(request, 'equipmentname', 'equipmentName'), 
      getVal(request, 'roomid', 'roomId'), 
      getVal(request, 'purpose'), 
      getVal(request, 'duration'), 
      'DELETED', 
      getVal(request, 'requestedat', 'requestedAt'), 
      getVal(request, 'approvedat', 'approvedAt') || '', 
      getVal(request, 'adminid', 'adminId') || '', 
      getVal(request, 'admincomment', 'adminComment') || 'Deleted by user'
    ]);

    console.log(`✅ Request ${requestId} soft deleted`);

    res.json({ 
      success: true, 
      message: 'Request deleted successfully' 
    });
  } catch (error) {
    console.error('❌ Error deleting request:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Failed to delete request' 
    });
  }
});

// ==================== 7. DEBUG ENDPOINT ====================
router.get('/debug/all', async (req, res) => {
  try {
    const requests = await getSheetData('EQUIPMENT_REQUESTS');
    
    res.json({ 
      success: true, 
      count: requests.length,
      sampleKeys: requests.length > 0 ? Object.keys(requests[0]) : [],
      data: requests.map(r => ({
        requestId: getVal(r, 'requestid', 'requestId'),
        userId: getVal(r, 'userid', 'userId'),
        userName: getVal(r, 'username', 'userName'),
        equipmentId: getVal(r, 'equipment', 'equipmentId'),
        equipmentName: getVal(r, 'equipmentname', 'equipmentName'),
        roomId: getVal(r, 'roomid', 'roomId'),
        status: r.status,
        requestedAt: getVal(r, 'requestedat', 'requestedAt'),
        raw: r
      }))
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

module.exports = router;