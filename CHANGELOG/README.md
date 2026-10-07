# CHANGELOG

History is written **at merge time**, never by hand. The org's `tag-on-merge` workflow
(`.github/workflows/tag-on-merge.yml`, dispatching to
`opencharly/.github/.github/workflows/tag-on-merge.yml@main`) reads the merged pull
request's body and writes `CHANGELOG/<CalVer>.md` from it, then tags the merge commit.
That is why every PR body in this repository carries the full `## Summary`,
`## How tested`, `## Rulebook compliance` and `## Change classification` sections: the PR
body *is* the changelog entry, and a thin body becomes a thin release note. Do not add a
release entry here by hand — it will be overwritten, and the merge-time file is the only
record that matches what actually landed.
