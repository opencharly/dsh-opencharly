# dsh-opencharly

OpenCharly's native **DeepSeek Harness** plugin — the git gates, `SOUL.md` injection, and the
session-start watch auto-arm that a DSH session cannot wire from repository config alone.

A DSH plugin is a host-profile dependency, not a repo file: `AGENTS.md` Part II rule 5 keeps harness
*config* at the umbrella root, while the plugin is installed into `$DSH_HOME` and pinned by commit
from this repository, exactly as `dsh-github`, `dsh-git-worktree` and `dsh-workspace-enhancement`
are today.

The plugin itself lands by pull request; see the PR history and `CHANGELOG/` for its introduction.
