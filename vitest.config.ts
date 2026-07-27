import { defineConfig } from "vitest/config";

/**
 * Without this file vitest applied its DEFAULT include glob from the package
 * root, which walked `.claude/worktrees/` and EXECUTED every stale agent-worktree
 * copy of the test suite alongside the real one — a `test` run reported "93
 * passed" that silently double-counted `project-ref.test.ts` from two stale
 * trees. A gate that runs stale code is not a gate. Exclude the worktrees (and
 * the usual build dirs) so the count reflects only this working tree.
 */
export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.claude/worktrees/**",
    ],
  },
});
