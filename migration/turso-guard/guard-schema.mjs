import {IDENTITY_MAPPING_SQL, IDENTITY_MATERIALIZED_SQL} from './identity-sql.mjs';
import {receiptQuerySQL} from './receipt-url-sql.mjs';
import {receiptAcceptedSQL} from './receipt-sql.mjs';
import {PREPARATION_SCHEMA_SQL} from './preparation-ledger.mjs';
import {HISTORY_IMPORT_SCHEMA_SQL,HISTORY_IMPORT_PREPARATION_FENCE_SQL} from './history-import.mjs';

// Isolated feasibility schema, NOT a production migration or an authorization
// service. Bootstrap is trusted, versioned DDL; runtime writers get only DML.
// Identity normalization is SQL over raw columns, never a connection-local UDF.
const immutable = (table, conflict) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable_guard_record'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable_guard_record'); END;
CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table} WHEN ${conflict}
BEGIN SELECT RAISE(ABORT,'immutable_guard_record'); END;
`;

const sameEmployer = (a, b) => `(${a}.company_key IN (${b}.company_key,${b}.tenant_key) OR (${a}.tenant_key!='' AND ${a}.tenant_key IN (${b}.company_key,${b}.tenant_key)))`;
const matches = (a, b) => `((${a}.canonical_url IS NOT NULL AND ${a}.canonical_url=${b}.canonical_url)
 OR (${a}.handoff_posting_key!='' AND ${a}.handoff_posting_key=${b}.handoff_posting_key)
 OR (${a}.role_key!='' AND ${a}.role_key=${b}.role_key AND ${sameEmployer(a,b)})
 OR (${a}.company_key=${b}.company_key AND ${a}.history_title_key=${b}.history_title_key))`;

export const GUARD_SCHEMA_SQL = `
CREATE TABLE guard_accounts(user_id TEXT PRIMARY KEY NOT NULL,stopped INTEGER NOT NULL DEFAULT 1 CHECK(stopped IN (0,1)));
CREATE TRIGGER guard_accounts_identity BEFORE UPDATE OF user_id ON guard_accounts BEGIN SELECT RAISE(ABORT,'immutable_account'); END;
CREATE TRIGGER guard_accounts_no_delete BEFORE DELETE ON guard_accounts BEGIN SELECT RAISE(ABORT,'immutable_account'); END;
CREATE TRIGGER guard_accounts_no_replace BEFORE INSERT ON guard_accounts WHEN EXISTS(SELECT 1 FROM guard_accounts WHERE user_id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'immutable_account'); END;
CREATE TABLE guard_identities(
 id TEXT PRIMARY KEY NOT NULL,user_id TEXT NOT NULL REFERENCES guard_accounts(user_id),
 company TEXT NOT NULL,title TEXT NOT NULL,url TEXT,UNIQUE(id,user_id)
);
${immutable('guard_identities', 'EXISTS(SELECT 1 FROM guard_identities WHERE id=NEW.id)')}
${IDENTITY_MAPPING_SQL}
${IDENTITY_MATERIALIZED_SQL}
CREATE TABLE guard_protections(
 protection_id TEXT PRIMARY KEY NOT NULL,user_id TEXT NOT NULL,identity_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('excluded','uncertain','reserved')),source TEXT NOT NULL,
 FOREIGN KEY(identity_id,user_id) REFERENCES guard_identities(id,user_id)
);
${immutable('guard_protections','EXISTS(SELECT 1 FROM guard_protections WHERE protection_id=NEW.protection_id)')}
CREATE TABLE guard_holds(
 hold_id TEXT PRIMARY KEY NOT NULL,user_id TEXT NOT NULL,identity_id TEXT NOT NULL,applicant_id TEXT,
 reason TEXT NOT NULL CHECK(reason IN ('security','quota')),
 FOREIGN KEY(identity_id,user_id) REFERENCES guard_identities(id,user_id)
);
${immutable('guard_holds','EXISTS(SELECT 1 FROM guard_holds WHERE hold_id=NEW.hold_id)')}
CREATE TABLE guard_claims(
 claim_id TEXT PRIMARY KEY NOT NULL,user_id TEXT NOT NULL,request_id TEXT NOT NULL,identity_id TEXT NOT NULL,
 applicant_id TEXT NOT NULL,owner TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('preparation','submission')),
 created_at TEXT NOT NULL,UNIQUE(user_id,request_id),UNIQUE(claim_id,user_id),
 FOREIGN KEY(identity_id,user_id) REFERENCES guard_identities(id,user_id)
);
${immutable('guard_claims','EXISTS(SELECT 1 FROM guard_claims WHERE claim_id=NEW.claim_id OR (user_id=NEW.user_id AND request_id=NEW.request_id))')}
CREATE TABLE guard_intents(
 claim_id TEXT PRIMARY KEY NOT NULL,user_id TEXT NOT NULL,owner TEXT NOT NULL,created_at TEXT NOT NULL,
 FOREIGN KEY(claim_id,user_id) REFERENCES guard_claims(claim_id,user_id)
);
${immutable('guard_intents','EXISTS(SELECT 1 FROM guard_intents WHERE claim_id=NEW.claim_id)')}
CREATE TRIGGER guard_intents_validate BEFORE INSERT ON guard_intents BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM guard_claims c WHERE c.claim_id=NEW.claim_id AND c.user_id=NEW.user_id AND c.owner=NEW.owner AND c.kind='submission' AND c.created_at=NEW.created_at) THEN RAISE(ABORT,'invalid_intent') END;
END;
CREATE TABLE guard_events(
 event_id TEXT PRIMARY KEY NOT NULL,claim_id TEXT NOT NULL,user_id TEXT NOT NULL,
 type TEXT NOT NULL CHECK(type IN ('reserved','submission_intent','submitted')),at TEXT NOT NULL,
 FOREIGN KEY(claim_id,user_id) REFERENCES guard_claims(claim_id,user_id)
);
${immutable('guard_events','EXISTS(SELECT 1 FROM guard_events WHERE event_id=NEW.event_id)')}
CREATE TABLE guard_receipts(
 claim_id TEXT PRIMARY KEY NOT NULL,user_id TEXT NOT NULL,owner TEXT NOT NULL,identity_id TEXT NOT NULL,
 receipt_id TEXT,receipt_text TEXT NOT NULL,observed_at TEXT NOT NULL,synced_at TEXT NOT NULL,
 FOREIGN KEY(claim_id,user_id) REFERENCES guard_claims(claim_id,user_id),
 FOREIGN KEY(identity_id,user_id) REFERENCES guard_identities(id,user_id)
);
${immutable('guard_receipts','EXISTS(SELECT 1 FROM guard_receipts WHERE claim_id=NEW.claim_id)')}
CREATE TABLE guard_outcomes(
 outcome_id TEXT PRIMARY KEY NOT NULL,sequence INTEGER NOT NULL UNIQUE,claim_id TEXT NOT NULL,user_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('interview','rejected','offer')),at TEXT NOT NULL,
 FOREIGN KEY(claim_id,user_id) REFERENCES guard_claims(claim_id,user_id)
);
${immutable('guard_outcomes','EXISTS(SELECT 1 FROM guard_outcomes WHERE outcome_id=NEW.outcome_id OR sequence=NEW.sequence)')}

