const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'labsync-super-secret-key-2024';

/**
 * Middleware: verify JWT token from Authorization header
 * Attaches decoded payload to req.user = { userId, role, email, name }
 */
function verifyToken(req, res, next) {
  const header = req.headers['authorization'];

  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required. Please login.',
    });
  }

  const token = header.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { userId, role, email, name, iat, exp }
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Session expired. Please login again.',
      });
    }
    return res.status(401).json({
      success: false,
      message: 'Invalid token. Please login again.',
    });
  }
}

/**
 * Middleware: verify admin role (must run AFTER verifyToken)
 */
function verifyAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Admin access required.',
    });
  }
  next();
}

module.exports = { verifyToken, verifyAdmin, JWT_SECRET };
