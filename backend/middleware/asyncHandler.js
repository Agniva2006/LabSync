/**
 * Wrap an async Express 4 handler.
 *
 * Express 4 does not catch rejected promises from async handlers: the rejection
 * becomes an unhandled rejection and the HTTP response is never sent, leaving
 * the client (and the door decision) hanging until timeout. Every async route
 * in this codebase is wrapped with this so failures always reach the error
 * handler and produce a real HTTP response.
 */
module.exports = function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
