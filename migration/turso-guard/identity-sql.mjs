import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

// Review-only guard prototype. No connection-local functions, no caller-supplied
// normalized keys. All expressions operate on the raw guard_identities columns.
// URLs deliberately support a strict subset of WHATWG URL; unsupported protected
// identities MUST block every new claim for their account, never be filtered out.
const artifact = JSON.parse(readFileSync(new URL('./unicode-identity-map.json', import.meta.url), 'utf8'));
const actualHash = createHash('sha256').update(JSON.stringify(artifact.rows)).digest('hex');
if (actualHash !== artifact.sha256) throw Error('identity_mapping_integrity');
export const IDENTITY_MAPPING = Object.freeze({version: artifact.version, unicode: artifact.unicode, sha256: actualHash, rows: artifact.rows.length});
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";

export const IDENTITY_TABLE_SQL = `CREATE TABLE guard_identities(
 id TEXT PRIMARY KEY NOT NULL,user_id TEXT NOT NULL,company TEXT NOT NULL,title TEXT NOT NULL,url TEXT
);`;

// Install once inside the schema-bootstrap write transaction, before making the
// database available to application writers. Do not permit runtime schema DDL.
export const IDENTITY_MAPPING_SQL = `
CREATE TABLE guard_unicode_map(codepoint INTEGER PRIMARY KEY,ascii_key TEXT NOT NULL,role_form TEXT NOT NULL,suffix_form TEXT NOT NULL) WITHOUT ROWID;
INSERT INTO guard_unicode_map VALUES ${artifact.rows.map(row => '(' + row.map((v, i) => i ? quote(v) : v).join(',') + ')').join(',')};
CREATE TABLE guard_identity_version(version TEXT PRIMARY KEY,unicode_version TEXT NOT NULL,sha256 TEXT NOT NULL);
INSERT INTO guard_identity_version VALUES(${quote(artifact.version)},${quote(artifact.unicode)},${quote(actualHash)});
CREATE TRIGGER guard_unicode_no_insert BEFORE INSERT ON guard_unicode_map BEGIN SELECT RAISE(ABORT,'immutable_identity_mapping'); END;
CREATE TRIGGER guard_unicode_no_update BEFORE UPDATE ON guard_unicode_map BEGIN SELECT RAISE(ABORT,'immutable_identity_mapping'); END;
CREATE TRIGGER guard_unicode_no_delete BEFORE DELETE ON guard_unicode_map BEGIN SELECT RAISE(ABORT,'immutable_identity_mapping'); END;
CREATE TRIGGER guard_version_no_insert BEFORE INSERT ON guard_identity_version BEGIN SELECT RAISE(ABORT,'immutable_identity_mapping'); END;
CREATE TRIGGER guard_version_no_update BEFORE UPDATE ON guard_identity_version BEGIN SELECT RAISE(ABORT,'immutable_identity_mapping'); END;
CREATE TRIGGER guard_version_no_delete BEFORE DELETE ON guard_identity_version BEGIN SELECT RAISE(ABORT,'immutable_identity_mapping'); END;
`;

