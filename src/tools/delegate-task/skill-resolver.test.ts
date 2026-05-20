import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { resolveSkillContent } from "./skill-resolver"
import { clearSkillCache } from "../../features/opencode-skill-loader/skill-discovery"

const TEST_DIR = join(tmpdir(), `skill-resolver-test-${Date.now()}`)

function makeNativeSkill(name: string, description: string, content: string) {
  return { name, description, location: `/fake/native/${name}/SKILL.md`, content }
}

function makeNativeAccessor(skills: ReturnType<typeof makeNativeSkill>[]) {
  return {
    all: () => skills,
    get: (name: string) => skills.find((s) => s.name === name),
    dirs: () => ["/fake/native"],
  }
}

describe("resolveSkillContent — nativeSkills integration", () => {
  beforeEach(() => {
    clearSkillCache()
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterEach(() => {
    clearSkillCache()
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it("#given an empty skill list #when resolved #then returns no content with no error", async () => {
    // when
    const result = await resolveSkillContent([], {})
    // then
    expect(result).toEqual({ content: undefined, contents: [], error: null })
  })

  it("#given a skill that lives only in nativeSkills #when resolved #then returns its content", async () => {
    // given
    const native = makeNativeSkill(
      "test-driven-development",
      "TDD discipline",
      "## Red-Green-Refactor\nWrite a failing test first.",
    )
    const nativeSkills = makeNativeAccessor([native])

    // when
    const result = await resolveSkillContent(["test-driven-development"], {
      nativeSkills,
      directory: TEST_DIR,
    })

    // then
    expect(result.error).toBeNull()
    expect(result.contents).toHaveLength(1)
    expect(result.content).toContain("Red-Green-Refactor")
    expect(result.content).toContain("Write a failing test first")
  })

  it("#given a name present in both OMO disk-discovered and nativeSkills #when resolved #then OMO content wins", async () => {
    // given a name we know does NOT collide with builtins; force a fake one
    // We use a fake disk skill via the merger pattern: write a SKILL.md under TEST_DIR/.opencode/skills/
    const skillsDir = join(TEST_DIR, ".opencode", "skills", "shared-name")
    mkdirSync(skillsDir, { recursive: true })
    writeFileSync(
      join(skillsDir, "SKILL.md"),
      "---\nname: shared-name-test-skill\ndescription: from disk\n---\nOMO_DISK_BODY",
    )
    const native = makeNativeSkill(
      "shared-name-test-skill",
      "from native",
      "NATIVE_BODY",
    )
    const nativeSkills = makeNativeAccessor([native])

    // when
    const result = await resolveSkillContent(["shared-name-test-skill"], {
      nativeSkills,
      directory: TEST_DIR,
    })

    // then — OMO wins on name collision (mergeNativeSkills skips already-known names)
    expect(result.error).toBeNull()
    expect(result.content).toContain("OMO_DISK_BODY")
    expect(result.content).not.toContain("NATIVE_BODY")
  })

  it("#given a skill that exists in neither registry #when resolved #then returns notFound error listing the merged set", async () => {
    // given
    const native = makeNativeSkill("alpha", "alpha desc", "alpha body")
    const nativeSkills = makeNativeAccessor([native])

    // when
    const result = await resolveSkillContent(["does-not-exist"], {
      nativeSkills,
      directory: TEST_DIR,
    })

    // then
    expect(result.error).toBeTruthy()
    expect(result.error).toContain("does-not-exist")
    // the merged "Available" list should include the native skill name
    expect(result.error).toContain("alpha")
  })

  it("#given nativeSkills.all() throws #when resolved #then degrades gracefully (still finds disk-discovered skills)", async () => {
    // given
    const exploding = {
      all: () => {
        throw new Error("boom")
      },
      get: () => undefined,
      dirs: () => [],
    }

    // when (we just need this not to throw or hang)
    const result = await resolveSkillContent(["missing-skill"], {
      nativeSkills: exploding,
      directory: TEST_DIR,
    })

    // then — error path still works, no crash
    expect(result.error).toBeTruthy()
    expect(result.error).toContain("missing-skill")
  })

  it("#given no nativeSkills passed #when resolved #then behaves like pre-fix (no native discovery)", async () => {
    // when
    const result = await resolveSkillContent(["does-not-exist"], {
      directory: TEST_DIR,
    })
    // then
    expect(result.error).toBeTruthy()
    expect(result.error).toContain("does-not-exist")
  })
})
