import {randomUUID} from 'node:crypto';
import {DatabaseError} from '../database/async-database.js';

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Relationship checks, limit checks, writes and draft invalidation all share a
// transaction. uid comes from the existing authenticated request boundary.
export async function professionalExperience(database, {uid, applicant, id = null, method, input}) {
  if (!uid) return {status: 401, body: {error: 'Sign in required'}};
  try {
    const body = await database[method === 'GET' ? 'read' : 'write'](async tx => {
      if (!await tx.get('SELECT id FROM applicants WHERE id=? AND user_id=?', applicant, uid))
        throw new RequestError(404, 'Profile not found.');
      if (method === 'GET' && !id)
        return {facts: await tx.all('SELECT id,title,details,approved_at,updated_at FROM professional_experience WHERE user_id=? AND applicant_id=? ORDER BY title,id', uid, applicant)};
      if (method === 'DELETE' && id) {
        if (!(await tx.run('DELETE FROM professional_experience WHERE id=? AND user_id=? AND applicant_id=?', id, uid, applicant)).changes)
          throw new RequestError(400, 'Experience not found.');
        return {ok: true};
      }
      if (!(method === 'POST' && !id || method === 'PUT' && id)) throw new RequestError(405, 'Unsupported operation.');
      if (input?.approved !== true) throw new RequestError(400, 'Confirm these are your real professional facts before saving.');
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      const details = typeof input.details === 'string' ? input.details.trim() : '';
      if (title.length < 3 || title.length > 160 || details.length < 20 || details.length > 8000)
        throw new RequestError(400, 'Add a short title and 20-8,000 characters of factual detail.');
      if (id && !await tx.get('SELECT id FROM professional_experience WHERE id=? AND user_id=? AND applicant_id=?', id, uid, applicant))
        throw new RequestError(400, 'Experience not found.');
      if (!id && (await tx.get('SELECT COUNT(*) AS n FROM professional_experience WHERE user_id=? AND applicant_id=?', uid, applicant)).n >= 150)
        throw new RequestError(400, 'Edit an existing example before adding more than 150.');
      const recordId = id || randomUUID(), at = new Date().toISOString();
      if (id) await tx.run('UPDATE professional_experience SET title=?,details=?,approved_at=?,updated_at=? WHERE id=? AND user_id=? AND applicant_id=?', title, details, at, at, id, uid, applicant);
      else await tx.run('INSERT INTO professional_experience(id,user_id,applicant_id,title,details,approved_at,updated_at) VALUES(?,?,?,?,?,?,?)', recordId, uid, applicant, title, details, at, at);
      // Preserve the original predicate: no reset for any attempted job.
      await tx.run("UPDATE public_fill_attempts SET attempted_at='1970-01-01' WHERE state='needs_review' AND job_id IN (SELECT id FROM jobs WHERE user_id=? AND applicant_id=? AND local_attempt_at IS NULL)", uid, applicant);
      return {id: recordId};
    });
    return {status: 200, body};
  } catch (error) {
    if (error instanceof RequestError) return {status: error.status, body: {error: error.message}};
    return {status: 503, body: {error: 'Professional facts could not be confirmed. Reload the profile before making another change.', code: error instanceof DatabaseError ? error.code : 'database_unavailable'}};
  }
}