// sourceSql is only supplied by the fixed schema builders below; never accept it
// from a request. The inserted-row form narrows the raw source before any CTE.
function identitySelectSQL(sourceSql) { return `WITH RECURSIVE
u0 AS MATERIALIZED (SELECT *,trim(url) AS raw_url FROM (${sourceSql})),
u1 AS (SELECT *,CASE WHEN instr(raw_url,'#')>0 THEN substr(raw_url,1,instr(raw_url,'#')-1) ELSE raw_url END AS no_fragment FROM u0),
u2 AS MATERIALIZED (SELECT *,CASE WHEN instr(no_fragment,'?')>0 THEN substr(no_fragment,1,instr(no_fragment,'?')-1) ELSE no_fragment END AS base_url,
 CASE WHEN instr(no_fragment,'?')>0 THEN substr(no_fragment,instr(no_fragment,'?')+1) ELSE '' END AS query FROM u1),
u3 AS (SELECT *,substr(base_url,9) AS authority_path FROM u2),
u4 AS MATERIALIZED (SELECT *,lower(CASE WHEN instr(authority_path,'/')>0 THEN substr(authority_path,1,instr(authority_path,'/')-1) ELSE authority_path END) AS host,
 CASE WHEN instr(authority_path,'/')>0 THEN substr(authority_path,instr(authority_path,'/')) ELSE '/' END AS path FROM u3),
u5 AS (SELECT *,substr(path,2) AS path_tail FROM u4),
u6 AS MATERIALIZED (SELECT *,CASE WHEN instr(path_tail,'/')>0 THEN substr(path_tail,1,instr(path_tail,'/')-1) ELSE path_tail END AS tenant,
 CASE WHEN instr(path_tail,'/')>0 THEN substr(path_tail,instr(path_tail,'/')+1) ELSE '' END AS after_tenant FROM u5),
u7 AS (SELECT *,CASE WHEN instr(after_tenant,'/')>0 THEN substr(after_tenant,1,instr(after_tenant,'/')-1) ELSE after_tenant END AS segment2,
 CASE WHEN instr(after_tenant,'/')>0 THEN substr(after_tenant,instr(after_tenant,'/')+1) ELSE '' END AS after_segment2 FROM u6),
url_parts AS MATERIALIZED (SELECT *,CASE WHEN instr(after_segment2,'/')>0 THEN substr(after_segment2,1,instr(after_segment2,'/')-1) ELSE after_segment2 END AS segment3 FROM u7),
queries(id,remaining,part) AS (
 SELECT id,query||'&','' FROM url_parts WHERE query!=''
 UNION ALL SELECT id,substr(remaining,instr(remaining,'&')+1),substr(remaining,1,instr(remaining,'&')-1) FROM queries WHERE remaining!=''
),
query_keys AS (SELECT id,lower(CASE WHEN instr(part,'=')>0 THEN substr(part,1,instr(part,'=')-1) ELSE part END) AS qkey FROM queries WHERE part!=''),
url_validity AS MATERIALIZED (SELECT *,CASE WHEN url IS NULL THEN 1 WHEN
 typeof(url)='text' AND length(url)<=3000 AND instr(url,char(0))=0 AND
 lower(substr(base_url,1,8))='https://' AND host LIKE '%.%' AND
 host NOT GLOB '*[^a-z0-9.-]*' AND host NOT GLOB '*..*' AND host NOT GLOB '[.-]*' AND host NOT GLOB '*[.-]' AND
 host GLOB '*[a-z]*' AND host NOT GLOB '*.[0-9]*' AND host NOT LIKE '%.local' AND host NOT LIKE '%.localhost' AND
 raw_url NOT GLOB '*[^ -~]*' AND raw_url NOT GLOB '* *' AND instr(raw_url,char(92))=0 AND instr(raw_url,'%')=0 AND
 path NOT GLOB '*[^a-zA-Z0-9/._~-]*' AND instr(path,'//')=0 AND
 instr('/'||path||'/','/./')=0 AND instr('/'||path||'/','/../')=0 AND
 NOT EXISTS(SELECT 1 FROM query_keys q WHERE q.id=url_parts.id AND q.qkey NOT LIKE 'utm!_%' ESCAPE '!' AND q.qkey NOT IN ('gh_src','lever-source','lever-origin'))
 THEN 1 ELSE 0 END AS url_valid FROM url_parts),
inputs(id,kind,value) AS (
 SELECT id,'company',CASE WHEN length(company)<=200 THEN company ELSE '' END FROM url_validity
 UNION ALL SELECT id,'title',CASE WHEN length(title)<=500 THEN title ELSE '' END FROM url_validity
 UNION ALL SELECT id,'tenant',CASE WHEN host IN ('jobs.ashbyhq.com','boards.greenhouse.io','job-boards.greenhouse.io','jobs.lever.co','jobs.eu.lever.co') THEN tenant ELSE '' END FROM url_validity
),
norm(id,kind,value,pos,ascii_key,role_form,suffix_form,utf16_units) AS (
 SELECT id,kind,value,1,'','','',0 FROM inputs
 UNION ALL SELECT n.id,n.kind,n.value,n.pos+1,n.ascii_key||coalesce(m.ascii_key,''),n.role_form||coalesce(m.role_form,'~'),n.suffix_form||coalesce(m.suffix_form,'~'),n.utf16_units+CASE WHEN unicode(substr(n.value,n.pos,1))>65535 THEN 2 ELSE 1 END
 FROM norm n LEFT JOIN guard_unicode_map m ON m.codepoint=unicode(substr(n.value,n.pos,1)) WHERE n.pos<=length(n.value)
),
normalized AS MATERIALIZED (SELECT id,kind,ascii_key,role_form,suffix_form,utf16_units FROM norm WHERE pos>length(value)),
suffixes(suffix) AS (VALUES('incorporated'),('inc'),('corporation'),('corp'),('limited'),('ltd'),('llc')),
company_trim AS (SELECT *,rtrim(suffix_form,' ') AS suffix_trim FROM normalized WHERE kind IN ('company','tenant')),
company_dot AS (SELECT *,CASE WHEN substr(suffix_trim,-1)='.' THEN substr(suffix_trim,1,length(suffix_trim)-1) ELSE suffix_trim END AS suffix_base FROM company_trim),
company_strip AS (SELECT *,coalesce((SELECT length(suffix) FROM suffixes WHERE substr(suffix_base,-length(suffix))=suffix AND
 (length(suffix_base)=length(suffix) OR substr(suffix_base,length(suffix_base)-length(suffix),1) NOT GLOB '[a-z0-9_]') LIMIT 1),0) AS strip_count FROM company_dot),
company_keys AS MATERIALIZED (SELECT id,kind,utf16_units,CASE substr(ascii_key,1,length(ascii_key)-strip_count)
 WHEN 'clutchtechnologies' THEN 'clutch' WHEN 'arhsdevelopments' THEN 'arhs' WHEN 'pricewaterhousecoopers' THEN 'pwc'
 ELSE substr(ascii_key,1,length(ascii_key)-strip_count) END AS company_key FROM company_strip),
roles(id,form,pos,prefix) AS (
 SELECT id,role_form,1,'' FROM normalized WHERE kind='title'
 UNION ALL SELECT id,form,pos+1,prefix||CASE WHEN substr(form,pos,1) GLOB '[a-z0-9]' THEN substr(form,pos,1) ELSE '' END FROM roles WHERE pos<=length(form)
),
role_delimiters AS (SELECT *,substr(form,pos+1) AS tail FROM roles WHERE substr(form,pos,1)='|' AND substr(form,pos-1,1)=' ' AND substr(form,pos+1,1)=' '),
role_cuts AS (SELECT * FROM role_delimiters WHERE instr(tail,'|')=0 AND
 (instr(tail,'sponsor')>0 OR instr(tail,'relocation')>0 OR instr(tail,'remote')>0 OR instr(tail,'hybrid')>0 OR instr(tail,'on-site')>0)),
keys AS (SELECT u.id,u.user_id,c.company_key,t.ascii_key AS history_title_key,
 coalesce((SELECT prefix FROM role_cuts r WHERE r.id=u.id ORDER BY pos LIMIT 1),t.ascii_key) AS role_key,
 coalesce(tenant_key.company_key,'') AS tenant_key,
 CASE WHEN u.url_valid=1 AND u.host IN ('boards.greenhouse.io','job-boards.greenhouse.io') AND u.tenant!='' AND u.segment2='jobs' AND u.segment3!='' AND u.segment3 NOT GLOB '*[^0-9]*' THEN 'greenhouse:'||lower(u.tenant)||':'||u.segment3
 WHEN u.url_valid=1 AND u.host IN ('jobs.ashbyhq.com','jobs.lever.co','jobs.eu.lever.co') AND u.tenant!='' AND length(u.segment2)=36 AND lower(u.segment2) NOT GLOB '*[^a-f0-9-]*' THEN
 CASE WHEN u.host='jobs.ashbyhq.com' THEN 'ashby' ELSE u.host END||':'||lower(u.tenant)||':'||lower(u.segment2) ELSE '' END AS posting_key,
 CASE WHEN u.url IS NULL THEN NULL WHEN u.url_valid=1 THEN 'https://'||CASE WHEN u.host='boards.greenhouse.io' THEN 'job-boards.greenhouse.io' ELSE u.host END||CASE WHEN length(u.path)>1 AND substr(u.path,-1)='/' THEN substr(u.path,1,length(u.path)-1) ELSE u.path END ELSE NULL END AS canonical_url,
 CASE WHEN typeof(u.company)!='text' OR typeof(u.title)!='text' OR length(u.company)>200 OR length(u.title)>500 OR c.utf16_units>200 OR t.utf16_units>500 OR instr(u.company,char(0))>0 OR instr(u.title,char(0))>0 OR u.company GLOB ('*['||char(1)||'-'||char(31)||']*') OR u.title GLOB ('*['||char(1)||'-'||char(31)||']*') THEN 'invalid_text'
 WHEN c.company_key='' OR t.ascii_key='' THEN 'empty_identity_key' WHEN u.url_valid!=1 THEN 'unsupported_url' ELSE '' END AS invalid_reason
 FROM url_validity u JOIN company_keys c ON c.id=u.id AND c.kind='company' JOIN normalized t ON t.id=u.id AND t.kind='title'
 LEFT JOIN company_keys tenant_key ON tenant_key.id=u.id AND tenant_key.kind='tenant')
SELECT *,CASE WHEN posting_key LIKE 'jobs.lever.co:%' THEN 'lever:'||substr(posting_key,15) WHEN posting_key LIKE 'jobs.eu.lever.co:%' THEN 'lever:'||substr(posting_key,18) ELSE posting_key END AS handoff_posting_key,
 CASE WHEN invalid_reason='' THEN 1 ELSE 0 END AS valid FROM keys`; }

