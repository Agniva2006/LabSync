const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, '../data/local_db.json');
const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

// Sample valid face descriptor vector (from Agniva/Arun)
const masterDescriptor = db.USERS.find(u => u.faceDescriptor && u.faceDescriptor.length > 50)?.faceDescriptor;

if (!masterDescriptor) {
  console.error('No master face descriptor found!');
  process.exit(1);
}

// Ensure Arun exists with both slot 22 and 33
let arun = db.USERS.find(u => u.username === 'Arun' || u.userId === 'USR-1789934650901');
if (!arun) {
  arun = {
    userid: 'USR-1789934650901',
    userId: 'USR-1789934650901',
    username: 'Arun',
    name: 'Arun',
    email: 'arunkumarshendra@gmail.com',
    password: '$2a$10$qSbfQoa5HHuxXzaTM4BnzuZGfscQPGgSQHyHhgCeN2Vn9Wbr/DcHu',
    role: 'admin',
    department: 'Instructor / Lab Incharge',
    authorized_rooms: 'ROOM-001,ROOM-002',
    fingerprintid: '22,33',
    fingerprintId: '22,33',
    facedescriptor: masterDescriptor,
    faceDescriptor: masterDescriptor,
    facestatus: 'ENROLLED',
    faceStatus: 'ENROLLED',
  };
  db.USERS.push(arun);
} else {
  arun.fingerprintid = '22,33';
  arun.fingerprintId = '22,33';
  arun.role = 'admin';
  arun.facestatus = 'ENROLLED';
  arun.faceStatus = 'ENROLLED';
  if (!arun.faceDescriptor || arun.faceDescriptor.length < 50) {
    arun.facedescriptor = masterDescriptor;
    arun.faceDescriptor = masterDescriptor;
  }
}

// Make sure ALL users have faceStatus = ENROLLED and valid faceDescriptor
db.USERS.forEach(user => {
  if (!user.faceDescriptor || user.faceDescriptor.length < 50) {
    user.facedescriptor = masterDescriptor;
    user.faceDescriptor = masterDescriptor;
  }
  user.facestatus = 'ENROLLED';
  user.faceStatus = 'ENROLLED';
});

fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
console.log('✅ local_db.json updated: All users and Arun (slots 22, 33) ENROLLED with face templates!');
