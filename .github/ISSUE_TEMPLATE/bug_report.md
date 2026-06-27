---
name: Bug report
about: Something doesn't work as documented
title: ''
labels: bug
---

**Describe the bug**
A clear and concise description.

**Reproduction**
1. ...
2. ...

**Expected**
What you expected to happen.

**Actual**
What actually happened. Include a redacted log snippet:

```
journalctl --user -u lark-agent-bridge@$USER --since "10 min ago"
```

**Environment**
- OS: e.g. Ubuntu 22.04
- Node: `node -v`
- lark-cli: `lark-cli --version`
- LLM endpoint + model:
- `lark-cli doctor` output (redacted)
