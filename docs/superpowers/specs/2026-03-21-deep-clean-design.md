# Deep Clean Skill — Design Spec

## Overview

A periodic, comprehensive codebase health audit skill that combines automated tooling with parallel agent-driven review across 5 domains. Produces a structured findings report organized by category and severity, committed as a historical artifact.

**Trigger:** On demand, typically post-milestone after a batch of changes.

**Scope:** Full codebase, every invocation.

**Output:** Markdown report at `docs/audits/YYYY-MM-DD-deep-clean.md`, committed to git after findings are discussed and resolved.

## Workflow

```
1. Run automated tools (typecheck, lint, knip, tests)
2. If tools fail → fix before proceeding (don't audit a broken build)
3. Dispatch 5 parallel review agents with:
   - Full codebase access
   - Domain-specific review checklist
   - Automated tool output as context
4. Collect and merge findings from all agents
5. Deduplicate and organize into structured report
6. Present findings to user by category with severity levels
7. Discuss and triage with user
8. After fixes are made, write final report to docs/audits/
9. Commit report
```

### Step Details

**Step 1–2: Automated Baseline**

Run the project's existing quality gate (`pnpm precommit` or equivalent: typecheck, lint, knip, test). If any tool fails, surface the failure and stop — the codebase should pass automated checks before deeper review begins. This establishes a clean baseline and avoids agents reporting issues the tools would catch.

**Step 3: Parallel Agent Dispatch**

