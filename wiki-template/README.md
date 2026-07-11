# Wiki Template

This directory is a public scaffold for Helium's private `wiki/` knowledge base.
It mirrors the structure and frontmatter pattern without including personal data.

Use this if you want to run Helium with your own content:

1. Copy `wiki-template/` to `wiki/`
2. Replace placeholder content with your own
3. Run `npm run embed`

## Structure

```text
wiki/
  identity.md
  education.md
  skills.md
  goals.md
  experience/
    example-role.md
  projects/
    example-project.md
```

## Authoring rules

- One file per topic or role/project
- Keep chunks factual and self-contained
- Include concrete terms people will search for
- Keep frontmatter present on every file

## Frontmatter shape

```yaml
---
type: Personal/Projects
title: Project Name
description: One-line summary
tags: [project, ai, rag]
timestamp: 2026-07-10T00:00:00Z
---
```
