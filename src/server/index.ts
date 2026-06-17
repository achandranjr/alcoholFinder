import { app } from './app.js';
import { config } from '../config.js';

/**
 * Local / self-hosted entry point: start a long-running HTTP server. On Vercel
 * the app is exported as a serverless function instead (see api/index.ts), so
 * this file's app.listen() is never called there.
 *
 * Note: this serves only the dashboard + API. Discovery runs are executed by
 * the worker (npm run worker), which must also be running for queued runs to
 * make progress.
 */
app.listen(config.PORT, () => {
  console.log(`Dashboard → http://localhost:${config.PORT}`);
  console.log('Reminder: run `npm run worker` (separately) to process queued runs.');
});
