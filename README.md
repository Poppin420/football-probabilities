# Football Probabilities

Free, mobile-first web page with model-based probabilities for the upcoming matches of the big European
leagues and the Champions League: 1X2, goals over/under, both teams to score, correct score, half-time and
half-time/full-time, corners, cards and anytime scorers. Statistical estimates, not betting advice.
No bookmaker odds are used anywhere.

**Εγκατάσταση βήμα-βήμα (στα ελληνικά): [SETUP.md](SETUP.md)**

## How it works

- `public/` is a static site (no build step), served by Netlify.
- All computation runs in GitHub Actions (`.github/workflows/`) and is published as JSON to the branch
  `data`, as one fresh orphan commit per run. Nothing generated is ever committed to `main`.
- The page reads `https://raw.githubusercontent.com/OWNER/REPO/data/<file>.json`
  (`OWNER` and `REPO` are set in `public/config.js`).
- If a source fails, the last good JSON is kept and marked stale. A fixture whose team names cannot be
  matched is skipped and listed under `warnings` in `index.json`.
- Two workflows write the branch `data` and share one concurrency group:
  - **Ανανέωση δεδομένων** (twice a day): fixtures, model fits, `<LEAGUE>.json`, `index.json`, `ai-cache.json`.
  - **Εβδομαδιαίος έλεγχος αξιοπιστίας** (Mondays): rolling back-test, parameter tuning, `tune.json`
    (read by the daily refresh) and `report.json` (the tab "Αξιοπιστία"). It fails (red) when a league
    beats the league base rates by less than 8 % in RPS, but the report is still published.
- Secrets (GitHub Actions secrets only, never logged): `FOOTBALL_DATA_TOKEN` (required), `GROQ_API_KEY` and
  `API_FOOTBALL_KEY` (both optional).

## The model

- Goals: Dixon-Coles type Poisson model with ridge shrinkage and exponential time weights; promoted
  teams get an offset. Phase 2 adds an xG proxy from shots (non-negative least squares), an Elo prior
  (ridge regression on Elo ratings for teams with enough matches) and a Bayesian bootstrap (K = 100)
  that gives the 10 %–90 % ranges shown next to the probabilities.
- Corners and yellow cards: negative-binomial regression (the over-dispersion is estimated from the data and
  vanishes into a plain Poisson when there is none); the weekly back-test scores it against plain Poisson.
  Phase 3 multiplies both yellow-card means by a shrunk referee factor `f = (S + 10 c) / ((n + 10) c)`
  (`S` = cards shown in the `n` matches of that referee in the history, `c` = the league's mean cards per match;
  used only when `n >= 5`).
- Scorers: empirical-Bayes Gamma prior on scoring rates (no line-ups). With the optional API-Football key,
  players who will miss the match get a rate of 0 ("Missing Fixture"); "Questionable" players only get a tag.
- Half-time (Phase 3): the first-half goals are a binomial thinning of the full-time goals with a fixed
  per-league half share `s` (estimated on >= 200 matches with a half-time score, bounded to 0.30-0.60).
  The nine HT/FT probabilities and first-half over/under follow from the score matrix; the weekly back-test scores
  them against base rates. Reversals (1/2, 2/1) are slightly underestimated by construction.
- Champions League (Phase 3): an **Elo-only** model, because the clubs have no common domestic history:

  ```
  lam = exp(c + eta + kappa * dE / 800)     mu = exp(c - kappa * dE / 800)     dE = Elo_home - Elo_away
  ```

  `kappa`, `eta` and a first `c` come from one pooled weighted Poisson regression over the domestic matches of all
  leagues (monthly Elo snapshots, at most 62 days old; `kappa` must lie in [0.2, 2.0]); `c` is then blended with the
  intercept fitted on the cup's own finished matches of the last two seasons, which gets the weight `W / (W + 100)`
  (`W` = sum of the time weights of those matches). The final is played on neutral ground (`eta = 0`). Goals markets, half-time markets and scorers use the same code as the leagues; there are no corners,
  no cards and no bootstrap ranges, and every match carries the flag `eloOnly` ("χαμηλότερη βεβαιότητα" in the UI).
  The cup cannot be back-tested on its own matches, so the weekly job tests the same formula on the domestic matches
  (rolling weekly origins, each fitted only on earlier matches) against pooled base rates and against the league
  model on the same matches. A negative skill is a warning, not a failure.
