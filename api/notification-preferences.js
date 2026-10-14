import {DatabaseError} from '../database/async-database.js';

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// uid comes from the existing authenticated server boundary, never from a body.
// No provider request, mail enqueue, or applicant/application update occurs here.
export async function notificationPreferences(database, {uid, method, input, configured = false}) {
  if (!uid) return {status: 401, body: {error: 'Sign in required'}};
  if (!['GET', 'PUT'].includes(method)) return {status: 405, body: {error: 'Unsupported operation.'}};
  if (method === 'PUT' && (input === null || typeof input !== 'object' || Array.isArray(input) || typeof input.enabled !== 'boolean'))
    return {status: 400, body: {error: 'Choose whether to enable blocker emails'}};
  try {
    const body = await database[method === 'PUT' ? 'write' : 'read'](async tx => {
      // Recheck account existence with the mutation on the same connection.
      if (!await tx.get('SELECT id FROM users WHERE id=?', uid)) throw new RequestError(401, 'Sign in required');
      const security = await tx.get('SELECT email_verified_at FROM public_account_security WHERE user_id=?', uid);
      const emailAllowed = !security || !!security.email_verified_at;
      if (method === 'PUT') {
        if (input.enabled && !emailAllowed) throw new RequestError(403, 'Email notifications are unavailable until mailbox ownership can be verified.');
        await tx.run('INSERT INTO notification_preferences(user_id,enabled) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled', uid, input.enabled ? 1 : 0);
      }
      const enabled = !!(await tx.get('SELECT enabled FROM notification_preferences WHERE user_id=?', uid))?.enabled;
      const failed = (await tx.get('SELECT COUNT(*) AS n FROM blocker_emails b JOIN jobs j ON j.id=b.job_id WHERE j.user_id=? AND b.last_error IS NOT NULL', uid)).n;
      return {enabled: emailAllowed && enabled, configured: emailAllowed && configured, emailVerificationRequired: !emailAllowed, failed};
    });
    return {status: 200, body};
  } catch (error) {
    if (error instanceof RequestError) return {status: error.status, body: {error: error.message}};
    // Never echo driver errors: they can include URLs, SQL values or tokens.
    return {status: 503, body: {error: 'Notification settings could not be confirmed. Reload settings before changing them again.', code: error instanceof DatabaseError ? error.code : 'database_unavailable'}};
  }
}
