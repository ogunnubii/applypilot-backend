// SQL-only receipt text policy. The installer generates SQL from these fixed
// grammars; runtime evidence is always a bound value/raw database column. No
// JavaScript database function, writable policy table or validated flag exists.
//
// This ports the boolean receipt predicate in extension/policy.js plus the
// placeholder veto in operation-evidence.js. It does NOT prove receipt_event,
// application URL identity, intent, ownership, attribution or timestamp order;
// the guard must enforce those independently. It also does not strengthen or
// reinterpret the native policy's English-language evidence heuristics.
//
// Supported inputs are valid UTF-8 SQLite TEXT without NUL, at most 8192 bytes.
// Other inputs fail closed with an explicit unsupported classification. Never
// truncate evidence before this predicate: a later contradiction must veto it.
// Native regexes use non-Unicode /i and ASCII \b: SQLite lower() and GLOB's
// [a-z0-9_] boundaries have the same ASCII behavior. ECMAScript whitespace is
// listed explicitly instead of relying on SQLite's narrower trim defaults.

export const RECEIPT_SQL_POLICY = Object.freeze({
 version: 'native-receipt-text-v1',
 maxBytes: 8192,
 unsupported: Object.freeze(['non_text', 'length', 'nul', 'utf8']),
});

const literal = value => "'" + value.replaceAll("'", "''") + "'";
const values = phrases => [...new Set(phrases)].map(s => '(' + literal(s) + ')').join(',\n');
const whitespace = 'char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)';
const wordMatch = (text, phrase) => `(' '||${text}||' ') GLOB ('*[^a-z0-9_]'||${phrase}||'[^a-z0-9_]*')`;
const prefixMatch = (text, phrase) => `(substr(${text},1,length(${phrase}))=${phrase} AND (substr(${text},length(${phrase})+1,1)='' OR substr(${text},length(${phrase})+1,1) NOT GLOB '[a-z0-9_]'))`;

const failure = [];
for (const job of ['', 'job ']) for (const was of ['', 'was ']) for (const verb of ['received', 'submitted']) failure.push(`no ${job}application ${was}${verb}`);
for (const negation of ['not', 'never']) for (const been of ['', 'been ']) for (const verb of ['submitted', 'received', 'processed', 'sent', 'delivered', 'accepted']) failure.push(`${negation} ${been}${verb}`);
for (const unable of ["couldn't", 'couldn\u2019t', 'could not', 'cannot', "can't", 'can\u2019t', 'unable to', 'failed to']) for (const be of ['', 'be ']) for (const verb of ['submit', 'submitted', 'receive', 'received', 'process', 'processed', 'send', 'sent', 'deliver', 'delivered', 'accept', 'accepted']) failure.push(`${unable} ${be}${verb}`);
for (const noun of ['submission', 'delivery']) for (const outcome of ['failed', 'has failed', 'had failed', 'was unsuccessful']) failure.push(`${noun} ${outcome}`);
failure.push('unsuccessful', 'a error occurred', 'an error occurred', 'with error', 'with errors', 'pending', 'awaiting', 'queued');

const affirmative = [];
for (const your of ['', 'your ']) for (const tense of ['', 'has been ', 'was ']) for (const successfully of ['', 'successfully ']) for (const verb of ['submitted', 'received']) affirmative.push(`${your}application ${tense}${successfully}${verb}`);
for (const thanks of ['thanks', 'thank you']) for (const object of ['applying', 'your application']) affirmative.push(`${thanks} for ${object}`);

const placeholder = ['reached your application limit', 'application limit reached', 'application limit has been reached', "couldn't submit your application", 'couldn\u2019t submit your application', 'could not submit your application', 'placeholder', 'example.com', 'github.com', 'unconfirmed', 'simulat', 'test receipt'];
for (const yet of ['', 'yet ']) for (const state of ['submitted', 'confirmed']) placeholder.push(`not ${yet}${state}`);

function trustedReference(expression) {
 // Restrict the installer API to a simple column/qualified column or numbered
 // bind parameter. Receipt data must never be interpolated into generated SQL.
 if (typeof expression !== 'string' || !/^(?:\?[1-9][0-9]*|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)$/.test(expression)) throw new TypeError('trusted_receipt_sql_reference_required');
 return expression;
}