- An optional calibration layer is applied only if it improves the nested out-of-sample log-loss.
- The maths uses no language model. Groq only phrases a short Greek comment from numbers the model
  has already computed (`prompts/ai-comment.system.txt`); a reply containing a number that is not in
  its input is discarded and a deterministic Greek template is used instead.

## Own Elo (since Phase 3.1)

api.clubelo.com stopped answering in autumn 2026, so the Elo ratings are computed from the results (`src/model/ownElo.js`,
`src/pipeline/ownEloData.js`). The classic football Elo:

```
We = 1 / (1 + 10^(-(R_home - R_away + H) / 400))        H = 100 (0 on neutral ground: the Champions League final)
R' = R + K * G * (W - We)                                K = 20, W = 1 / 0.5 / 0, start 1500
G  = 1 (goal difference <= 1), 1.5 (2), (11 + N) / 8 (N >= 3)
```

- One chronological series of the 90-minute results of the last 5 completed seasons + the current one of every league
  with a football-data.co.uk file and a club in Europe (the 8 modelled leagues plus B1, T1, G1, SC0), and of every finished
  Champions League match that football-data.org gives for free. Countries are linked only through the Champions League matches.
- A club without earlier history starts at (mean of its league) - 100, a club that only plays in the Champions League at
  (mean of all clubs) - 100; the first clubs of a league series start at 1500.
- Monthly snapshots (1st of the month, matches strictly before) replace the ClubElo monthly downloads in the weekly tuning
  and in the pooled regression of the Champions League. A Champions League club with fewer than 6 matches in the history is skipped
  (warning `thin-history`).
- The models use ONE source (`ELO_SOURCE`: empty/`own` = our Elo, `clubelo` = the downloaded ratings, repository variable).
  When ClubElo answers, the daily run reports a cross-check (correlation and mean difference on the common clubs, `index.json` →
  `elo.check`) and the weekly run repeats the Elo-only proxy back-test with ClubElo's ratings (`report.json` → `eloOnly.alt`),
  with a non-fatal warning `clubelo-better` if they are clearly better.

### Second tiers and the lab (Phase 3.2)

`LEAGUES` also lists League One (E2), 2. Bundesliga (D2), Serie B (I2), La Liga 2 (SP2) and Ligue 2 (F2) with `tier: 2`.
They are only results: they join the own-Elo history when the repository variable `ELO_TIERS` is `on` (default off; no formula
changes, so that promoted clubs enter with a real rating). `scripts/lab-elo.mjs` (workflow `lab.yml`, manual, read-only, publishes
nothing) back-tests the Championship without Elo, with our Elo and with our Elo + tiers, splits the matches into those with
a newly promoted club and the rest, counts the promoted clubs that have a rating on matchday 1, and prints an in-sample ceiling.

### Europa League (Phase 3.3)

`EL` is a second Elo-only competition (`optional: true`, `source: 'rapid'`). football-data.org's free plan does not have it and
the API-Football free key cannot see the current season, so `src/sources/rapidEuropa.js` reads the RapidAPI listing
"UEFA Europa League" (free plan: 500 calls a month, secret `RAPIDAPI_KEY`; no retries, no 429 waiting). Fixtures: one call per
refresh; results: cached (20 h this season, 30 days last season). Knockout-round scores are not used (one score only). Without the
key, or when the source fails, the run logs it, adds the warning `optional-unavailable` and publishes no tab (a previously published
`EL.json` is kept stale). `scripts/check-sources.mjs` probes it (2 calls). Its finished matches also feed our own Elo.

## API-Football (optional extras)

Only referees and injuries, never probabilities. Header `x-apisports-key`; the API answers HTTP 200 even on errors,
so the body (`errors`, `results`) is inspected. If the plan does not give the current season, the extras are switched
off and the reason is printed by `check-sources` and written to `index.json`. Budget: at most 40 requests per UTC day
and 18 per run (the free plan allows 100), at least 20 left, 6.5 s between requests; injuries are requested only for
matches within 72 hours, and the previous run's extras are reused for up to 30 hours.

## Layout

