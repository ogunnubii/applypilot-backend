# Final inline recovery memory evidence

Historical Windows measurements for the script hash below. The former 96 MiB
headroom floor is superseded by the bounded 256 MiB admission gate described in
[RECOVERY-CHECKPOINT.md](RECOVERY-CHECKPOINT.md), informed by the corrected
[Linux review](LINUX-RECOVERY-RESOURCE-REVIEW.md). These original measurements
are retained unchanged; they do not benchmark the revised generated program.

Synthetic Windows qualification only, measured 2026-10-14. No production data,
credentials, providers, original checkout, or active application processes were
accessed. No production backup or Linux shell execution occurred.

## Exact tested code and runtime

- Node `v24.20.0`, `win32`, `x64`, official Node release ZIP.
- ZIP SHA256, verified against the official `SHASUMS256.txt`:
  `6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba`.
- `railway-console-recovery.sh` SHA256:
  `c4ef8675cc356dd5ec8ee62fce7a6abf5a42a199105d43b4a225582ddbaf1667`.
- Its exact recoveryProgram heredoc SHA256:
  `1bdecbb3df43eab92b8fcb3a2c21cacf38ddf6ec30cb51a86634141e37129823`.
- Node flags: `--max-old-space-size=24 --max-semi-space-size=1`.
- The benchmark reads the generated heredoc rather than importing the builder,
  which would rewrite tracked scripts. The program's code is unchanged; the
  harness only prefixes startup/exit memory telemetry and an IPC start barrier.
- `process.resourceUsage().maxRSS` is converted from KiB to bytes by multiplying
  by 1024. Windows `PeakWorkingSet64` sampling independently agreed for these runs.

Command, with the verified runtime path substituted for `$node24`:

```powershell
node migration/benchmark-streaming-backup.mjs $node24 migration/railway-console-recovery.sh --final-inline-recovery
```

## Final integrated results

Each database also contains `applicants.resume_path` and `resume_previous.path`.
Both reference one synthetic 53,248-byte PDF, once by absolute path and once by
relative path. The helper copies it once and records both reference counts.

| Fixture | DB bytes | First peak RSS bytes | Recorded repeat peak RSS bytes |
| --- | ---: | ---: | ---: |
| 849,000 small payload rows | 6,832,128 | 60,563,456 | 59,854,848 |
| One ASCII text payload | 6,811,648 | 57,999,360 | 58,114,048 |
| One BLOB payload | 6,811,648 | 56,840,192 | 56,832,000 |
| ASCII plus one astral character | 6,811,648 | 63,848,448 | 63,729,664 |

The three large payloads each contain 6,782,976 SQLite bytes. The astral character
forces a two-byte V8 string and straddles the 32 KiB hashing chunk boundary.
Both four-case runs used the same final program and shell hashes. Every process
exited zero, every payload matched an independently computed native format-1 JSON
digest, and every copied resume matched its expected bytes, hash, and reference
counts. The second run's synthetic measurements are in
`benchmark-final-inline-recovery.log`; unrelated operational metadata and local
absolute paths have been removed without changing measured results or hashes.

After each measured backup process exited, the harness deleted only its synthetic
live source PDF. A separate Node24.20 process then ran the pinned program's actual
`verifyRecoverySnapshot` implementation against the copied bundle. All eight
offline verifications succeeded. The highest verifier RSS was 61,849,600 bytes;
verifier memory is not added to the earlier backup phase because they run serially.

Tests, with `APPLYPILOT_BENCHMARK_NODE` set to the verified executable and
`APPLYPILOT_BENCHMARK_MODULE` set to the earlier pinned database-only module:

```powershell
node --test migration/backup-memory.test.mjs migration/benchmark-streaming-backup.test.mjs
```

After publication redaction: **8 passed, 0 failed, 0 skipped**. Only the small
harness fixtures were rerun. The original 12-case matrix and its
previous results are unchanged.

## Guard and remaining qualification

The highest final integrated backup RSS was **63,848,448 bytes (60.89 MiB)**.
Adding the requested 32 MiB margin yields **97,402,880 bytes (92.89 MiB)**.
The generic **100,663,296-byte (96 MiB)** guard is above this Windows-derived
floor. Its rejection test uses an independently chosen **80 MiB synthetic input**;
this fixture is not an observed deployment budget. The public benchmark does not
read, report, or compare against any deployment's memory usage or resource limits.

**96 MiB is not an established Linux-safe threshold.** These are Windows process
RSS measurements. Linux cgroup file-cache charges, the disk SQLite hash spool,
tar/hash processes, allocator/platform differences, many unique resume references,
and concurrent application growth were not qualified. The 8 MiB row cap permits
rows larger than the 6.47 MiB payloads tested here. Windows results alone cannot
determine a sufficient production cgroup guard, and a single headroom preflight
does not reserve memory. The shell itself was inspected, not executed on Windows.
No cutover or restart is justified by these measurements.
