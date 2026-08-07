# Agent memory (not committed)

Persistent / session memory lands here:

```text
agents/sultan/memory/sessions/<sessionId>/
  meta.json
  cards.json
  experiences.json
  iterations.jsonl
  sudan-routes.json
  ...
```

Created automatically while the agent runs. Do not commit session memory — it is run-specific and can be large.
