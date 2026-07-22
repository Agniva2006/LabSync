const express = require('express');
const { getSheetData, findRowIndex, updateRow, appendRow } = require('../services/sheetsService');
const router = express.Router();

/**
 * Utility to unpack QR Code payload string (JSON, URL, or plain string)
 */
function parseScannedCode(rawCode) {
  if (!rawCode) return '';
  let code = String(rawCode).trim();
  try {
    if (code.startsWith('{') && code.endsWith('}')) {
      const parsed = JSON.parse(code);
      return parsed.id || parsed.objectId || parsed.qrCode || parsed.code || code;
    }
  } catch (_) {}
  if (code.includes('/equipment/')) {
    return code.split('/equipment/').pop();
  }
  return code;
}

// POST /api/qr/scan - Scan equipment QR code & process action (borrow/return/verify/info)
router.post('/scan', async (req, res) => {
  try {
    const { qrCode: rawQrCode, action = 'verify', userId } = req.body;
    
    if (!rawQrCode) {
      return res.status(400).json({ success: false, message: 'QR Code is required' });
    }

    const cleanCode = parseScannedCode(rawQrCode);
    console.log(`📷 Processing QR scan: raw="${rawQrCode}" -> clean="${cleanCode}" [Action: ${action}]`);

    const objects = await getSheetData('OBJECTS');
    const objIndex = objects.findIndex(o => 
      o.qrCode === cleanCode || 
      o.objectId === cleanCode || 
      o.id === cleanCode ||
      (o.qrCode && o.qrCode.toLowerCase() === cleanCode.toLowerCase()) ||
      (o.objectId && o.objectId.toLowerCase() === cleanCode.toLowerCase())
    );

    if (objIndex === -1) {
      console.log(`❌ Equipment not found for code: "${cleanCode}"`);
      return res.status(404).json({ 
        success: false, 
        message: `Equipment with QR code "${cleanCode}" not found in database` 
      });
    }

    const obj = objects[objIndex];
    const sheetRowIndex = objIndex + 2; // 1-based index + header row

    // ACTION: INFO / VERIFY (Returns equipment details)
    if (action === 'info' || action === 'verify') {
      return res.json({
        success: true,
        message: 'Equipment verified',
        data: obj,
        object: obj,
      });
    }

    // ACTION: BORROW
    if (action === 'borrow') {
      if ((obj.status || '').toLowerCase() === 'borrowed') {
        return res.status(400).json({ 
          success: false, 
          message: `${obj.objectName || obj.name || 'Equipment'} is already borrowed` 
        });
      }

      if (!userId) {
        return res.status(400).json({ success: false, message: 'User ID is required to borrow' });
      }

      const now = new Date().toISOString();
      const objId = obj.objectId || obj.id || cleanCode;
      const objName = obj.objectName || obj.name || 'Equipment';

      // Preserve all columns in OBJECTS sheet
      const updatedObjectRow = [
        objId,
        objName,
        obj.room || obj.location || 'Lab',
        'Borrowed',
        obj.qrCode || cleanCode,
        obj.category || '',
        obj.imageUrl || '',
        obj.description || ''
      ];

      await updateRow('OBJECTS', sheetRowIndex, updatedObjectRow);

      const borrowId = `BOR-${Date.now()}`;
      // Columns: borrowId, objectId, objectName, userId, borrowTime, returnTime, status
      await appendRow('ACTIVE_BORROWS', [borrowId, objId, objName, userId, now, '', 'Active']);
      await appendRow('LOGS', [`LOG-${Date.now()}`, userId, objId, 'BORROW', now, `Borrowed ${objName} via QR`]);

      console.log(`✅ Borrowed via QR: ${objName} (${objId}) by ${userId}`);

      return res.json({ 
        success: true, 
        message: `${objName} borrowed successfully!`, 
        data: { ...obj, status: 'Borrowed', borrowedBy: userId, borrowDate: now },
        object: { ...obj, status: 'Borrowed', borrowedBy: userId, borrowDate: now }
      });
    }

    // ACTION: RETURN
    if (action === 'return') {
      if ((obj.status || '').toLowerCase() !== 'borrowed') {
        return res.status(400).json({ 
          success: false, 
          message: `${obj.objectName || obj.name || 'Equipment'} is not currently borrowed` 
        });
      }

      const now = new Date().toISOString();
      const objId = obj.objectId || obj.id || cleanCode;
      const objName = obj.objectName || obj.name || 'Equipment';

      // Update OBJECTS sheet to Available
      const updatedObjectRow = [
        objId,
        objName,
        obj.room || obj.location || 'Lab',
        'Available',
        obj.qrCode || cleanCode,
        obj.category || '',
        obj.imageUrl || '',
        obj.description || ''
      ];

      await updateRow('OBJECTS', sheetRowIndex, updatedObjectRow);

      // Update ACTIVE_BORROWS record
      const borrows = await getSheetData('ACTIVE_BORROWS');
      const borrowIndex = borrows.findIndex(b => 
        (b.objectId === objId || b.equipmentId === objId) && 
        (b.status || '').toLowerCase() === 'active'
      );

      if (borrowIndex !== -1) {
        const b = borrows[borrowIndex];
        const borrowSheetRowIndex = borrowIndex + 2;
        await updateRow('ACTIVE_BORROWS', borrowSheetRowIndex, [
          b.borrowId || b.id || `BOR-${Date.now()}`,
          b.objectId || objId,
          b.objectName || objName,
          b.userId || userId || '',
          b.borrowTime || now,
          now,
          'Returned'
        ]);
      }

      await appendRow('LOGS', [`LOG-${Date.now()}`, userId || 'user', objId, 'RETURN', now, `Returned ${objName} via QR`]);

      console.log(`✅ Returned via QR: ${objName} (${objId})`);

      return res.json({ 
        success: true, 
        message: `${objName} returned successfully!`, 
        data: { ...obj, status: 'Available', borrowedBy: '', borrowDate: '' },
        object: { ...obj, status: 'Available', borrowedBy: '', borrowDate: '' }
      });
    }

    return res.status(400).json({ success: false, message: `Invalid action: "${action}"` });

  } catch (error) {
    console.error('❌ QR scan processing error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;