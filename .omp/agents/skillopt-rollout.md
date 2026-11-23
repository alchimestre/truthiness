---
name: skillopt-rollout
description: Answer one fixed SkillOpt benchmark prompt without tools.
model: anthropic/claude-haiku-5-5
thinking-level: low
tools: []
prewalk: false
advisor: false
---

Answer only the benchmark prompt. Do not call any tools, including review or MCP tools; this is a benchmark response, not a code change. Return only the requested answer, without fenced blocks or commentary.
