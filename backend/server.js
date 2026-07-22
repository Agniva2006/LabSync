require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');

// ==================== IMPORT ROUTES ====================
const authRoutes = require('./routes/authRoutes');
const inventoryRoutes = require('./routes/inventoryRoutes');
const qrRoutes = require('./routes/qrRoutes');
const adminRoutes = require('./routes/adminRoutes');
const roomAccessRoutes = require('./routes/roomAccessRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const doorControlRoutes = require('./routes/doorControlRoutes');
const requestRoutes = require('./routes/requestRoutes');
const faceRoutes = require('./routes/faceRoutes');
const dualAuthRoutes = require('./routes/dualAuthRoutes');
const esp32Routes = require('./routes/esp32Routes');
const dashboardRoutes = require('./routes/dashboardRoutes');

// ==================== IMPORT MIDDLEWARE ====================
const { verifyToken, verifyAdmin } = require('./middleware/authMiddleware');

// ==================== IMPORT SERVICES ====================
const faceService = require('./services/faceService');

// ==================== INITIALIZE EXPRESS ====================
const app = express();
const PORT = process.env.PORT || 5000;

// ==================== PRODUCTION SECURITY ====================
// Trust proxy if running behind Nginx/Railway/Heroku
app.set('trust proxy', 1);

// Global Rate Limiter: Max 500 requests per 15 minutes per IP
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 500, 
  message: {
    success: false,
    message: 'Too many requests from this IP, please try again after 15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Auth-specific stricter rate limiter for Brute Force protection
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 25, // Limit each IP to 25 login/register requests per window
  message: {
    success: false,
    message: 'Too many login attempts. Please try again later.'
  }
});

// ==================== MIDDLEWARE ====================

// CORS Configuration - Allow all origins for testing
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  credentials: false
}));

// Handle preflight requests
app.options('*', cors());

// Body Parsers
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Static Files
app.use('/models', express.static(path.join(__dirname, 'models')));

// Request Logging Middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  const method = req.method;
  const path = req.path;
  const ip = req.ip || req.connection.remoteAddress;
  
  console.log(`\n[${timestamp}] ${method} ${path} - IP: ${ip}`);
  
  if ((method === 'POST' || method === 'PUT') && req.body && Object.keys(req.body).length > 0) {
    const sanitizedBody = { ...req.body };
    delete sanitizedBody.password;
    delete sanitizedBody.token;
    if (sanitizedBody.faceImage) {
      sanitizedBody.faceImage = '[IMAGE DATA]';
    }
    console.log(`  📦 Body:`, JSON.stringify(sanitizedBody, null, 2));
  }
  
  next();
});

// Response Time Tracking
app.use((req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
  });
  
  next();
});

// ==================== ROUTES ====================

// Health Check - Doesn't depend on face service
app.get('/', (req, res) => {
  res.json({ 
    message: '🚀 LabSync API is running',
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    environment: process.env.NODE_ENV || 'development',
    features: {
      authentication: true,
      equipmentManagement: true,
      qrScanning: true,
      requestSystem: true,
      faceRecognition: true,
      dualAuthentication: true,
      notifications: true,
      doorControl: true
    }
  });
});

// API Status
app.get('/api/status', (req, res) => {
  res.json({
    success: true,
    message: '✅ All systems operational',
    uptime: process.uptime(),
    uptimeFormatted: formatUptime(process.uptime()),
    timestamp: new Date().toISOString(),
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + ' MB'
    },
    faceRecognition: {
      modelsLoaded: faceService.modelsLoaded,
      enrolledFaces: faceService.getEnrolledCount()
    }
  });
});

// ==================== ROUTES ====================

// Public routes (no auth required)
app.get('/api/wake', (req, res) => res.json({ success: true, message: 'Server awake', timestamp: new Date().toISOString() }));
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/esp32', esp32Routes);          // Hardware — no JWT (ESP32 can't carry tokens)

// Apply global rate limiter to all other non-auth API routes
app.use('/api/', globalLimiter);

// User-authenticated routes
app.use('/api/inventory', verifyToken, inventoryRoutes);
app.use('/api/qr', verifyToken, qrRoutes);
app.use('/api/notifications', verifyToken, notificationRoutes);
app.use('/api/requests', verifyToken, requestRoutes);
app.use('/api/dual-auth', verifyToken, dualAuthRoutes);
app.use('/api/face', faceRoutes);            // Face verify called by ESP32 (no JWT)
                                             // Face enroll/delete protected inside route