Five agents run concurrently, each focused on a single audit domain. Each agent receives:
- The automated tool output (so it doesn't duplicate those findings)
- Its domain-specific checklist (see Audit Domains below)
- Instructions to read broadly across the codebase, not just spot-check
- The severity classification rubric

Each agent returns a structured list of findings with file locations, descriptions, and severity.

**Step 4–6: Report Assembly**

The orchestrating session collects all agent findings, deduplicates (e.g., if both Architecture and Code Quality flag the same oversized file), and assembles them into the report format. Findings are presented to the user in conversation, category by category.

**Step 7: Triage**

The user reviews findings and decides which to address. Discussion may reclassify severity, dismiss false positives, or identify findings that need more investigation.

**Step 8–9: Resolution and Commit**

After the user addresses findings (in the same session or later), the report is updated with a "Resolved" section documenting what was fixed, then committed to git.

## Audit Domains

### 1. Architecture & Design

Review the codebase for structural coherence and consistency.

**Checklist:**
- Module boundary violations (e.g., `app/` importing directly from `build/`, hooks reaching into `db/`)
- Inconsistent patterns across similar code (e.g., API routes with different error handling conventions)
- Dependency direction problems (core depending on app, circular imports)
- Files that have grown too large or have too many responsibilities
- Abstractions that don't pay for themselves (wrappers that just pass through, premature generalization)
- Inconsistent naming conventions across modules
- Data flow patterns that are unclear or overly indirect

### 2. Security

Review system boundaries for vulnerabilities and data exposure risks.

**Checklist:**
- Input validation gaps at API route boundaries (query params, request bodies)
- SQL injection risks (string interpolation in queries, unsanitized input reaching the database)
- XSS risks (unescaped user content rendered in HTML)
- Command injection risks (user input reaching shell commands)
- Sensitive data exposure (secrets in code, overly verbose API responses, env vars logged)
- Auth/authz gaps (routes missing access checks, privilege escalation paths)
- CORS and header configuration
- Dependency vulnerabilities (outdated packages with known CVEs)

### 3. Performance

Review for inefficiencies in hot paths and resource usage.

**Checklist:**
- N+1 query patterns in database access layers
- Unnecessary re-renders in React components (missing memoization in expensive renders, unstable references in props)
- Expensive operations in request handlers or render loops (synchronous computation, redundant data transformations)
- Missing caching where repeated identical work occurs
- Bundle size concerns (large imports pulled client-side, tree-shaking blockers)
- Database query efficiency (missing indexes for common query patterns, fetching more data than needed)
- Memory leaks (uncleaned intervals/listeners, growing data structures)

### 4. Code Quality

Review for maintainability, clarity, and hygiene beyond what linters catch.

**Checklist:**
- Dead code that static analysis misses (unreachable branches, feature flags that are always on/off, unused function parameters beyond `_` convention)
- Duplication that should be extracted (similar logic in multiple places, copy-pasted with minor variations)
- Overly complex functions (deep nesting, long parameter lists, mixed abstraction levels, functions doing multiple unrelated things)
- Naming inconsistencies (same concept called different things in different places)
- Comments that are wrong, stale, or redundant with the code
- Magic numbers and strings that should be named constants
- Error handling that swallows information or is inconsistent

### 5. Test Quality

Review tests for meaningful coverage and correctness.

**Checklist:**
- Tests that pass but don't assert anything meaningful (empty test bodies, assertions that are always true, checking only that no error is thrown when behavior should be verified)
- Critical code paths with no test coverage (complex business logic, error handling branches, edge cases documented in comments but not tested)
- Mocks that diverge from production behavior (mocked interfaces that don't match real implementations, stale mock data)
- Tests that test implementation details rather than behavior (asserting on internal state, breaking when refactoring without behavior change)
- Test setup/teardown that masks real issues (global state pollution between tests, overly permissive fixtures)
- Missing edge case coverage for functions that handle boundary conditions
- Test descriptions that don't match what the test actually verifies

## Severity Classification

### Critical
Must fix. Issues that affect correctness, security, or give false confidence.
- Security vulnerabilities exploitable from external input
- Tests that pass but don't verify what they claim to
- Correctness bugs (logic errors, race conditions)
- Data integrity risks

### Important
Should fix. Issues that affect maintainability, performance, or architectural health.
- Architectural boundary violations
- Significant code duplication (3+ instances)
- Performance issues in production-exercised paths
- Missing test coverage for critical business logic
- Poorly factored code that makes future changes risky

### Minor
Nice to fix. Issues that affect code clarity or consistency.
- Naming inconsistencies
- Small dead code pockets
- Style inconsistencies not caught by linters
- Minor duplication (2 instances)
- Tests that could be more precise but aren't wrong

## Report Format

```markdown
# Deep Clean Audit — YYYY-MM-DD

## Summary
- Automated tools: [pass/fail for each]
- Findings: X critical, Y important, Z minor

## Architecture & Design

### Critical
- **[Finding title]** — `path/to/file.ts:NN`
  Description of the issue and why it matters.

### Important
- ...

### Minor
- ...

## Security
(same structure)

## Performance
(same structure)

## Code Quality
(same structure)

## Test Quality
(same structure)

## Resolved
Items that were identified and fixed before this report was committed:
- [Finding title] — fixed in [commit or description]
```

## Skill Structure

The skill will be a custom superpowers skill with:

```
skills/deep-clean/
  SKILL.md              — Main skill file with workflow and orchestration
  architecture-agent.md — Prompt template for Architecture & Design agent
  security-agent.md     — Prompt template for Security agent
  performance-agent.md  — Prompt template for Performance agent
  code-quality-agent.md — Prompt template for Code Quality agent
  test-quality-agent.md — Prompt template for Test Quality agent
```

Each agent prompt template includes:
- The domain-specific checklist
- The severity classification rubric
- Instructions for structured output format
- Context about automated tool results (injected at dispatch time)

## Integration with Existing Skills

- **Runs after:** No prerequisite skills, but typically follows a development milestone
- **May trigger:** `requesting-code-review` for specific fixes, `systematic-debugging` for investigating findings
- **Does not replace:** `pnpm precommit` (which remains the per-commit gate), or `requesting-code-review` (which reviews changes against a plan)

## Design Decisions

**Why parallel agents, not sequential?**
Each domain requires reading broadly across the codebase. Sequential review would be extremely slow and context-heavy. Parallel agents each get fresh context windows focused on their domain, producing faster and more thorough results.

**Why a committed report?**
Historical record enables tracking codebase health over time, comparing audits across milestones, and verifying that findings from previous audits were actually addressed.

**Why run automated tools first?**
Establishes a clean baseline. No point having agents report type errors or lint violations — that's what the tools are for. Agents focus on judgment calls that require reading and understanding code.

**Why full codebase scope?**
A deep clean that only reviews diffs is just a code review. The value is in catching systemic issues, interactions between components, and patterns that emerge across the full codebase.
