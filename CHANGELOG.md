# Changelog

## [0.6.1](https://github.com/srobroek/orchestrate-with-bd/compare/v0.6.0...v0.6.1) (2026-09-19)


### Features

* add orc_next so batched workers can pull ready beads ([#225](https://github.com/srobroek/orchestrate-with-bd/issues/225)) ([41fd882](https://github.com/srobroek/orchestrate-with-bd/commit/41fd882af56162686e8fe187cf7645810a7b5726))

## [0.6.0](https://github.com/srobroek/orchestrate-with-bd/compare/v0.5.3...v0.6.0) (2026-09-19)


### ⚠ BREAKING CHANGES

* the ledger is one embedded Dolt database in the canonical checkout. A shared Dolt server is no longer used, and an inherited BEADS_DOLT_SHARED_SERVER carrier is stripped from every ledger child process so it cannot override the store's own dolt_mode.

### Features

* migrate orchestration to embedded Beads and Worktrunk worktrees ([964f125](https://github.com/srobroek/orchestrate-with-bd/commit/964f125d2cc08dd0529f519bc0fd785e58787052))


### Bug Fixes

* pass beads server credential to ledger bd calls ([#222](https://github.com/srobroek/orchestrate-with-bd/issues/222)) ([4562cfa](https://github.com/srobroek/orchestrate-with-bd/commit/4562cfa3240912ad1dc9f259f6877da230cddf3e))

## [0.5.3](https://github.com/srobroek/orchestrate-with-bd/compare/v0.5.2...v0.5.3) (2026-09-18)


### Features

* adopt bd 1.3 primitives with fallback ([#210](https://github.com/srobroek/orchestrate-with-bd/issues/210)) ([f4e1fad](https://github.com/srobroek/orchestrate-with-bd/commit/f4e1fad69fb3ab1f3161a582aae454abed3a6daf))
* gate in-session Beads store migration on a stable bd release ([#201](https://github.com/srobroek/orchestrate-with-bd/issues/201)) ([03e9b2c](https://github.com/srobroek/orchestrate-with-bd/commit/03e9b2c9a1571b301ad8d3649fa3942912801257))


### Bug Fixes

* block bare beads migration paths ([#208](https://github.com/srobroek/orchestrate-with-bd/issues/208)) ([58e0c99](https://github.com/srobroek/orchestrate-with-bd/commit/58e0c993f3da14d00b00ce2fb2de5f2781ac539a))
* **ledger:** release claims with native CAS ([#206](https://github.com/srobroek/orchestrate-with-bd/issues/206)) ([4502ef0](https://github.com/srobroek/orchestrate-with-bd/commit/4502ef09785ac10b791a57504ca45b4761f57bb4))
* probe registered plugin handlers ([#204](https://github.com/srobroek/orchestrate-with-bd/issues/204)) ([12054bf](https://github.com/srobroek/orchestrate-with-bd/commit/12054bfc271567aa86f65ee504b2d35e5f67ffc5))
* **prose:** raise slopvac pin to 2.3.2 ([#211](https://github.com/srobroek/orchestrate-with-bd/issues/211)) ([0ca6580](https://github.com/srobroek/orchestrate-with-bd/commit/0ca6580498dd9bd00de69f8a6c3189ca664b97c4))
* **verdict:** reopen over a departed holder, and restore the phase queue ([#217](https://github.com/srobroek/orchestrate-with-bd/issues/217)) ([e287f1c](https://github.com/srobroek/orchestrate-with-bd/commit/e287f1c9dc8082690bcd7a7714dea5ffb920d673))

## [0.5.2](https://github.com/srobroek/orchestrate-with-bd/compare/v0.5.1...v0.5.2) (2026-09-17)


### Bug Fixes

* **orchestrate-with-bd:** declare npm repository metadata ([a6b1b00](https://github.com/srobroek/orchestrate-with-bd/commit/a6b1b007661bc0acb70b47ced514303fe798f27f))
* **rules:** remove primary checkout gate rule ([#197](https://github.com/srobroek/orchestrate-with-bd/issues/197)) ([6ca5995](https://github.com/srobroek/orchestrate-with-bd/commit/6ca5995bf32816392168325f255a8a5515ee7144))

## [0.5.1](https://github.com/srobroek/orchestrate-with-bd/compare/v0.5.0...v0.5.1) (2026-09-17)


### Bug Fixes

* **agents:** expose ledger tools to implementer tiers ([c85a09d](https://github.com/srobroek/orchestrate-with-bd/commit/c85a09dcee53202bb434b361cf27e68cff118cf4))
* expose ledger tools to implementer tiers ([c5e22d3](https://github.com/srobroek/orchestrate-with-bd/commit/c5e22d3b54d0306b9846f877091d99536f5dc79f))
* **orchestrate-with-bd:** publish package through npm OIDC ([dabde18](https://github.com/srobroek/orchestrate-with-bd/commit/dabde1833e5d003d5d183b17994134b9544d6087))

## [0.5.0](https://github.com/srobroek/orchestrate-with-bd/compare/v0.4.15...v0.5.0) (2026-09-17)


### Features

* **review:** static tiers, held tasks, and the lead's orc_decide ([#183](https://github.com/srobroek/orchestrate-with-bd/issues/183)) ([44b9d98](https://github.com/srobroek/orchestrate-with-bd/commit/44b9d9871a43adc6af9329a568142f944f7ef4a0))


### Miscellaneous Chores

* **release:** prepare 0.5.0 ([#190](https://github.com/srobroek/orchestrate-with-bd/issues/190)) ([b164e7f](https://github.com/srobroek/orchestrate-with-bd/commit/b164e7fad720455d60aaa0f81cdcdffd02bc03dd))

## [0.4.15](https://github.com/srobroek/orchestrate-with-bd/compare/v0.4.14...v0.4.15) (2026-09-16)


### Features

* **orchestrate:** gate full waves, report held beads, and release stale claims by evidence ([#186](https://github.com/srobroek/orchestrate-with-bd/issues/186)) ([0e58add](https://github.com/srobroek/orchestrate-with-bd/commit/0e58add46e509be95a761a401b98a07efe9230fc))


### Bug Fixes

* **orchestrate:** report stale run locator ([#188](https://github.com/srobroek/orchestrate-with-bd/issues/188)) ([07be112](https://github.com/srobroek/orchestrate-with-bd/commit/07be112e2e5f2e1c582f290b8633ddaf17bd9f0f))

## [0.4.14](https://github.com/srobroek/orchestrate-with-bd/compare/v0.4.13...v0.4.14) (2026-09-16)


### Features

* **orchestrate:** enforce recursive work-conserving waves ([#184](https://github.com/srobroek/orchestrate-with-bd/issues/184)) ([326da1d](https://github.com/srobroek/orchestrate-with-bd/commit/326da1d3ca348184461c3f72538587f344a614db))

## [0.4.13](https://github.com/srobroek/orchestrate-with-bd/compare/v0.4.12...v0.4.13) (2026-09-15)


### Features

* **ledger:** orc_bind writes, orc_status reads ([#178](https://github.com/srobroek/orchestrate-with-bd/issues/178)) ([ccac920](https://github.com/srobroek/orchestrate-with-bd/commit/ccac9206e12f9c25b2adb8bd219563a774f8c17b))

## [0.4.12](https://github.com/srobroek/orchestrate-with-bd/compare/v0.4.11...v0.4.12) (2026-09-15)


### Bug Fixes

* **review:** DAG gate admits only the review's own revisions; no fix verdict on a DAG ([#176](https://github.com/srobroek/orchestrate-with-bd/issues/176)) ([1916c4b](https://github.com/srobroek/orchestrate-with-bd/commit/1916c4b596e3ab6aab443d90504f28971a5ed903))

## [0.4.11](https://github.com/srobroek/orchestrate-with-bd/compare/v0.4.10...v0.4.11) (2026-09-15)


### Features

* **review:** graded verdicts, escalation ladder, DAG review ([#174](https://github.com/srobroek/orchestrate-with-bd/issues/174)) ([b73a7e2](https://github.com/srobroek/orchestrate-with-bd/commit/b73a7e2b55b3f21e2ab5984817cbd8d8c53de7e4))

## [0.4.10](https://github.com/srobroek/orchestrate-with-bd/compare/v0.4.9...v0.4.10) (2026-09-14)


### Bug Fixes

* **routing:** never reroute a helper; two-tier wave holds task beads only ([#170](https://github.com/srobroek/orchestrate-with-bd/issues/170)) ([588c4b9](https://github.com/srobroek/orchestrate-with-bd/commit/588c4b9868d3578d7f2f16f7aa6ea602c582c500))

## [0.4.9](https://github.com/srobroek/orchestrate-with-bd/compare/v0.4.8...v0.4.9) (2026-09-14)


### Features

* **reviewer:** security-reviewer helper; workers run their bead's checks; testing reference ([#166](https://github.com/srobroek/orchestrate-with-bd/issues/166)) ([eff7e84](https://github.com/srobroek/orchestrate-with-bd/commit/eff7e84028ab9704682e1258b91e24c38bd7917a))
* **roles:** implementer tiers, built-in model roles, role preflight, dispatch routing ([#168](https://github.com/srobroek/orchestrate-with-bd/issues/168)) ([818140c](https://github.com/srobroek/orchestrate-with-bd/commit/818140c67d88fb209dfd5e9836d957555524d193))

## [0.4.8](https://github.com/srobroek/orchestrate-with-bd/compare/v0.4.7...v0.4.8) (2026-09-14)


### Bug Fixes

* **status:** read the parent from bd show's dependency shape so a clone rebinds to a child epic ([#164](https://github.com/srobroek/orchestrate-with-bd/issues/164)) ([a3fab6a](https://github.com/srobroek/orchestrate-with-bd/commit/a3fab6a861a6de5892732596a11e71821c0cf866))

## [0.4.7](https://github.com/srobroek/orchestrate-with-bd/compare/v0.4.6...v0.4.7) (2026-09-14)


### Bug Fixes

* **status:** a clone rebinds to a child epic of the inherited run; leads keep their integrated tree for capture ([#162](https://github.com/srobroek/orchestrate-with-bd/issues/162)) ([9de167e](https://github.com/srobroek/orchestrate-with-bd/commit/9de167e29abccfaead54534e8c8067f8b629686b))

## [0.4.6](https://github.com/srobroek/orchestrate-with-bd/compare/v0.4.5...v0.4.6) (2026-09-14)


### Bug Fixes

* refuse every bd command, .beads/ write, and dispatch in a session stopped on a non-server store ([#160](https://github.com/srobroek/orchestrate-with-bd/issues/160)) ([2818dd5](https://github.com/srobroek/orchestrate-with-bd/commit/2818dd535dce69c9b762f8bef090e0aef7f83615))

## [0.4.5](https://github.com/srobroek/orchestrate-with-bd/compare/v0.4.4...v0.4.5) (2026-09-14)


### Features

* **status:** binding claims the epic; per-task review default; per-lead concurrency documented ([#158](https://github.com/srobroek/orchestrate-with-bd/issues/158)) ([e694109](https://github.com/srobroek/orchestrate-with-bd/commit/e694109d7e6788d522bca6da443324b416b23053))

## [0.4.4](https://github.com/srobroek/orchestrate-with-bd/compare/v0.4.3...v0.4.4) (2026-09-14)


### Bug Fixes

* **ledger:** fail closed on a truncated walk; final wave holds task beads only ([#155](https://github.com/srobroek/orchestrate-with-bd/issues/155)) ([860632f](https://github.com/srobroek/orchestrate-with-bd/commit/860632f4be0a130628a020b6dcc0ef8339dd6546))

## [0.4.3](https://github.com/srobroek/orchestrate-with-bd/compare/v0.4.2...v0.4.3) (2026-09-14)


### Features

* **status:** cross-epic review wave; epics close only over a terminal subtree ([#153](https://github.com/srobroek/orchestrate-with-bd/issues/153)) ([8ee0012](https://github.com/srobroek/orchestrate-with-bd/commit/8ee0012f94990ec489880dedc45a84eba20aa05a))

## [0.4.2](https://github.com/srobroek/orchestrate-with-bd/compare/v0.4.1...v0.4.2) (2026-09-14)


### Features

* **status:** ready is the wave; leads dispatch and review by wave ([#151](https://github.com/srobroek/orchestrate-with-bd/issues/151)) ([bb9805a](https://github.com/srobroek/orchestrate-with-bd/commit/bb9805aa15d4ebd228d6608db73aa82855a9685b))

## [0.4.1](https://github.com/srobroek/orchestrate-with-bd/compare/v0.4.0...v0.4.1) (2026-09-14)


### Bug Fixes

* **ledger:** record the blocked reason as a comment; header says STOP on a non-server store ([#148](https://github.com/srobroek/orchestrate-with-bd/issues/148)) ([e653bf3](https://github.com/srobroek/orchestrate-with-bd/commit/e653bf347917902528da06add933ddcc0b065154))

## [0.4.0](https://github.com/srobroek/orchestrate-with-bd/compare/v0.3.15...v0.4.0) (2026-09-14)


### ⚠ BREAKING CHANGES

* rewrite as orchestrate-with-bd, a Beads ledger on native OMP orchestration ([#145](https://github.com/srobroek/orchestrate-with-bd/issues/145))

### Features

* **orchestrate:** add exact-head quality adapters ([#139](https://github.com/srobroek/orchestrate-with-bd/issues/139)) ([d21e9f9](https://github.com/srobroek/orchestrate-with-bd/commit/d21e9f9aff42b212918bb517da829003c1f44e43))
* **orchestrate:** close nodes as they land, require acceptance criteria, gate on plan review ([#142](https://github.com/srobroek/orchestrate-with-bd/issues/142)) ([b546853](https://github.com/srobroek/orchestrate-with-bd/commit/b54685338bb228e9216fbec01b78cc8ff796c196))


### Bug Fixes

* **gates:** keep a closed or forgotten claim bound to its exit contract; spell the REVIEW line ([#140](https://github.com/srobroek/orchestrate-with-bd/issues/140)) ([96d560f](https://github.com/srobroek/orchestrate-with-bd/commit/96d560f8640c0f69685a0f410bde503b2a4f556a))
* **run-state:** make the .orchestration tree ignore itself ([#97](https://github.com/srobroek/orchestrate-with-bd/issues/97)) ([56adc55](https://github.com/srobroek/orchestrate-with-bd/commit/56adc55e32563c5766cd3d5c4b99cc69a112cd78))
* **run-state:** read epic and blocked-bead comments at the run's cwd ([#143](https://github.com/srobroek/orchestrate-with-bd/issues/143)) ([3cc710c](https://github.com/srobroek/orchestrate-with-bd/commit/3cc710cf7c68aa854b812b463a2c1de583d5c5f0))


### Code Refactoring

* rewrite as orchestrate-with-bd, a Beads ledger on native OMP orchestration ([#145](https://github.com/srobroek/orchestrate-with-bd/issues/145)) ([5e21fef](https://github.com/srobroek/orchestrate-with-bd/commit/5e21fef69f3d335c8bacc1f364f32e285df7f7d6))

## [0.3.15](https://github.com/srobroek/omp-orchestrate/compare/v0.3.14...v0.3.15) (2026-09-13)


### Features

* replace run/bind/close with start, resume, answer and stop; add an Attention section to status ([#119](https://github.com/srobroek/omp-orchestrate/issues/119)) ([d82b16d](https://github.com/srobroek/omp-orchestrate/commit/d82b16dbae6e71bc7e0db53ceaf0d2da91566b84))
* architect gates and G10 nested-invocation refusal ([#133](https://github.com/srobroek/omp-orchestrate/issues/133)) ([ce3bddb](https://github.com/srobroek/omp-orchestrate/commit/ce3bddb916ac2714b848a23b85fb73a8f6b2bc7a))
* land approved PRs from the lead session's landing sweep ([#116](https://github.com/srobroek/omp-orchestrate/issues/116)) ([64cb28b](https://github.com/srobroek/omp-orchestrate/commit/64cb28b1dc164dd7fcc916ce87f22024a2f557ef))
* lease-based claim recovery and a fenced lead lease ([#117](https://github.com/srobroek/omp-orchestrate/issues/117)) ([5539406](https://github.com/srobroek/omp-orchestrate/commit/553940618c58100d76afa87eea7f4fade88944d0))
* refuse a worker's push to the primary branch and every force push ([#123](https://github.com/srobroek/omp-orchestrate/issues/123)) ([1113e16](https://github.com/srobroek/omp-orchestrate/commit/1113e160f5aea0843fa3a8f92a0ec021aa9bb715))
* role-session claim environment ([#131](https://github.com/srobroek/omp-orchestrate/issues/131)) ([e90da82](https://github.com/srobroek/omp-orchestrate/commit/e90da82dba79ec550f3fd1512601cf9ecfc88f38))
* runtime scripts to Bun, close-out gate in orc_run_status, drop python3 and jq ([#121](https://github.com/srobroek/omp-orchestrate/issues/121)) ([4adb0cb](https://github.com/srobroek/omp-orchestrate/commit/4adb0cbf328951c462a1c050267ea86c9f2b07dc))
* shipped settings overlay, orc_doctor, errors-only prose gate, hardened workflows ([#120](https://github.com/srobroek/omp-orchestrate/issues/120)) ([9674a82](https://github.com/srobroek/omp-orchestrate/commit/9674a82fd978ec826d13e334969c4b674a8db453))
* verify binds, report run health, close runs, and reap each child once ([#104](https://github.com/srobroek/omp-orchestrate/issues/104)) ([1b3409f](https://github.com/srobroek/omp-orchestrate/commit/1b3409f83f1e23a50c05fd4c11f570b72d6a0d34))


### Bug Fixes

* bind claims the host truncated and say so when it cannot ([#101](https://github.com/srobroek/omp-orchestrate/issues/101)) ([e76abbc](https://github.com/srobroek/omp-orchestrate/commit/e76abbc333d6a8bf29ccb39971fb08eaf944c381))
* bind core agent models for marketplace installs; modelRoles.reviewer is required ([#127](https://github.com/srobroek/omp-orchestrate/issues/127)) ([64df1c1](https://github.com/srobroek/omp-orchestrate/commit/64df1c19c44989e48ed9d98f9e784070a9200532))
* close the deferred hardening rows (marker scope, program case, rule scan bounds, path spelling) ([#122](https://github.com/srobroek/omp-orchestrate/issues/122)) ([4d202e7](https://github.com/srobroek/omp-orchestrate/commit/4d202e7702977d89487a852b2e3d868b080740ee))
* close-run walks every level, pin a database before it exists, and document the run bootstrap ([#108](https://github.com/srobroek/omp-orchestrate/issues/108)) ([9ade497](https://github.com/srobroek/omp-orchestrate/commit/9ade497b7c96364267677e4ad25f3fe02808ed59))
* cut per-call bd reads, name bd failures, close two G5 gaps ([#103](https://github.com/srobroek/omp-orchestrate/issues/103)) ([f70d98a](https://github.com/srobroek/omp-orchestrate/commit/f70d98a614d8c684a6f7c4e8d1c584b03be55294))
* every bd write carries the seat's actor and the run's store, and leases renew on the clock ([#126](https://github.com/srobroek/omp-orchestrate/issues/126)) ([b517471](https://github.com/srobroek/omp-orchestrate/commit/b5174715d9a12ac98847a80a0e932869ac1fa52c))
* gates refuse on evidence only; G5 governs capacity, decomposition scope, lead and merged-stderr claims ([#110](https://github.com/srobroek/omp-orchestrate/issues/110)) ([cbbcb8b](https://github.com/srobroek/omp-orchestrate/commit/cbbcb8bef6f06406dac888dd01adbf52382c30d0))
* keep the beads store in one lock domain during a run ([#112](https://github.com/srobroek/omp-orchestrate/issues/112)) ([5daf88f](https://github.com/srobroek/omp-orchestrate/commit/5daf88f774886aed84f4adefb1e4b1e716d7184c))
* lead session plans only, slash commands follow the run scope, store origin on the marker, one doctor row per model role ([#125](https://github.com/srobroek/omp-orchestrate/issues/125)) ([6e70f19](https://github.com/srobroek/omp-orchestrate/commit/6e70f193eecbbc8c8d9d3cce8079595923114009))
* ledger records every bd write and its store, model mismatch warns instead of bricking the worker ([#107](https://github.com/srobroek/omp-orchestrate/issues/107)) ([3e81ac1](https://github.com/srobroek/omp-orchestrate/commit/3e81ac1e034a1d55c9ab1d3ba3b0cc5433b1d16c))
* match TTSR rules against the streamed tool JSON ([#98](https://github.com/srobroek/omp-orchestrate/issues/98)) ([4083c02](https://github.com/srobroek/omp-orchestrate/commit/4083c02154030530e794275cbcbc3d73ef048ead))
* one carrier per fact, a nine-verb grammar, and no formulas ([#111](https://github.com/srobroek/omp-orchestrate/issues/111)) ([8546d0b](https://github.com/srobroek/omp-orchestrate/commit/8546d0b032b8252b394933b23b95a3f2792e6b6a))
* **orchestrate:** read capped claim reports, list lapsed leases only when held, sweep .beads/backup ([#136](https://github.com/srobroek/omp-orchestrate/issues/136)) ([8287c0b](https://github.com/srobroek/omp-orchestrate/commit/8287c0b4d76b3b51cdb9ea7df51d6afbf3f45a2e))
* **orchestrate:** stamp pushed_sha and release claims in the fenced exit write; read a wisp's parent as a linked node ([#137](https://github.com/srobroek/omp-orchestrate/issues/137)) ([626cc0c](https://github.com/srobroek/omp-orchestrate/commit/626cc0ca30e67201df84e9e94231c2785e429d2f))
* plugin cache hygiene ([#128](https://github.com/srobroek/omp-orchestrate/issues/128)) ([199c5a7](https://github.com/srobroek/omp-orchestrate/commit/199c5a759d47e199bbf3cb03987588266324ae7d))
* read redirections, groups and compound commands the way the shell does ([#99](https://github.com/srobroek/omp-orchestrate/issues/99)) ([7019786](https://github.com/srobroek/omp-orchestrate/commit/7019786bf63cfa52bf8429d770aa0ac9a000fed8))
* redirect isolated copies to the run's beads database and drop the pin ([#114](https://github.com/srobroek/omp-orchestrate/issues/114)) ([68a1e22](https://github.com/srobroek/omp-orchestrate/commit/68a1e22822ac80cc4f1e2fba52f1d61280a0939a))
* refuse a second claim per turn, gate implementer spawns, and drop G7 ([#109](https://github.com/srobroek/omp-orchestrate/issues/109)) ([a2d7f65](https://github.com/srobroek/omp-orchestrate/commit/a2d7f6529bf42b3c3b6a42e042835364381e314d))
* refuse opaque scopes, unlanded closes, governance rewrites from roles, and zero-work reports ([#124](https://github.com/srobroek/omp-orchestrate/issues/124)) ([4d49892](https://github.com/srobroek/omp-orchestrate/commit/4d49892f800a413e05f1bc979097c87831245465))
* run-scope the refusing gates, admit the terminal comment after release, recognise the real reclaim ([#102](https://github.com/srobroek/omp-orchestrate/issues/102)) ([ac6b8ed](https://github.com/srobroek/omp-orchestrate/commit/ac6b8ed6fc7441fd65a0d24570c326c02aad3378))
* see the bd command behind env flags and refuse a helper that edits its sandbox ([#106](https://github.com/srobroek/omp-orchestrate/issues/106)) ([4d5bf83](https://github.com/srobroek/omp-orchestrate/commit/4d5bf833f542549472edbf60aa494af5a24fbd61))
* the plugin is dormant outside a run scope ([#115](https://github.com/srobroek/omp-orchestrate/issues/115)) ([07e0199](https://github.com/srobroek/omp-orchestrate/commit/07e0199b1800874ffcce75001f79464e09dd067d))
* **tools:** correct bot-review-probe classification, run-status tree shape and filters, and conflict-probe CI exits ([#100](https://github.com/srobroek/omp-orchestrate/issues/100)) ([cf9f64c](https://github.com/srobroek/omp-orchestrate/commit/cf9f64cc97a84f96f9ad9d3d644475d2f0dcdcf0))


### Performance Improvements

* store-token read cache, batched bd reads, in-process settings ([#113](https://github.com/srobroek/omp-orchestrate/issues/113)) ([dd90531](https://github.com/srobroek/omp-orchestrate/commit/dd905312b0061da9956a348a040195ab071cb4a0))

## [0.3.14](https://github.com/srobroek/omp-orchestrate/compare/v0.3.13...v0.3.14) (2026-09-10)


### Bug Fixes

* **gates:** a Bash revision carries the process pin ([#92](https://github.com/srobroek/omp-orchestrate/issues/92)) ([eb6b919](https://github.com/srobroek/omp-orchestrate/commit/eb6b9193a1afe49e2e82a2a5d8d18ab27d2e94ba))

## [0.3.13](https://github.com/srobroek/omp-orchestrate/compare/v0.3.12...v0.3.13) (2026-09-10)


### Bug Fixes

* **gates:** BEADS_DIR identity check applies only to a bound checkout ([#90](https://github.com/srobroek/omp-orchestrate/issues/90)) ([67bb45e](https://github.com/srobroek/omp-orchestrate/commit/67bb45e31bc2a91abb66fb2943a98b0c7c6b3645))

## [0.3.12](https://github.com/srobroek/omp-orchestrate/compare/v0.3.11...v0.3.12) (2026-09-10)


### Bug Fixes

* bootstrap dependencies before implementation validation ([#87](https://github.com/srobroek/omp-orchestrate/issues/87)) ([225f083](https://github.com/srobroek/omp-orchestrate/commit/225f0836d8878cada6df15d656fc28072ff15493))
* re-prompt the lead when it ends a bound run without a terminal verb ([#89](https://github.com/srobroek/omp-orchestrate/issues/89)) ([a4ce7f3](https://github.com/srobroek/omp-orchestrate/commit/a4ce7f37d94f0f2d18562fff348ee9009ed419bc))

## [0.3.11](https://github.com/srobroek/omp-orchestrate/compare/v0.3.10...v0.3.11) (2026-09-10)


### Bug Fixes

* accept matching runtime BEADS_DIR aliases ([#82](https://github.com/srobroek/omp-orchestrate/issues/82)) ([840ed0a](https://github.com/srobroek/omp-orchestrate/commit/840ed0a25d94ce1b9dbe5be37de4a08eb3afa1df))
* exempt lineage from scope friction and prefix bd writes with the known actor ([#86](https://github.com/srobroek/omp-orchestrate/issues/86)) ([fea578a](https://github.com/srobroek/omp-orchestrate/commit/fea578ae11c165d87f2dd2a2debc1c765a8b3c42))

## [0.3.10](https://github.com/srobroek/omp-orchestrate/compare/v0.3.9...v0.3.10) (2026-09-10)


### Bug Fixes

* **rules:** advise against running roles as nested omp processes ([#83](https://github.com/srobroek/omp-orchestrate/issues/83)) ([e30498a](https://github.com/srobroek/omp-orchestrate/commit/e30498a30d66b8594cd89839182598cd1c9bf645))

## [0.3.9](https://github.com/srobroek/omp-orchestrate/compare/v0.3.8...v0.3.9) (2026-09-10)


### Features

* add bounded manual bot review requests ([#80](https://github.com/srobroek/omp-orchestrate/issues/80)) ([9bc9051](https://github.com/srobroek/omp-orchestrate/commit/9bc90519fa418d24d676b74e0bf56fd732de64b7))

## [0.3.8](https://github.com/srobroek/omp-orchestrate/compare/v0.3.7...v0.3.8) (2026-09-09)


### Bug Fixes

* count completed bot review fixes correctly ([#77](https://github.com/srobroek/omp-orchestrate/issues/77)) ([abc6b7d](https://github.com/srobroek/omp-orchestrate/commit/abc6b7dd6c41afe2a86e58c64fbf9ff2a93832e4))

## [0.3.7](https://github.com/srobroek/omp-orchestrate/compare/v0.3.6...v0.3.7) (2026-09-09)


### Features

* add bounded automated review remediation ([#76](https://github.com/srobroek/omp-orchestrate/issues/76)) ([5273291](https://github.com/srobroek/omp-orchestrate/commit/5273291bda0177902c6d13a586af9ccf82593045))


### Bug Fixes

* allow owned closed claims to reopen ([#74](https://github.com/srobroek/omp-orchestrate/issues/74)) ([2c57696](https://github.com/srobroek/omp-orchestrate/commit/2c5769614054be0fdd17e32d572983b42c1e8063))
* arbitrate actor notices with beads ([#72](https://github.com/srobroek/omp-orchestrate/issues/72)) ([9a290ec](https://github.com/srobroek/omp-orchestrate/commit/9a290ec49710b761eb2765571b67cae06a195202))

## [0.3.6](https://github.com/srobroek/omp-orchestrate/compare/v0.3.5...v0.3.6) (2026-09-09)


### Bug Fixes

* classify grouped bd commands by grammar ([#68](https://github.com/srobroek/omp-orchestrate/issues/68)) ([0485d98](https://github.com/srobroek/omp-orchestrate/commit/0485d9890079fb67b4bf64f5c7ea44d0ce0f6f64))

## [0.3.5](https://github.com/srobroek/omp-orchestrate/compare/v0.3.4...v0.3.5) (2026-09-09)


### Bug Fixes

* classify grouped bd reads before actor warnings ([#69](https://github.com/srobroek/omp-orchestrate/issues/69)) ([b9119d4](https://github.com/srobroek/omp-orchestrate/commit/b9119d4f8b81590450761afccf866ee01f49956b))

## [0.3.4](https://github.com/srobroek/omp-orchestrate/compare/v0.3.3...v0.3.4) (2026-09-09)


### Bug Fixes

* authorize terminal releases and preserve literal setup values ([#65](https://github.com/srobroek/omp-orchestrate/issues/65)) ([3457ee7](https://github.com/srobroek/omp-orchestrate/commit/3457ee7788bad9661ab4d6b3563d4ae4f56788fe))

## [0.3.3](https://github.com/srobroek/omp-orchestrate/compare/v0.3.2...v0.3.3) (2026-09-09)


### Features

* supervise workers and roll architects ([6f2398f](https://github.com/srobroek/omp-orchestrate/commit/6f2398ffdc51a25297b40147d19611aedd306ca3))
* supervise workers and roll architects ([54b8ba6](https://github.com/srobroek/omp-orchestrate/commit/54b8ba65c42352e4d770cc708b5b06453c020234))


### Bug Fixes

* bind architect metadata to returned worktree ([2d088b5](https://github.com/srobroek/omp-orchestrate/commit/2d088b5b58d563ddb0fe8b0822525228130e1912))
* bind recovery supervision to live runs ([f50940c](https://github.com/srobroek/omp-orchestrate/commit/f50940cd019ca5cb616608bba42d95c60df13935))
* bind recovery supervision to live runs ([6b8b08a](https://github.com/srobroek/omp-orchestrate/commit/6b8b08a300246d78a78afa3c41e9c429bc0d6104))
* confine isolated workers to native worktree roots ([6e2dfed](https://github.com/srobroek/omp-orchestrate/commit/6e2dfed6ef4c37024d84e30f772e8bd233f4911d))
* enforce checkout and claim ownership per session ([1bf5300](https://github.com/srobroek/omp-orchestrate/commit/1bf5300877be2e3a9a9015fcfb24842b5222009c))
* enforce core agent assignment contracts ([f06c23d](https://github.com/srobroek/omp-orchestrate/commit/f06c23d573e1b3660a6c3116735f0c0c6383574a))
* enforce core agent assignment contracts ([fb04b7d](https://github.com/srobroek/omp-orchestrate/commit/fb04b7d41947ee4bc2ef2c9a2650750c64cc5ae9))
* enforce fresh ownership and recover spaced worktrees ([73159e7](https://github.com/srobroek/omp-orchestrate/commit/73159e7a794fdb7b0a2370476e214d97b6ad08df))
* follow live session cwd in supervision ([f829399](https://github.com/srobroek/omp-orchestrate/commit/f829399a57e3ed555d45203c56e64737fa151eb6))
* harden assignment recovery checks ([4f4ea3d](https://github.com/srobroek/omp-orchestrate/commit/4f4ea3db1c36a3069f11786d801d543f4c475390))
* resolve run marker from session checkout ([00f8470](https://github.com/srobroek/omp-orchestrate/commit/00f8470a24bf8adae528e9a478a374b42a5bc9ac))
* scope helper readonly mode to active runs ([a0ffa53](https://github.com/srobroek/omp-orchestrate/commit/a0ffa53a41160a666d2e7adc3c77f21a267d6323))
* scope helper readonly mode to active runs ([14351a2](https://github.com/srobroek/omp-orchestrate/commit/14351a293113c3d74068aaf7240a0e3ad56c0618))

## [0.3.2](https://github.com/srobroek/omp-orchestrate/compare/v0.3.1...v0.3.2) (2026-09-09)


### Bug Fixes

* parse textual edit targets through the locked API ([287bce9](https://github.com/srobroek/omp-orchestrate/commit/287bce93ad86c935c4dc4db3aae3a9501ac4106c))
* parse wisp envelopes and resolve edit targets ([76df661](https://github.com/srobroek/omp-orchestrate/commit/76df66148589ed8a03c6523a87a38a6902ec66ab))
* parse wisp envelopes and resolve edit targets ([dbdf9d6](https://github.com/srobroek/omp-orchestrate/commit/dbdf9d6a3ba145ce3bb3a7b47bf68407d96570a5))

## [0.3.1](https://github.com/srobroek/omp-orchestrate/compare/v0.3.0...v0.3.1) (2026-09-09)


### Bug Fixes

* contain activation-hook failures in /orchestrate-run ([#54](https://github.com/srobroek/omp-orchestrate/issues/54)) ([f95e006](https://github.com/srobroek/omp-orchestrate/commit/f95e006dc36b24d4269be3ad20861f578de32503))
* pin beads across linked worktrees ([#55](https://github.com/srobroek/omp-orchestrate/issues/55)) ([600bc5b](https://github.com/srobroek/omp-orchestrate/commit/600bc5b35ca45f7f6b344f572a714c56863c56b0))
* preflight only orchestrated runs, and pin BEADS_DIR instead of asking ([#52](https://github.com/srobroek/omp-orchestrate/issues/52)) ([20ff941](https://github.com/srobroek/omp-orchestrate/commit/20ff9412e72b94348b6bb165bec607770da27033))

## [0.3.0](https://github.com/srobroek/omp-orchestrate/compare/v0.2.4...v0.3.0) (2026-09-08)


### ⚠ BREAKING CHANGES

* Remove orc_resolve_queue_dispatch and release-queue-watch.

### Features

* remove release-queue-watch support ([0e375c7](https://github.com/srobroek/omp-orchestrate/commit/0e375c74a7848eed6592ffb5463246df102fe542))


### Bug Fixes

* check cleared gates before no-work ([33f173a](https://github.com/srobroek/omp-orchestrate/commit/33f173aa7bd99488edc688607426d5e75ff1857d))
* **ci:** execute staged agnix check in pull requests ([9b9b051](https://github.com/srobroek/omp-orchestrate/commit/9b9b0513cdfaa45749d6153717f12cf4c63df27e))
* harden staged agnix follow-up ([4f736dc](https://github.com/srobroek/omp-orchestrate/commit/4f736dc9e7de140dd7e0ceef7124b78d417d77b0))
* normalize common hook paths ([aa92e26](https://github.com/srobroek/omp-orchestrate/commit/aa92e2661e131a429e801be1de94c5f0c6e6a782))
* preserve every existing git hook ([a8b6613](https://github.com/srobroek/omp-orchestrate/commit/a8b66136e7728727a3089666f5417edceceaf815))
* preserve staged agnix diff records ([8bf36c9](https://github.com/srobroek/omp-orchestrate/commit/8bf36c968e5c8dc4bc1d2514102c0f433d8c7191))
* refresh landing gates before claiming ([6749052](https://github.com/srobroek/omp-orchestrate/commit/6749052e83ed91ca968bd1a8c15acc3fba3fb66f))
* reopen gated landing beads safely ([57e2010](https://github.com/srobroek/omp-orchestrate/commit/57e2010097a211fb906a324d885e99d15c051b09))

## [0.2.4](https://github.com/srobroek/omp-orchestrate/compare/v0.2.3...v0.2.4) (2026-09-08)


### Bug Fixes

* clarify reviewer model selection policy ([#48](https://github.com/srobroek/omp-orchestrate/issues/48)) ([ad3fd76](https://github.com/srobroek/omp-orchestrate/commit/ad3fd763d346d3ebbaa3225a0dd4de926fe28ddc))

## [0.2.3](https://github.com/srobroek/omp-orchestrate/compare/v0.2.2...v0.2.3) (2026-09-08)


### Bug Fixes

* **agents:** preflight discovery and document model-aware routing ([#45](https://github.com/srobroek/omp-orchestrate/issues/45)) ([78352d2](https://github.com/srobroek/omp-orchestrate/commit/78352d25b62191592d78db4f81c9ba2e0dcc7f28))

## [0.2.2](https://github.com/srobroek/omp-orchestrate/compare/v0.2.1...v0.2.2) (2026-09-08)


### Bug Fixes

* **ci:** install Vale for complete prose rule coverage ([89b4de1](https://github.com/srobroek/omp-orchestrate/commit/89b4de1581f0bc568a1ac28c9edb01c791f5effe))
* **ci:** repair prose validation and verify actual plugin loading ([6b478a7](https://github.com/srobroek/omp-orchestrate/commit/6b478a7b3365b4a09189bebc700e2d38dd83a837))
* **deps:** update OMP runtime dependencies to 18.1.14 ([941a095](https://github.com/srobroek/omp-orchestrate/commit/941a095ff2e9a534c4b68f8840d809b4fbb2a6f9))
* harden orchestration and reduce workflow overhead ([1161a2f](https://github.com/srobroek/omp-orchestrate/commit/1161a2f692dd41624434b638bd25903fa7ffce4f))
* **orchestrate:** simplify prompts and reconcile safe workflow contracts ([0ec42b8](https://github.com/srobroek/omp-orchestrate/commit/0ec42b8e6ac84e5873fd13768c75c5f3c49a2d8f))
* **report:** preserve child barrier and streamline worker closeout ([3adf60c](https://github.com/srobroek/omp-orchestrate/commit/3adf60c79bebd90b41acf04f0a043fa1f439edc4))
* **runtime:** harden claim authority lifecycle and evidence handling ([4def74c](https://github.com/srobroek/omp-orchestrate/commit/4def74c90fdf0ec683d5786d4b38841d5351ed8b))
* **worktree:** bound reconciliation command parsing ([6f70da2](https://github.com/srobroek/omp-orchestrate/commit/6f70da2e1e902e20fd3185be38ecfc28534d9528))
* **worktree:** enforce claimed tree and scope boundaries ([8b79a22](https://github.com/srobroek/omp-orchestrate/commit/8b79a2284d69657db68e0ff070aac4cf1474f4ce))

## [0.2.1](https://github.com/srobroek/omp-orchestrate/compare/v0.2.0...v0.2.1) (2026-08-26)


### Bug Fixes

* **beads:** track config.yaml so a clone has issue-prefix ([#33](https://github.com/srobroek/omp-orchestrate/issues/33)) ([4bc55fd](https://github.com/srobroek/omp-orchestrate/commit/4bc55fdb74022d38999dca6566e1c359ba39d518))
* **release:** let the release PR branch carry the component, so the tag cuts itself ([#38](https://github.com/srobroek/omp-orchestrate/issues/38)) ([79fc90d](https://github.com/srobroek/omp-orchestrate/commit/79fc90d7a42c492fc33b3ef5801297cd41eb41e3))
* **shell:** only treat command-slot bd as an invocation ([#37](https://github.com/srobroek/omp-orchestrate/issues/37)) ([b091ea3](https://github.com/srobroek/omp-orchestrate/commit/b091ea304a5ae5aca50184a1245fa27dfbd5bb2d))
* write load-oracle marker after factory registrations ([#40](https://github.com/srobroek/omp-orchestrate/issues/40)) ([969fe30](https://github.com/srobroek/omp-orchestrate/commit/969fe30893088cce08ebbd1cfedd92dbd5bb96d7))

## [0.2.0](https://github.com/srobroek/omp-orchestrate/compare/v0.1.4...v0.2.0) (2026-08-26)


### ⚠ BREAKING CHANGES

* **beads:** go back to embedded, and pin one path instead of running a server ([#27](https://github.com/srobroek/omp-orchestrate/issues/27))

### Features

* **beads:** the run owns the dolt server, and a slow bd stops blocking every call ([#26](https://github.com/srobroek/omp-orchestrate/issues/26)) ([6d33880](https://github.com/srobroek/omp-orchestrate/commit/6d33880ae9b8d4729102aa34d814e163fb668103))
* **marketplace:** publish a catalog so this repo installs from its own remote ([#29](https://github.com/srobroek/omp-orchestrate/issues/29)) ([c8aee4c](https://github.com/srobroek/omp-orchestrate/commit/c8aee4c2cb71fdb3f46990ac8ecef0350d5fc502))


### Bug Fixes

* **docs:** stop the README owning a version nothing bumps ([#30](https://github.com/srobroek/omp-orchestrate/issues/30)) ([a1e585e](https://github.com/srobroek/omp-orchestrate/commit/a1e585e71b821a77215dd43122c3fae9b235b3a8))


### Code Refactoring

* **beads:** go back to embedded, and pin one path instead of running a server ([#27](https://github.com/srobroek/omp-orchestrate/issues/27)) ([60fb879](https://github.com/srobroek/omp-orchestrate/commit/60fb87986dd0a2f8f34e9ac114731bb653760ee0))

## [0.1.4](https://github.com/srobroek/omp-orchestrate/compare/v0.1.3...v0.1.4) (2026-08-26)


### Bug Fixes

* **beads:** drop the worktree guard, because bd already resolves the primary ([#25](https://github.com/srobroek/omp-orchestrate/issues/25)) ([a8bbbfe](https://github.com/srobroek/omp-orchestrate/commit/a8bbbfec80e8834985e2e959d27fe04846850d1a))

## [0.1.3](https://github.com/srobroek/omp-orchestrate/compare/v0.1.2...v0.1.3) (2026-08-26)


### Bug Fixes

* **beads:** stop a worktree minting its own empty database, and sync the database ([#23](https://github.com/srobroek/omp-orchestrate/issues/23)) ([4918b88](https://github.com/srobroek/omp-orchestrate/commit/4918b88f6cfa92bf3e983ca2a1b03d503ed2a63e))
* **release:** put the version in the release PR title so the tag can be cut ([#21](https://github.com/srobroek/omp-orchestrate/issues/21)) ([13c6b66](https://github.com/srobroek/omp-orchestrate/commit/13c6b665516a3d8d2e6bfa436b8d51878a3d8d96))

## [0.1.2](https://github.com/srobroek/omp-orchestrate/compare/v0.1.1...v0.1.2) (2026-08-26)


### Features

* **contract:** pin every worker's bd calls at the run repository ([fc0db83](https://github.com/srobroek/omp-orchestrate/commit/fc0db833cdf467eb4d6c6126b636314067714f6a))
* **orchestrate:** route the incidental bug a worker runs into ([f997815](https://github.com/srobroek/omp-orchestrate/commit/f99781551ed6f5bdf04a340afc3f62c760b18268))
* **orchestrate:** route the incidental bug a worker runs into ([40d5300](https://github.com/srobroek/omp-orchestrate/commit/40d5300096658f88cd3155e3ab3af2fd9b92ea4f))
* role routing on metadata, parser-backed bd gates, ensured prerequisites ([#14](https://github.com/srobroek/omp-orchestrate/issues/14)) ([c681218](https://github.com/srobroek/omp-orchestrate/commit/c6812183f721aec42f22c211ed093bb2455ff84f))
* **rules:** remind an agent when a bd call is not pinned to the run ([c291246](https://github.com/srobroek/omp-orchestrate/commit/c2912466c17614d0a8a001651b194ee216e59a38))
* **run:** require a server-mode beads database to activate a run ([#17](https://github.com/srobroek/omp-orchestrate/issues/17)) ([2723713](https://github.com/srobroek/omp-orchestrate/commit/2723713d81b34ac887f2878f02883bc2f8c670be))


### Bug Fixes

* **agents:** restore the designer grant the prose already promised ([#18](https://github.com/srobroek/omp-orchestrate/issues/18)) ([5f8205f](https://github.com/srobroek/omp-orchestrate/commit/5f8205fe03aa8ed2eb81fcab93f9bb24550c1255))
* close a claim-gate denial of service and six authority bypasses ([2f02e93](https://github.com/srobroek/omp-orchestrate/commit/2f02e93fa4141822a11c5b2f7286566974e62dcb))
* close a claim-gate denial of service and six authority bypasses ([cab9ba5](https://github.com/srobroek/omp-orchestrate/commit/cab9ba5a2937c69e50137ffdff42e0d0b2e845d3))
* **gates:** record the claim from its report, not from the command ([#20](https://github.com/srobroek/omp-orchestrate/issues/20)) ([7e47038](https://github.com/srobroek/omp-orchestrate/commit/7e4703826c3a88da3bf1a6c64c98c013702bf9a3))
* **gates:** replace the bd actor-prefix rule with a tokeniser gate ([a5b686e](https://github.com/srobroek/omp-orchestrate/commit/a5b686e8225078f6efcd48978fafb04e42e970ad))
* **gates:** replace the comment-verb rule with a tokeniser gate ([7f4c038](https://github.com/srobroek/omp-orchestrate/commit/7f4c038776083fc6f574ded7854e303e6d0a1b72))
* **gates:** replace the one-claim rule with a tokeniser gate ([e1767fa](https://github.com/srobroek/omp-orchestrate/commit/e1767fa1ace72e8e5a511ea1790c7c18dca480a8))
* **gates:** supply the bd pin instead of refusing an unpinned call ([0410cf4](https://github.com/srobroek/omp-orchestrate/commit/0410cf4724e3583d48c90ab4394d859b2d711359))
* parse bd commands instead of matching text, and supply the pin ([adf295f](https://github.com/srobroek/omp-orchestrate/commit/adf295fc2717561dcf4b45ad259d103cf0d7e83f))
* **run-state:** reset the read budget before arming the patrol ([0ec4e76](https://github.com/srobroek/omp-orchestrate/commit/0ec4e76e5a5014be404ae5840a02b02146014856))
* **watchers:** do not warn about beads in a repository that has none ([8471ca8](https://github.com/srobroek/omp-orchestrate/commit/8471ca8408187023aef2f8a7e1f19e39670bcd90))
* **watchers:** read both carriers bd uses for server mode ([c1c3fa5](https://github.com/srobroek/omp-orchestrate/commit/c1c3fa594e7ef1d1ca0ec10476c173671261688d))

## [0.1.1](https://github.com/srobroek/omp-orchestrate/compare/v0.1.0...v0.1.1) (2026-08-25)


### Features

* beads-backed multi-agent orchestration for OMP ([b27ab47](https://github.com/srobroek/omp-orchestrate/commit/b27ab47f54d0a56185e30064a1388b1c8af3b427))


### Bug Fixes

* hardening from end-to-end and adversarial verification ([83f4011](https://github.com/srobroek/omp-orchestrate/commit/83f4011333249e8bce909aa92723fc7fa481b07c))
* **watchers:** treat an unreadable isolation mode as unknown ([67a4af1](https://github.com/srobroek/omp-orchestrate/commit/67a4af18f0d2a3dcc81ea2b855470c8756686040))
