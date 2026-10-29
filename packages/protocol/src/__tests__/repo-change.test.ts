import { describe, expect, it } from "vitest";

import {
  ALL_GIT_OBJECT_FORMATS,
  ALL_REPO_CHANGE_REPAIR_CODES,
  ALL_REPO_CHANGE_TOOLS,
  GIT_OBJECT_ID_HEX_LENGTH,
  REPO_CHANGE_BUNDLE_SPEC_ID,
  REPO_CHANGE_MAX_GRANT_LIFETIME_MS,
  REPO_CHANGE_SPEC_ID,
  REPO_TASK_SCOPE_SCHEMA,
  REPO_TASK_SCOPE_SPEC_ID,
} from "../index.js";

describe("repo-change vocabulary", () => {
  it("spec tags name the three artifacts", () => {
    expect(REPO_TASK_SCOPE_SCHEMA).toBe("motebit.repo-task-scope.v1");
    expect(REPO_TASK_SCOPE_SPEC_ID).toBe("motebit/repo-task-scope@1.0");
    expect(REPO_CHANGE_SPEC_ID).toBe("motebit/repo-change@1.0");
    expect(REPO_CHANGE_BUNDLE_SPEC_ID).toBe("motebit/repo-change-bundle@1.0");
  });

  it("the grant lifetime bound is 24 hours", () => {
    expect(REPO_CHANGE_MAX_GRANT_LIFETIME_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("the tool and object-format lists are frozen", () => {
    expect(Object.isFrozen(ALL_REPO_CHANGE_TOOLS)).toBe(true);
    expect(ALL_REPO_CHANGE_TOOLS).toEqual(["repo_read_blob", "repo_write_path"]);
    expect(Object.isFrozen(ALL_GIT_OBJECT_FORMATS)).toBe(true);
    expect(Object.isFrozen(GIT_OBJECT_ID_HEX_LENGTH)).toBe(true);
  });

  it("every git object format has an object-id length", () => {
    for (const f of ALL_GIT_OBJECT_FORMATS) expect(GIT_OBJECT_ID_HEX_LENGTH[f]).toBeGreaterThan(0);
    expect(GIT_OBJECT_ID_HEX_LENGTH.sha1).toBe(40);
    expect(GIT_OBJECT_ID_HEX_LENGTH.sha256).toBe(64);
  });

  it("repair codes are unique, frozen, and prefixed by a verdict axis", () => {
    expect(Object.isFrozen(ALL_REPO_CHANGE_REPAIR_CODES)).toBe(true);
    expect(new Set(ALL_REPO_CHANGE_REPAIR_CODES).size).toBe(ALL_REPO_CHANGE_REPAIR_CODES.length);
    for (const code of ALL_REPO_CHANGE_REPAIR_CODES) {
      expect(code).toMatch(/^(integrity|identity|authority|revocation)\.repo_change\.[a-z_]+$/);
    }
  });
});
