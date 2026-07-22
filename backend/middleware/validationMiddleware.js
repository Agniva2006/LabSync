const { z } = require('zod');

// Helper middleware to validate requests against a Zod schema
const validateRequest = (schema) => {
  return (req, res, next) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const issues = error.errors.map(err => `${err.path.join('.')}: ${err.message}`);
        return res.status(400).json({
          success: false,
          message: 'Validation failed',
          errors: issues,
        });
      }
      next(error);
    }
  };
};

// ==================== SCHEMAS ====================

const registerSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Invalid email format"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  department: z.string().min(2, "Department is required"),
});

const loginSchema = z.object({
  email: z.string().email("Invalid email format"),
  password: z.string().min(1, "Password is required"),
});

const createRequestSchema = z.object({
  userId: z.string().min(1, "userId is required"),
  userName: z.string().min(1, "userName is required"),
  equipmentId: z.string().min(1, "equipmentId is required"),
  equipmentName: z.string().min(1, "equipmentName is required"),
  roomId: z.string().min(1, "roomId is required"),
  purpose: z.string().min(5, "purpose must be at least 5 characters"),
  duration: z.string().min(1, "duration is required"),
});

const qrScanSchema = z.object({
  qrCode: z.string().min(1, "qrCode is required"),
  action: z.enum(["borrow", "return"]),
  userId: z.string().min(1, "userId is required"),
});

const roleUpdateSchema = z.object({
  role: z.enum(["admin", "user"]),
});

const authorizeRoomSchema = z.object({
  roomId: z.string().min(1, "roomId is required"),
  action: z.enum(["add", "remove"]),
});

const remoteUnlockSchema = z.object({
  roomId: z.string().min(1, "roomId is required"),
});

module.exports = {
  validateRequest,
  schemas: {
    register: registerSchema,
    login: loginSchema,
    createRequest: createRequestSchema,
    qrScan: qrScanSchema,
    roleUpdate: roleUpdateSchema,
    authorizeRoom: authorizeRoomSchema,
    remoteUnlock: remoteUnlockSchema,
  },
};