CREATE TRIGGER guard_claims_check BEFORE INSERT ON guard_claims BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM guard_accounts WHERE user_id=NEW.user_id AND stopped=0) THEN RAISE(ABORT,'account_stopped_or_missing') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM guard_identity_keys c WHERE c.id=NEW.identity_id AND c.user_id=NEW.user_id AND c.valid=1 AND c.posting_key!='') THEN RAISE(ABORT,'invalid_candidate_identity') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM guard_protections p JOIN guard_identity_keys k ON k.id=p.identity_id WHERE p.user_id=NEW.user_id AND k.valid!=1)
 OR EXISTS(SELECT 1 FROM guard_holds h JOIN guard_identity_keys k ON k.id=h.identity_id WHERE h.user_id=NEW.user_id AND k.valid!=1)
 THEN RAISE(ABORT,'invalid_protected_identity_blocks_account') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM guard_protections p JOIN guard_identity_keys k ON k.id=p.identity_id JOIN guard_identity_keys c ON c.id=NEW.identity_id WHERE p.user_id=NEW.user_id AND ${matches('c','k')}) THEN RAISE(ABORT,'application_already_protected') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM guard_holds h JOIN guard_identity_keys k ON k.id=h.identity_id JOIN guard_identity_keys c ON c.id=NEW.identity_id WHERE h.user_id=NEW.user_id AND (NEW.kind='preparation' OR h.applicant_id IS NULL OR h.applicant_id=NEW.applicant_id) AND ${sameEmployer('c','k')}) THEN RAISE(ABORT,'employer_hold') END;
