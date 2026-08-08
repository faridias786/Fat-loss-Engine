# Fat-loss engine

Zero-dependency ES modules. Node 20+.

```bash
npm test        # 91 tests, no install needed
```

## See it running

```bash
python3 -m http.server 8000
# then open http://localhost:8000/preview.html
```

`preview.html` is a developer harness, not the product. It imports
`src/index.mjs` unmodified and drives it live, so what you see is real engine
output rather than mock data. Ten preset scenarios down the left each exercise a
different code path — the hard blocks, the clearance gate, the impact filter,
the equipment nudge, the forecast override.

It must be served over HTTP; `fetch()` is blocked on `file://` URLs, and the
page tells you so if you open it directly.

```js
import { buildPlan, setLibrary } from './src/index.mjs';
setLibrary(await (await fetch('./data/exercises.json')).json());
const result = buildPlan(userInput, { week: 1 });
```

In Node, register the library from disk instead:

```js
import { loadLibraryFromDisk } from './src/library-node.mjs';
loadLibraryFromDisk();
```

## Why the engine exists separately from the UI

Every safety decision lives here, not in the front end. A React form that shows
a warning banner is not a safeguard — anyone calling the API directly bypasses
it. So `buildPlan` returns one of four shapes, and the unsafe ones are
structurally incapable of containing a calorie target:

| `status` | `nutrition` | `programme` | Meaning |
|---|---|---|---|
| `invalid_input` | absent | absent | Failed structural validation |
| `refer_clinician` | `null` | `null` | A hard gate tripped |
| `clearance_required` | `null` | `null` | Needs medical sign-off first |
| `ok` / `ok_with_advisories` | present | present | Cleared |

The nutrition and planner modules are called inside branches that are
unreachable when screening blocks them. There is no code path that returns a
deficit to a pregnant user. A test asserts the string `intakeKcal` does not
appear anywhere in a blocked payload.

## Modules

| File | Responsibility |
|---|---|
| `schema.mjs` | Input shape, enums, imperial→metric, structural validation |
| `screening.mjs` | Gates (block / clearance / advisory) and planner restrictions |
| `anthropometry.mjs` | BMI, waist-to-height, waist-to-hip, Navy body fat |
| `energy.mjs` | BMR, TDEE, deficit with floors, macros |
| `timeline.mjs` | Requested-rate feasibility and counter-proposals |
| `forecast.mjs` | Week-by-week simulation and reconciliation |
| `planner.mjs` | Split selection, slot filling, block rotation |
| `library.mjs` | Filtering. Browser-safe — no Node built-ins |
| `library-node.mjs` | Disk loader. Node only |
| `index.mjs` | Orchestration — the safety ordering |

## Three decisions worth knowing about

**TDEE does not use a single activity multiplier.** The usual
`BMR × activity factor` bakes exercise into the multiplier, so adding workout
calories on top double counts them. Here the multiplier covers non-exercise
activity only, and training energy is added explicitly from the generated
programme via MET estimates. The calorie target and the training plan are
therefore consistent with each other, and the number is auditable.

**The forecast is simulated, not projected.** A flat-rate estimate is always
optimistic because BMR falls as bodyweight falls and the same session burns
less as you get lighter. For one test user the naive estimate said 16 weeks and
the simulation said 36. `forecast` is the number to show; `timeline` is kept
only to explain what the user asked for.

**When the intake floor binds, the advice is to move more.** Intake is floored
at `max(1200, BMR)`. When that binds, `nutrition.recommendations` says to add
steps and training days, never to cut further. Without that the user reads
"0.5%/week" and concludes they should eat less — the exact thing the floor
exists to prevent.

## Spot reduction

The engine does not accept a target body part, and no exercise is tagged as
belonging to one. Fat loss is systemic. Per-part measurements are used for
progress tracking and for waist-derived risk ratios only. `MEASUREMENT_PROTOCOL`
carries the tape-measure instructions the numbers are meaningless without.

## Not done yet

- Persistence, auth, consent, deletion — deliberately absent. Storing PCOS
  status and body measurements makes this Article 9 special-category data.
  v1 computes and displays, stores nothing.
- The UI.
- Progression tracking across weeks (the engine is stateless; it generates
  week N on request but does not remember week N−1).
- A real UI. `preview.html` is a harness for you, not a product for users.
- Progressive overload tracking across weeks (the engine generates week N on
  request but does not remember week N-1).
