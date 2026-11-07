# Branch "data"

This branch is generated automatically by the GitHub Actions workflow
"Ανανέωση δεδομένων". Do not edit it by hand: every run replaces the whole
branch with one fresh commit.

The web page reads `index.json` and one `<LEAGUE>.json` file per league from here,
and `report.json` for the tab "Αξιοπιστία".
`tune.json` (parameters chosen by the weekly back-test) and `ai-cache.json`
(Greek comments already written) are used by the next run.
The `cache/` folder holds compressed copies of downloaded source data so that
the next run does not have to download everything again.
