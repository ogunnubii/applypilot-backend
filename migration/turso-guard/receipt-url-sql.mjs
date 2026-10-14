// Receipt attribution must not inherit handoff/dedup's broader tracking rules.
// In particular, the native receipt URL policy retains lever-source and
// lever-origin while the handoff identity strips them. Compare an independently
// derived stable query inventory as well as the existing supported base URL.
// Raw URL validity is enforced by guard_identity_keys before this expression.
// Percent-encoded and other unsupported URLs still fail closed upstream.
export function receiptQuerySQL(column) {
 if(!/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(column))throw Error('trusted_receipt_url_column_required');
 return `(WITH RECURSIVE
 raw AS (SELECT CASE WHEN instr(${column},'#')>0 THEN substr(${column},1,instr(${column},'#')-1) ELSE ${column} END AS url),
 query AS (SELECT CASE WHEN instr(url,'?')>0 THEN substr(url,instr(url,'?')+1) ELSE '' END AS q FROM raw),
 parts(remaining,part,ordinal) AS (
  SELECT q||'&','',0 FROM query
  UNION ALL SELECT substr(remaining,instr(remaining,'&')+1),substr(remaining,1,instr(remaining,'&')-1),ordinal+1 FROM parts WHERE remaining!=''
 ),
 keys AS (SELECT *,CASE WHEN instr(part,'=')>0 THEN substr(part,1,instr(part,'=')-1) ELSE part END AS name FROM parts WHERE part!='')
 SELECT json_group_array(part) FROM (SELECT part FROM keys
 WHERE lower(name) NOT LIKE 'utm!_%' ESCAPE '!' AND lower(name) NOT IN ('source','ref','gh_src','step','lang','locale','language')
 ORDER BY name COLLATE BINARY,ordinal))`;
}