/** A scalar SQL expression returning an accepted/rejected/unsupported code. */
export function receiptClassificationSQL(expression) {
 const input = trustedReference(expression);
 const continuing = "((s.skip=1 AND c.nl=1) OR (s.skip=2 AND c.ws=1))";
 const delimiter = "(c.nl=1 OR (c.ws=1 AND c.prev IN ('.','!','?')))";
 const start = `(NOT ${continuing} AND ${delimiter})`;
 const receivedError = `(${wordMatch('f.line', "'received a error'")} OR ${wordMatch('f.line', "'received an error'")})`;
 const sentPrefix = 'your job application has been sent to ';
 return `(WITH RECURSIVE
 receipt_raw(value) AS MATERIALIZED (SELECT ${input}),
 receipt_checked(value,problem) AS MATERIALIZED (
  SELECT value,CASE WHEN typeof(value)!='text' THEN 'unsupported_non_text'
   WHEN length(CAST(value AS BLOB))>${RECEIPT_SQL_POLICY.maxBytes} THEN 'unsupported_length'
   WHEN instr(value,char(0))>0 THEN 'unsupported_nul' ELSE NULL END FROM receipt_raw
 ),
 receipt_text(value,n,ws) AS MATERIALIZED (
  SELECT lower(CASE WHEN problem IS NULL THEN value ELSE '' END),
   length(CASE WHEN problem IS NULL THEN value ELSE '' END),${whitespace} FROM receipt_checked
 ),
 receipt_failures(phrase) AS (VALUES ${values(failure)}),
 receipt_affirmatives(phrase) AS (VALUES ${values(affirmative)}),
 receipt_placeholders(phrase) AS (VALUES ${values(placeholder)}),
 receipt_positions(pos) AS (SELECT 1 FROM receipt_text WHERE n>0 UNION ALL SELECT pos+1 FROM receipt_positions,receipt_text WHERE pos<n),
 receipt_chars(pos,c,prev,nl,ws) AS MATERIALIZED (
  SELECT pos,substr(value,pos,1),substr(value,pos-1,1),substr(value,pos,1) IN (char(10),char(13)),instr(ws,substr(value,pos,1))>0 FROM receipt_positions,receipt_text
 ),
 -- Split exactly like /[\\r\\n]+|(?<=[.!?])\\s+/ including leading/trailing
 -- empty sentences. The first alternative has priority at a CR/LF boundary.
 receipt_scan(i,seq,begin,skip) AS (
  VALUES(0,0,1,0)
  UNION ALL SELECT c.pos,s.seq+CASE WHEN ${start} THEN 1 ELSE 0 END,
   CASE WHEN ${continuing} OR ${start} THEN c.pos+1 ELSE s.begin END,
   CASE WHEN ${continuing} THEN s.skip WHEN ${start} THEN CASE WHEN c.nl=1 THEN 1 ELSE 2 END ELSE 0 END
  FROM receipt_scan s JOIN receipt_chars c ON c.pos=s.i+1
 ),
 receipt_spans(seq,begin,ending) AS MATERIALIZED (
  SELECT s.seq,s.begin,c.pos FROM receipt_scan s JOIN receipt_chars c ON c.pos=s.i+1 WHERE ${start}
  UNION ALL SELECT s.seq,s.begin,t.n+1 FROM receipt_scan s,receipt_text t WHERE s.i=t.n
 ),
 receipt_lines(seq,line,previous) AS MATERIALIZED (
  SELECT seq,substr(value,begin,ending-begin),lag(substr(value,begin,ending-begin),'1','') OVER(ORDER BY seq) FROM receipt_spans,receipt_text
 ),
 receipt_flags(seq,line,previous,failed,trimmed) AS MATERIALIZED (
  SELECT seq,line,previous,EXISTS(SELECT 1 FROM receipt_failures f WHERE ${wordMatch('line','f.phrase')}),trim(line,ws) FROM receipt_lines,receipt_text
 ),
 receipt_unprefixed(seq,line,previous,failed,trimmed,affirmative_line) AS MATERIALIZED (
  SELECT f.*,CASE WHEN substr(trimmed,1,19)='applicant verified:' THEN ltrim(substr(trimmed,20),ws)
   WHEN substr(trimmed,1,27)='browser extension observed:' THEN ltrim(substr(trimmed,28),ws) ELSE trimmed END
  FROM receipt_flags f,receipt_text
 ),
 -- Sent-to receipts are anchored to the start or a physical CR/LF, unlike
 -- ordinary receipt sentences. Do not accept a preceding sentence on a line.
 receipt_physical(pos,line) AS MATERIALIZED (
  SELECT pos,ltrim(substr(value,pos),receipt_text.ws) FROM receipt_chars,receipt_text WHERE pos=1 OR prev IN (char(10),char(13))
 ),
 receipt_sent_lines(pos,line) AS (
  SELECT pos,CASE WHEN substr(line,1,20)='applicant verified: ' THEN substr(line,21)
   WHEN substr(line,1,28)='browser extension observed: ' THEN substr(line,29) ELSE line END FROM receipt_physical
 ),
 receipt_sent_bodies(pos,body) AS MATERIALIZED (
  SELECT pos,substr(line,${sentPrefix.length+1}) FROM receipt_sent_lines WHERE substr(line,1,${sentPrefix.length})=${literal(sentPrefix)}
 ),
 receipt_sent_ends(pos,body,ending) AS MATERIALIZED (
  SELECT pos,body,min(${['.', '!', '?', '\r', '\n'].map(c => {const l=literal(c);return `CASE WHEN instr(body,${l})>0 THEN instr(body,${l}) ELSE length(body)+1 END`;}).join(',')}) FROM receipt_sent_bodies
 ),
 receipt_sent_match(value) AS MATERIALIZED (
  SELECT ${literal(sentPrefix)}||substr(body,1,ending) FROM receipt_sent_ends,receipt_text
  WHERE substr(body,ending,1) IN ('.','!')
   AND (substr(body,ending+1,1)='' OR instr(ws,substr(body,ending+1,1))>0)
   AND (SELECT sum(1+(unicode(substr(body,pos,1))>65535)) FROM receipt_positions WHERE pos<ending) BETWEEN 2 AND 100
  ORDER BY receipt_sent_ends.pos LIMIT 1
 )
 SELECT CASE WHEN problem IS NOT NULL THEN problem
  -- SQLite unicode() reports U+FFFD for the valid noncharacters U+FFFE/FFFF.
  -- Preserve those two exact encodings; other non-roundtripping bytes reject.
  WHEN EXISTS(SELECT 1 FROM receipt_chars WHERE CAST(c AS BLOB)!=CAST(char(unicode(c)) AS BLOB) AND CAST(c AS BLOB) NOT IN (x'EFBFBE',x'EFBFBF')) THEN 'unsupported_utf8'
  WHEN EXISTS(SELECT 1 FROM receipt_placeholders p,receipt_text t WHERE instr(t.value,p.phrase)>0) THEN 'rejected_placeholder'
  WHEN EXISTS(SELECT 1 FROM receipt_flags f WHERE failed AND (
   ${wordMatch('f.line',"'application'")} OR ${wordMatch('f.line',"'submission'")} OR ${wordMatch('f.line',"'delivery'")}
   OR (${prefixMatch(`ltrim(f.line,${whitespace})`,"'it'")} AND ${wordMatch('f.previous',"'application'")})
  )) THEN 'rejected_contradiction'
  WHEN EXISTS(SELECT 1 FROM receipt_flags f WHERE ${prefixMatch(`ltrim(f.line,${whitespace})`,"'your application submission was flagged as possible spam'")}) THEN 'rejected_spam'
  WHEN EXISTS(SELECT 1 FROM receipt_unprefixed f WHERE NOT failed AND NOT ${receivedError}
   AND EXISTS(SELECT 1 FROM receipt_affirmatives a WHERE ${prefixMatch('f.affirmative_line','a.phrase')})) THEN 'accepted'
  WHEN EXISTS(SELECT 1 FROM receipt_sent_match m WHERE NOT (${['pending','not','awaiting','queued','failed'].map(s=>wordMatch('m.value',literal(s))).join(' OR ')})) THEN 'accepted'
  ELSE 'rejected_no_affirmative' END FROM receipt_checked)`;
}

/** Scalar integer 0/1; NULL, unsupported input and every veto return 0. */
export function receiptAcceptedSQL(expression) {
 return `(${receiptClassificationSQL(expression)}='accepted')`;
}