const allRawIdentities = 'SELECT id,user_id,company,title,url FROM guard_identities';
const insertedRawIdentity = allRawIdentities + ' WHERE id=NEW.id';
export const IDENTITY_VIEW_SQL = `CREATE VIEW guard_identity_keys AS ${identitySelectSQL(allRawIdentities)};`;

const keyColumns = ['id','user_id','company_key','history_title_key','role_key','tenant_key','posting_key','canonical_url','invalid_reason','handoff_posting_key','valid'];
const allKeysEqual = keyColumns.map(column => `derived.${column} IS NEW.${column}`).join(' AND ');

// Alternative to IDENTITY_VIEW_SQL. Install after raw table + mapping, in one
// bootstrap transaction. Cached values are derived AND independently verified
// by SQL, never trusted because a caller supplied them. Raw records are also
// immutable: otherwise changing a source row could invalidate the indexed keys.
export const IDENTITY_MATERIALIZED_SQL = `
CREATE TABLE guard_derived_keys(
 id TEXT PRIMARY KEY NOT NULL REFERENCES guard_identities(id),user_id TEXT NOT NULL,
 company_key TEXT NOT NULL,history_title_key TEXT NOT NULL,role_key TEXT NOT NULL,
 tenant_key TEXT NOT NULL,posting_key TEXT NOT NULL,canonical_url TEXT,
 invalid_reason TEXT NOT NULL,handoff_posting_key TEXT NOT NULL,valid INTEGER NOT NULL CHECK(valid IN (0,1))
) WITHOUT ROWID;
CREATE INDEX guard_keys_valid ON guard_derived_keys(user_id,valid);
CREATE INDEX guard_keys_posting ON guard_derived_keys(user_id,posting_key);
CREATE INDEX guard_keys_handoff ON guard_derived_keys(user_id,handoff_posting_key);
CREATE INDEX guard_keys_company_role ON guard_derived_keys(user_id,company_key,role_key);
CREATE INDEX guard_keys_tenant_role ON guard_derived_keys(user_id,tenant_key,role_key);
CREATE INDEX guard_keys_company_history ON guard_derived_keys(user_id,company_key,history_title_key);
CREATE INDEX guard_keys_url ON guard_derived_keys(user_id,canonical_url);
CREATE TRIGGER guard_derived_validate BEFORE INSERT ON guard_derived_keys BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM guard_derived_keys WHERE id=NEW.id) THEN RAISE(ABORT,'immutable_identity_keys') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM (${identitySelectSQL(insertedRawIdentity)}) derived WHERE ${allKeysEqual}) THEN RAISE(ABORT,'invalid_derived_identity_keys') END;
END;
CREATE TRIGGER guard_derived_no_update BEFORE UPDATE ON guard_derived_keys BEGIN SELECT RAISE(ABORT,'immutable_identity_keys'); END;
CREATE TRIGGER guard_derived_no_delete BEFORE DELETE ON guard_derived_keys BEGIN SELECT RAISE(ABORT,'immutable_identity_keys'); END;
CREATE TRIGGER guard_identity_derive AFTER INSERT ON guard_identities BEGIN
 INSERT INTO guard_derived_keys(${keyColumns.join(',')}) SELECT * FROM (${identitySelectSQL(insertedRawIdentity)});
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM guard_derived_keys WHERE id=NEW.id) THEN RAISE(ABORT,'missing_derived_identity_keys') END;
END;
CREATE TRIGGER guard_identity_source_no_replace BEFORE INSERT ON guard_identities
 WHEN EXISTS(SELECT 1 FROM guard_identities WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'immutable_guard_record'); END;
CREATE TRIGGER guard_identity_source_no_update BEFORE UPDATE ON guard_identities BEGIN SELECT RAISE(ABORT,'immutable_guard_record'); END;
CREATE TRIGGER guard_identity_source_no_delete BEFORE DELETE ON guard_identities BEGIN SELECT RAISE(ABORT,'immutable_guard_record'); END;
INSERT INTO guard_derived_keys(${keyColumns.join(',')}) SELECT * FROM (${identitySelectSQL(allRawIdentities)});
CREATE VIEW guard_identity_keys AS SELECT ${keyColumns.join(',')} FROM guard_derived_keys;
`;

export const IDENTITY_SCHEMA_SQL = IDENTITY_TABLE_SQL + IDENTITY_MAPPING_SQL + IDENTITY_VIEW_SQL;
export const IDENTITY_MATERIALIZED_SCHEMA_SQL = IDENTITY_TABLE_SQL + IDENTITY_MAPPING_SQL + IDENTITY_MATERIALIZED_SQL;
