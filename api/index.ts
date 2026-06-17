// Vercel serverless entry point. The `buildCommand` (see vercel.json) compiles
// src/ -> dist/ with tsc first, so this imports the already-compiled Express app
// and hands it to Vercel as the function handler (an Express app IS a
// (req, res) handler). All /api/* routes are rewritten to this function.
//
// IMPORTANT: only the fast web/API layer runs here. Discovery itself is executed
// by the worker (src/worker.ts) on a separate always-on host.
import app from '../dist/server/app.js';

export default app;
