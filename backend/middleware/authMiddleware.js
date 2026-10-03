const jwt = require('jsonwebtoken');

/**
 * JWT signing secret.
 *
 * Previously fell back to a literal committed to source control, which meant a
 * missing .env silently produced forgeable tokens. There is no default: the
 * server refuses to start rather than run on a known key.
 */
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('\n╔══════════════════════════════════════════════════════════════╗');
  console.error('║  🔴 FATAL: JWT_SECRET missing or shorter than 32 characters  ║');
  console.error('╚══════════════════════════════════════════════════════════════╝');
  console.error('Set a strong secret in backend/.env before starting.');
  console.error('Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"\n');
  process.exit(1);
}

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