// Admin-only routes
app.use('/api/admin', verifyToken, verifyAdmin, adminRoutes);
app.use('/api/room-access', verifyToken, roomAccessRoutes);
app.use('/api/dashboard', verifyToken, verifyAdmin, dashboardRoutes);
app.use('/api/door-control', doorControlRoutes); // Admin check done inside route

// ==================== ERROR HANDLERS ====================

// 404 Handler
app.use((req, res, next) => {
  console.log(`⚠️ 404 - Route not found: ${req.originalUrl}`);
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`,
    availableRoutes: [
      '/api/auth',
      '/api/inventory',
      '/api/qr',
      '/api/admin',
      '/api/room-access',
      '/api/notifications',
      '/api/door-control',
      '/api/requests',
      '/api/face',
      '/api/dual-auth',
      '/api/esp32'
    ]
  });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('\n❌ ========================================');
  console.error('❌ ERROR:', err.message);
  console.error('❌ Route:', req.method, req.path);
  console.error('❌ Stack:', err.stack);
  console.error('❌ ========================================\n');
  
  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token'
    });
  }
  
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      message: 'Validation error',
      errors: err.details
    });
  }
  
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      message: 'Request payload too large'
    });
  }
  
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// ==================== START SERVER ====================

async function startServer() {
  try {
    // Create necessary directories
    const dirs = ['models', 'data', 'logs'];
    dirs.forEach(dir => {
      const dirPath = path.join(__dirname, dir);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        console.log(`📁 Created directory: ${dir}`);
      }
    });

    // Start server FIRST (don't wait for face service)
    app.listen(PORT, () => {
      console.log('\n🚀 ========================================');
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`⏰ Started at: ${new Date().toISOString()}`);
      console.log('🚀 ========================================\n');
      
      console.log('📡 ENDPOINTS:');
      console.log(`   Health Check:     http://localhost:${PORT}/`);
      console.log(`   API Status:       http://localhost:${PORT}/api/status`);
      console.log(`   Authentication:   http://localhost:${PORT}/api/auth`);
      console.log(`   Inventory:        http://localhost:${PORT}/api/inventory`);
      console.log(`   QR Scanner:       http://localhost:${PORT}/api/qr`);
      console.log(`   Admin:            http://localhost:${PORT}/api/admin`);
      console.log(`   Room Access:      http://localhost:${PORT}/api/room-access`);
      console.log(`   Notifications:    http://localhost:${PORT}/api/notifications`);
      console.log(`   Door Control:     http://localhost:${PORT}/api/door-control`);
      console.log(`   Requests:         http://localhost:${PORT}/api/requests`);
      console.log(`   Face Recognition: http://localhost:${PORT}/api/face`);
      console.log(`   Dual Auth:        http://localhost:${PORT}/api/dual-auth`);
      console.log(`   ESP32:            http://localhost:${PORT}/api/esp32`);
      console.log('');
    });

    // Initialize Face Recognition Service AFTER server starts (non-blocking)
    console.log('📦 Initializing face recognition service in background...');
    faceService.initialize().then(() => {
      console.log('✅ Face recognition service initialized successfully');
      console.log(`👥 Loaded ${faceService.getEnrolledCount()} enrolled faces`);
    }).catch(error => {
      console.error('⚠️  Face recognition initialization failed:', error.message);
      console.log('💡 Face features will be unavailable until models are downloaded');
      console.log('💡 The server will continue running without face recognition');
    });

  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// ==================== HELPER FUNCTIONS ====================

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  
  return parts.join(' ');
}

// ==================== GRACEFUL SHUTDOWN ====================

process.on('SIGTERM', () => {
  console.log('\n🛑 SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n🛑 SIGINT received, shutting down gracefully...');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('\n❌ ========================================');
  console.error('❌ UNCAUGHT EXCEPTION:', err.message);
  console.error('❌ Stack:', err.stack);
  console.error('❌ ========================================\n');
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('\n❌ ========================================');
  console.error('❌ UNHANDLED REJECTION at:', promise);
  console.error('❌ Reason:', reason);
  console.error('❌ ========================================\n');
});

// ==================== START THE SERVER ====================
startServer();