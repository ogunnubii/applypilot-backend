# Independent Linux recovery resource review

The independent Linux reviewer tested the unchanged inline Node program from
recovery commit `128bd7616a97a50a69bc36232f4904df4904ee25`. Its script SHA-256 was
`c4ef8675cc356dd5ec8ee62fce7a6abf5a42a199105d43b4a225582ddbaf1667`; its inline Node
program SHA-256 was
`1bdecbb3df43eab92b8fcb3a2c21cacf38ddf6ec30cb51a86634141e37129823`.

The reviewer reported **16 successful synthetic runs**, including dense small rows
and near-8 MiB large text/binary payloads with 52 KiB of referenced resumes. The
final measurement used a small Python launcher after fixture generation exited,
avoiding inherited high-water measurements from a larger fixture-generation parent.

| Final reported measure | Value |
| --- | ---: |
| Worst Node peak RSS | 91,824,128 bytes / 87.570 MiB |
| Largest dense-row hash spool allocation | 83.094 MiB |
| Largest snapshot plus hash-spool allocation | 91.125 MiB |

Only these corrected figures are used for the resource revision. These are
independently reported Linux results, not Windows measurements rerun by this task.
The raw reviewer transcript is not embedded in this repository.

The earlier 96 MiB headroom floor is inadequate. Disk-backed SQLite hashing can
charge file cache to a cgroup; process RSS alone omits that cost. The revised
**256 MiB minimum free cgroup headroom** is a conservative operator admission
budget for the bounded inputs, including workload/cache margin. It is not an
experimentally proven cgroup hard limit, reserved capacity or guarantee against
concurrent workload growth. The script also requires **256 MiB available disk**
before Node and before archive creation, with additional in-process checks.

The revised code separately rejects database images over 8 MiB, unique referenced
resume bytes over 52 KiB, excessive row/schema/reference metadata and hash spools
over the fixed cap. Those additional admission limits constrain untested shapes;
they do not claim that every permitted combination was benchmarked. Source growth,
failed resource probes and out-of-space writes must leave an incomplete result.

The revised generated program needs its own regression checks and independent
POSIX/cgroup qualification. Correctness of the 16 previous inline runs does not
establish measurements for modified code or a live deployment. No production
resource usage, credential-bearing state, resource change or backup execution is
part of this report.