| Path | Content |
|---|---|
| `public/` | the web page (vanilla ES modules, no dependencies): matches view and reliability view |
| `src/model/` | goals model, xG proxy, Elo prior, Elo-only model, half-time markets, bootstrap, calibration, corners / cards, scorers, markets, back-test and metrics |
| `src/sources/` | football-data.org, football-data.co.uk (CSV), ClubElo (optional cross-check), API-Football, Groq, team-name aliases and matching |
| `src/pipeline/` | per-league pipeline, Champions League pipeline, daily refresh, weekly tuning (+ Elo-only proxy back-test), API-Football extras, Elo snapshots, own-Elo data (`ownEloData.js`), tune.json handling, Greek comment step, cache |
| `scripts/` | `refresh`, `tune`, `check-sources`, `build-aliases`, `data-branch` (fetch / publish), `job-summary` |
| `prompts/` | the system prompt of the Greek comment |
| `tests/` | `node --test` suites (maths, sources, pipeline, scripts, UI) |
| `aliases.builtin.json` | the shipped team-name aliases; replaced on every upgrade, do not edit |
| `aliases.json` | your own team-name aliases, editable in the browser; never overwritten by an upgrade |

## Commands (Node.js 20 or newer)

```bash
npm install     # only needed for the UI tests (jsdom)
npm test        # all tests (2-4 minutes)
npm run check   # live check of every data source (needs FOOTBALL_DATA_TOKEN)
npm run refresh # writes data-out/ (needs FOOTBALL_DATA_TOKEN, publishes nothing)
npm run tune    # weekly back-test: writes data-out/report.json and tune.json (publishes nothing)
```

Optional environment variables: `GROQ_API_KEY` (Greek comments), `GROQ_MODEL` (default
`openai/gpt-oss-120b`, fallback `openai/gpt-oss-20b`), `API_FOOTBALL_KEY` (referees, absences),
`FP_ONLY=PL,BL1,CL` (limit the leagues), `PREV_DIR` / `OUT_DIR` (default `data-prev` / `data-out`).

## Data sources and credits

- Fixtures and top scorers (including the Champions League): Football data provided by the [Football-Data.org](https://www.football-data.org/) API.
- Historical results, shots, corners, cards, half-time scores and referees: [football-data.co.uk](https://www.football-data.co.uk/) (bookmaker odds columns are ignored).
- Elo ratings: computed by the project itself from the match results (no external rating source). [clubelo.com](http://clubelo.com/) is used only for an optional comparison, and is credited in the footer when it is used.
- Referees and absences (optional): [API-Football](https://www.api-football.com/).
- Greek comment text (optional): [Groq](https://groq.com/) API, phrasing only.

## Κόρνερ και κάρτες στις ευρωπαϊκές διοργανώσεις

Στο Champions League και στο Europa League τα κόρνερ και οι κάρτες υπολογίζονται από τα **εγχώρια** μοντέλα κάθε ομάδας (`src/model/euroCounts.js`): επίπεδο και έδρα ως μέσος όρος των δύο πρωταθλημάτων, επίθεση/άμυνα από το δικό του πρωτάθλημα κάθε συλλόγου, κόκκινες από τον μέσο ρυθμό των δύο πρωταθλημάτων επί τον συντελεστή της κάθε ομάδας. Στον τελικό δεν υπάρχει έδρα. Σημαίνονται ως «εκτίμηση»: δεν ελέγχονται σε ευρωπαϊκούς αγώνες, δεν υπολογίζεται η διαφορά επιπέδου μεταξύ πρωταθλημάτων και ο διαιτητής δεν μετράει. Αν μια ομάδα δεν ανήκει σε πρωτάθλημα που καλύπτουμε (ή έχει λίγους αγώνες), η καρτέλα εξηγεί ότι δεν υπάρχουν στοιχεία.

## Αποτελέσματα άλλων χωρών στο δικό μας Elo (Europa League)

Εκτός από τα πρωταθλήματα που ήδη διαβάζουμε, το δικό μας Elo παίρνει και τα **αποτελέσματα** της Αυστρίας, Δανίας, Ελβετίας, Νορβηγίας και Πολωνίας από το football-data.co.uk (αρχεία `new/AUT.csv` κ.λπ., ένα ανά χώρα). Έτσι οι ομάδες τους έχουν βαθμολογία στους αγώνες του Europa League αντί να παραλείπονται. Διαβάζονται οι στήλες Date, Home, Away, HG, AG (με το όνομά τους, όχι με θέση) και οι αποδόσεις αγνοούνται. Ένα αρχείο που λείπει ή αλλάζει μορφή δίνει μόνο προειδοποίηση. Δεν αλλάζει κανένας τύπος: μόνο περισσότερα αποτελέσματα μπαίνουν στον ίδιο υπολογισμό Elo.
