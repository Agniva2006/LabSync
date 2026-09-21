const fs = require('fs');
const path = require('path');

async function syncSheetsToLocalDb() {
  const url = 'https://docs.google.com/spreadsheets/d/1swE1x8y7xNFaPFZovR9BJ6usq7baM3gGkXqNI8cgWmI/export?format=csv&gid=0';
  const res = await fetch(url);
  const text = await res.text();
  
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);

  function parseCsvLine(line) {
    let inQuote = false;
    let col = '';
    const cols = [];
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === '"') {
        inQuote = !inQuote;
      } else if (ch === ',' && !inQuote) {
        cols.push(col.trim());
        col = '';
      } else {
        col += ch;
      }
    }
    cols.push(col.trim());
    return cols;
  }

  const localDbPath = path.join(__dirname, '../data/local_db.json');
  let currentDb = {};
  if (fs.existsSync(localDbPath)) {
    currentDb = JSON.parse(fs.readFileSync(localDbPath, 'utf8'));
  }

  const existingUsers = currentDb.USERS || [];
  const userMap = new Map();
  // Keep any existing users like Arun
  existingUsers.forEach(u => {
    if (u.userId || u.userid) {
      userMap.set(u.userId || u.userid, u);
    }
  });

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const userId = cols[0];
    const username = cols[1];
    const email = cols[2];
    const password = cols[3];
    const role = cols[4];
    const department = cols[5];
    const authorized_rooms = cols[6];
    const fingerprintId = cols[7];
    const faceDescriptor = cols[8];
    const faceStatus = cols[9];

    if (!userId && !username && !fingerprintId) continue;

    const existing = userMap.get(userId) || {};
    userMap.set(userId, {
      ...existing,
      userid: userId,
      userId: userId,
      username: username || existing.username || 'User',
      name: username || existing.name || 'User',
      email: email || existing.email || '',
      password: password || existing.password || '$2a$10$qSbfQoa5HHuxXzaTM4BnzuZGfscQPGgSQHyHhgCeN2Vn9Wbr/DcHu',
      role: role || existing.role || 'user',
      department: department || existing.department || 'Lab Member',
      authorized_rooms: authorized_rooms || existing.authorized_rooms || 'ROOM-001',
      fingerprintid: (fingerprintId && fingerprintId !== '') ? fingerprintId : (existing.fingerprintid || existing.fingerprintId || ''),
      fingerprintId: (fingerprintId && fingerprintId !== '') ? fingerprintId : (existing.fingerprintId || existing.fingerprintid || ''),
      facedescriptor: (faceDescriptor && faceDescriptor.length > 50) ? faceDescriptor : (existing.facedescriptor || existing.faceDescriptor || ''),
      faceDescriptor: (faceDescriptor && faceDescriptor.length > 50) ? faceDescriptor : (existing.faceDescriptor || existing.facedescriptor || ''),
      facestatus: (faceStatus && faceStatus !== 'NOT_ENROLLED') ? faceStatus : (existing.facestatus || existing.faceStatus || faceStatus || 'NOT_ENROLLED'),
      faceStatus: (faceStatus && faceStatus !== 'NOT_ENROLLED') ? faceStatus : (existing.faceStatus || existing.facestatus || faceStatus || 'NOT_ENROLLED'),
    });
  }

  currentDb.USERS = Array.from(userMap.values());
  fs.writeFileSync(localDbPath, JSON.stringify(currentDb, null, 2), 'utf8');
  console.log(`✅ Universal sync complete: ${currentDb.USERS.length} users updated in local_db.json!`);
}

syncSheetsToLocalDb().catch(console.error);
