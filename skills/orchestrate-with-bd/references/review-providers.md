# Automated review providers

The review-request tool accepts only the providers and modes in this table. The probe reports `observed` only from a provider check, review, review comment, or issue comment. `unknown` means the repository data does not prove whether the integration is installed.

| Provider | Request | Probe identity | In the probe default | Availability rule |
|---|---|---|---|---|
| Codex | `provider=codex`, `mode=review` posts `@codex review` | `chatgpt-codex-connector` | yes | The repository must have Code review enabled. Automatic reviews may remain disabled. |
| CodeRabbit | `provider=coderabbit`, `mode=incremental` posts `@coderabbitai review`; `mode=full` posts `@coderabbitai full review` | `coderabbitai` | yes | Each command consumes the provider's configured review allowance. |
| GitHub Copilot | `provider=copilot`, `mode=review` requests `copilot-pull-request-reviewer[bot]` through GitHub's requested-reviewers endpoint | `copilot-pull-request-reviewer` | yes | Endpoint acceptance proves the reviewer is requestable for that PR. |
| Gemini Code Assist | `provider=gemini`, `mode=review` posts `/gemini review` | `gemini-code-assist` | no | A provider response or review proves observation. |
| Qodo | no request mode | `qodo-merge` or `qodo-merge-pro` | no | Observe only. Current Code Review documentation does not publish a manual trigger. |
| Greptile | `provider=greptile`, `mode=review` posts `@greptileai` | `greptile-apps` | yes | A provider response or review proves observation. |

`orc_bot_review_probe` grades only the slugs in its `bots` list. Without `bots`, it reads `$PR_REVIEW_BOTS`, and without that it uses `DEFAULT_BOTS` from `src/tools/bot-review-probe.ts`: `coderabbitai,chatgpt-codex-connector,copilot-pull-request-reviewer,greptile-apps`. A repository that relies on Gemini or Qodo must pass `bots` naming those slugs, or the round reads `absent` while the availability line still reports them `observed`.

The tool checks the exact PR head before every mutation. Comment requests contain a hidden provider, mode, and head marker. Only a marker authored by the active GitHub identity deduplicates a request after restart. The marker check is not an atomic lock. The shepherd is the only role that calls the request tool, which serializes request calls. Copilot deduplication reads requested reviewers and exact-head reviews.

Use `metadata.bot_review_requests` as a provider-to-mode object, for example `{"codex":"review","coderabbit":"full"}`. An empty object requests no manual reviews. Include a provider only when the originating request, repository policy, or a recorded material-risk decision requires that second opinion. The shepherd alone invokes the request tool.

Unless the provider is already observed, a manual request does not prove availability. The shepherd records `requested` or `already_requested` evidence in its `orc_finish` comment and reads the probe's exact-head marker and provider result. For fifteen minutes from `requestedAt`, treat `pending`, `stale`, or `absent` as a wait: leave the node `in_progress`, comment `review-pending: PROVIDER ISO-TIME`, and return. After fifteen minutes, the lead re-dispatches the waiting bead through `orc_status.waiting`. Missing markers or timestamps remain pending until metadata is repaired.

Provider commands and plan limits can change. Verify an adapter against the provider's official documentation before changing its command:

- Codex: https://developers.openai.com/codex/integrations/github
- CodeRabbit: https://docs.coderabbit.ai/reference/review-commands
- GitHub Copilot: https://docs.github.com/en/copilot/using-github-copilot/code-review/using-copilot-code-review
- Gemini Code Assist: https://docs.cloud.google.com/gemini/docs/code-review/use-code-assist-github
- Greptile: https://www.greptile.com/docs/code-review-bot/trigger-code-review