END;
CREATE TRIGGER guard_claims_record AFTER INSERT ON guard_claims BEGIN
 INSERT INTO guard_protections VALUES('claim:'||NEW.claim_id,NEW.user_id,NEW.identity_id,CASE NEW.kind WHEN 'submission' THEN 'uncertain' ELSE 'reserved' END,'claim');
 INSERT INTO guard_events VALUES('claim:'||NEW.claim_id,NEW.claim_id,NEW.user_id,'reserved',NEW.created_at);
 INSERT INTO guard_intents SELECT NEW.claim_id,NEW.user_id,NEW.owner,NEW.created_at WHERE NEW.kind='submission';
 INSERT INTO guard_events SELECT 'intent:'||NEW.claim_id,NEW.claim_id,NEW.user_id,'submission_intent',NEW.created_at WHERE NEW.kind='submission';
END;
CREATE TRIGGER guard_receipts_check BEFORE INSERT ON guard_receipts BEGIN
 SELECT CASE WHEN NOT ${receiptAcceptedSQL('NEW.receipt_text')} THEN RAISE(ABORT,'unsupported_receipt_text') END;
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM guard_claims c JOIN guard_intents a ON a.claim_id=c.claim_id
  JOIN guard_identity_keys original ON original.id=c.identity_id
  JOIN guard_identity_keys evidence ON evidence.id=NEW.identity_id
  JOIN guard_identities original_raw ON original_raw.id=c.identity_id
  JOIN guard_identities evidence_raw ON evidence_raw.id=NEW.identity_id
  WHERE c.claim_id=NEW.claim_id AND c.user_id=NEW.user_id AND c.owner=NEW.owner AND a.owner=NEW.owner
  AND c.kind='submission' AND evidence.user_id=c.user_id AND evidence.valid=1
  AND original.canonical_url IS NOT NULL AND original.canonical_url=evidence.canonical_url
  AND ${receiptQuerySQL('original_raw.url')}=${receiptQuerySQL('evidence_raw.url')}
  AND length(NEW.observed_at)=24 AND length(NEW.synced_at)=24
  AND strftime('%Y-%m-%dT%H:%M:%fZ',NEW.observed_at)=NEW.observed_at
  AND strftime('%Y-%m-%dT%H:%M:%fZ',NEW.synced_at)=NEW.synced_at
  AND julianday(NEW.observed_at)>=julianday(a.created_at)
  AND julianday(NEW.observed_at)<=julianday(NEW.synced_at)
  AND julianday(NEW.synced_at)<=julianday('now')
 ) THEN RAISE(ABORT,'unattributable_receipt') END;
END;
CREATE TRIGGER guard_receipts_record AFTER INSERT ON guard_receipts BEGIN
 INSERT INTO guard_events VALUES('receipt:'||NEW.claim_id,NEW.claim_id,NEW.user_id,'submitted',NEW.observed_at);
END;
CREATE TRIGGER guard_events_check BEFORE INSERT ON guard_events BEGIN
 SELECT CASE WHEN NOT (
  (NEW.type='reserved' AND NEW.event_id='claim:'||NEW.claim_id AND EXISTS(SELECT 1 FROM guard_claims c WHERE c.claim_id=NEW.claim_id AND c.user_id=NEW.user_id AND c.created_at=NEW.at))
  OR (NEW.type='submission_intent' AND NEW.event_id='intent:'||NEW.claim_id AND EXISTS(SELECT 1 FROM guard_intents a WHERE a.claim_id=NEW.claim_id AND a.user_id=NEW.user_id AND a.created_at=NEW.at))
  OR (NEW.type='submitted' AND NEW.event_id='receipt:'||NEW.claim_id AND EXISTS(SELECT 1 FROM guard_receipts r WHERE r.claim_id=NEW.claim_id AND r.user_id=NEW.user_id AND r.observed_at=NEW.at))
 ) THEN RAISE(ABORT,'invalid_guard_event') END;
END;
CREATE VIEW guard_claim_state AS SELECT c.*,
 coalesce((SELECT o.status FROM guard_outcomes o WHERE o.claim_id=c.claim_id ORDER BY sequence DESC LIMIT 1),
 CASE WHEN EXISTS(SELECT 1 FROM guard_receipts r WHERE r.claim_id=c.claim_id) THEN 'submitted'
 WHEN c.kind='submission' THEN 'uncertain' ELSE 'reserved' END) AS state
 FROM guard_claims c;
${PREPARATION_SCHEMA_SQL}
${HISTORY_IMPORT_SCHEMA_SQL}
${HISTORY_IMPORT_PREPARATION_FENCE_SQL}
`;

// Trusted installer only: caller must own the bootstrap transaction and reject
// an existing schema. No IF NOT EXISTS can silently accept an incompatible DB.
export async function installGuardSchema(client) {
 const tx = await client.transaction('write');
 try { await tx.executeMultiple(GUARD_SCHEMA_SQL); await tx.commit(); }
 catch (error) { if (!tx.closed) await tx.rollback(); throw error; }
 finally { tx.close(); }
}
