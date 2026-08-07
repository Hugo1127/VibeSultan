# Agent run logs (not committed)

Autoplay / play sessions write here:

```text
agents/sultan/logs/runs/<yyyyMMdd-HHmmss-mmm>/
  events.jsonl
  decision-traces.jsonl
  step-*-reasoning.txt
  summary.json
  ...
```

Created automatically when you run the agent. Do not commit run logs — they grow quickly and may contain prompt/state dumps.
