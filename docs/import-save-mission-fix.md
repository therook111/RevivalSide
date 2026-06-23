# Import Save Mission Fix Notes

This is a small code change in a sensitive path. Keep this note with the patch
because `completedMissions`, `officialProgress`, 1624 complete-all, and 1619
mission updates interact in non-obvious ways.

## Why

- `completeAllMissionsForTab` could remove imported `official-join-lobby`
  entries from `completedMissions`.
- Backup/reset comparison showed 59 such entries missing after reset while
  `officialProgress.missionData.dicMissions` was still present.
- Post-claim mission updates selected rows from the beginning of each mission
  group, so the first or older achievement could be chosen before packet
  serialization instead of the achievement stored in `officialProgress`.
- `JOIN_LOBBY_ACK` import coerced explicit `times: 0` to `times: 1`, which could
  make unfinished `targetTimes: 1` achievements get claimed during complete-all
  ACK handling.

## What Changed

- Preserve `official-join-lobby` entries in `completedMissions`.
- Keep `buildMissionDataEntries` unchanged for existing callers.
- Use a separate post-claim builder that starts imported mission groups from the
  `officialProgress` lower bound.
- Preserve explicit `0` progress during official import.

## Validation And Risk

Checked with backup/reset/fix-reset saves that reproduced the issue. This path
depends on real imported save data, so more saves should be tested before broader
use.
