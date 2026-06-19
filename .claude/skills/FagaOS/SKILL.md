```markdown
# FagaOS Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill introduces the core development patterns and conventions used in the FagaOS TypeScript codebase. It covers file organization, code style, commit message structure, and testing practices, equipping contributors with the knowledge to write consistent, maintainable code.

## Coding Conventions

### File Naming
- Use **camelCase** for all file names.
  - Example: `userProfile.ts`, `dataFetcher.ts`

### Import Style
- Use **absolute imports** for all modules.
  - Example:
    ```typescript
    import { fetchData } from 'services/dataFetcher';
    ```

### Export Style
- Mixed usage of **default** and **named exports**.
  - Example:
    ```typescript
    // Named export
    export function getUser() { ... }

    // Default export
    export default class UserManager { ... }
    ```

### Commit Message Patterns
- Commits reference tickets and use a prefix.
- Average commit message length: 51 characters.
- Example:
  ```
  ticket-123: Add user authentication middleware
  ```

## Workflows

### Commit Workflow
**Trigger:** When making a code change that needs to be committed.
**Command:** `/commit-ticket`

1. Make your code changes following the coding conventions.
2. Stage your changes: `git add .`
3. Commit using the ticket-reference pattern:
   ```
   git commit -m "ticket-<number>: <short description>"
   ```
   Example:
   ```
   git commit -m "ticket-456: Refactor dataFetcher for performance"
   ```

### Testing Workflow
**Trigger:** When adding or updating code that requires tests.
**Command:** `/run-tests`

1. Write or update test files using the `*.test.*` naming pattern.
   - Example: `userProfile.test.ts`
2. Run the test suite using your preferred test runner (framework is unspecified; consult project documentation or use a common TypeScript test runner like Jest or Mocha).
   - Example:
     ```
     npx jest
     ```
3. Ensure all tests pass before committing changes.

## Testing Patterns

- Test files are named with the pattern: `*.test.*`
  - Example: `dataFetcher.test.ts`
- Testing framework is not specified; use a standard TypeScript-compatible test runner.
- Place test files alongside the modules they test or in a dedicated `tests` directory.

**Example test file:**
```typescript
import { fetchData } from 'services/dataFetcher';

describe('fetchData', () => {
  it('returns expected data', async () => {
    const result = await fetchData();
    expect(result).toBeDefined();
  });
});
```

## Commands
| Command        | Purpose                                         |
|----------------|-------------------------------------------------|
| /commit-ticket | Commit changes with ticket-reference message     |
| /run-tests     | Run all test files matching `*.test.*` pattern  |
```
