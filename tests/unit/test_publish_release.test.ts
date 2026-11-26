import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = fileURLToPath(new URL('../../scripts/publish-meta.mjs', import.meta.url));
const workflowFile = fileURLToPath(
  new URL('../../.github/workflows/publish-npm.yml', import.meta.url),
);

/** Packages the publish workflow releases, in the order it calls them. */
const PACKAGES = [
  ['huaweicloud-sdk-agentidentity', '@huaweicloud/huaweicloud-sdk-agentidentity'],
  ['agentarts-sdk', '@huaweicloud/agentarts-sdk'],
  ['agentarts-protocol-a2a', '@huaweicloud/agentarts-protocol-a2a'],
  ['agentarts-protocol-agui', '@huaweicloud/agentarts-protocol-agui'],
] as const;
const PACKAGE_NAMES = PACKAGES.map(([, name]) => name);

const fixtures: string[] = [];
afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** Build a fake repository root with the four publishable manifests. */
function fixture(overrides: Record<string, string> = {}) {
  const path = mkdtempSync(join(tmpdir(), 'agentarts-publish-'));
  fixtures.push(path);
  for (const [directory, name] of PACKAGES) {
    mkdirSync(join(path, 'packages', directory), { recursive: true });
    writeFileSync(
      join(path, 'packages', directory, 'package.json'),
      JSON.stringify({ name, version: overrides[directory] ?? '0.0.5' }),
    );
  }
  return path;
}

function run(path: string, env: Record<string, string> = {}) {
  const output = join(path, 'github-output');
  writeFileSync(output, '');
  const result = spawnSync(process.execPath, [script, '--root', path], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: '',
      GITHUB_REF_NAME: '',
      INPUT_TAG: '',
      INPUT_DRY_RUN: '',
      GITHUB_OUTPUT: output,
      ...env,
    },
  });
  return { ...result, outputs: readFileSync(output, 'utf8') };
}

it('resolves the version of every published package and writes workflow outputs', () => {
  const result = run(fixture(), { GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: 'v0.0.5' });
  expect(result.status, result.stderr).toBe(0);
  const values = new Map(
    result.outputs
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split('=') as [string, string]),
  );
  expect(values.get('sdk_version')).toBe('0.0.5');
  expect(values.get('identity_version')).toBe('0.0.5');
  expect(values.get('a2a_version')).toBe('0.0.5');
  expect(values.get('agui_version')).toBe('0.0.5');
  expect(values.get('tag')).toBe('v0.0.5');
  expect(values.get('dry_run')).toBe('false');
  for (const name of PACKAGE_NAMES) expect(result.stdout).toContain(`${name}@0.0.5`);
});

it('keeps a manual run dry by default and accepts a tag to validate', () => {
  const result = run(fixture(), {
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    INPUT_DRY_RUN: 'true',
    INPUT_TAG: 'v0.0.5',
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.outputs).toContain('dry_run=true');
  expect(result.outputs).toContain('tag=v0.0.5');
});

it('rejects a tag that does not match the SDK version', () => {
  const result = run(fixture(), { GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: 'v0.0.4' });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain(
    "::error::Tag version '0.0.4' does not match @huaweicloud/agentarts-sdk version '0.0.5'",
  );
});

it('rejects a tag that is not a release version', () => {
  const result = run(fixture(), { GITHUB_EVENT_NAME: 'workflow_dispatch', INPUT_TAG: 'release-5' });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("::error::Invalid tag 'release-5'");
});

it('warns but still publishes when a package lags behind the tag', () => {
  const result = run(fixture({ 'agentarts-protocol-agui': '0.0.4' }), {
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF_NAME: 'v0.0.5',
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(
    '::warning::@huaweicloud/agentarts-protocol-agui is at 0.0.4, which differs from tag v0.0.5',
  );
  expect(result.outputs).toContain('agui_version=0.0.4');
  expect(result.outputs).toContain('a2a_version=0.0.5');
});

it('reports a missing or misnamed manifest instead of publishing silently', () => {
  const missing = fixture();
  rmSync(join(missing, 'packages/agentarts-protocol-a2a/package.json'));
  const absent = run(missing, { GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: 'v0.0.5' });
  expect(absent.status).toBe(1);
  expect(absent.stdout).toContain(
    '::error::Cannot read packages/agentarts-protocol-a2a/package.json',
  );

  const misnamed = fixture();
  writeFileSync(
    join(misnamed, 'packages/agentarts-protocol-agui/package.json'),
    JSON.stringify({ name: 'agentarts-protocol-agui', version: '0.0.5' }),
  );
  const renamed = run(misnamed, { GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: 'v0.0.5' });
  expect(renamed.status).toBe(1);
  expect(renamed.stdout).toContain("expected '@huaweicloud/agentarts-protocol-agui'");
});

function workflow() {
  return parse(readFileSync(workflowFile, 'utf8'));
}
function step(name: string) {
  const found = workflow().jobs.verify.steps.find((candidate: any) => candidate.name === name);
  expect(found, `workflow step '${name}'`).toBeDefined();
  return found;
}
function publishStep() {
  const found = workflow().jobs.publish.steps.find(
    (candidate: any) => candidate.name === 'Publish to npm',
  );
  expect(found, "workflow step 'Publish to npm'").toBeDefined();
  return found;
}
function calls(source: string, command: string) {
  return [...source.matchAll(new RegExp(`${command} "(@huaweicloud/[^"]+)"`, 'g'))].map(
    (match) => match[1],
  );
}

it('publishes all four packages without inter-package dependency gates', () => {
  const publish = publishStep();
  expect(calls(publish.run, 'publish_package')).toEqual(PACKAGE_NAMES);
  // 包与包之间不做先后判断：不等待其他包出现在 registry 上，也不用 peer 依赖做门禁。
  expect(publish.run).not.toContain('ensure_available');
  expect(publish.run).not.toMatch(/npm view [^\n]*\n\s*sleep/);
  for (const key of ['SDK_VERSION', 'IDENTITY_VERSION', 'A2A_VERSION', 'AGUI_VERSION']) {
    expect(publish.env[key]).toBe(`\${{ needs.verify.outputs.${key.toLowerCase()} }}`);
  }
});

it('validates the tarball of every package before publishing', () => {
  expect(calls(step('Validate npm tarballs').run, 'pack_and_check')).toEqual(PACKAGE_NAMES);
});

it('never pipes tar output into grep under pipefail in the tarball check', () => {
  // `tar -tzf ... | grep -qx` looks fine but `grep -q` closes the pipe after the
  // first match, tar dies with SIGPIPE and `set -o pipefail` reports a missing
  // file. The step must write the listing to a file before matching.
  const script: string = step('Validate npm tarballs').run;
  const executable = script
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  expect(executable).not.toMatch(/tar\b[^\n|]*\|/);
  expect(executable).toContain('tar -tzf "${tarball}" > "${file_list}"');
});

it('exposes every resolved version to the publish job', () => {
  expect(workflow().jobs.verify.steps.find((candidate: any) => candidate.id === 'meta').run).toBe(
    'node scripts/publish-meta.mjs',
  );
  expect(Object.keys(workflow().jobs.verify.outputs).sort()).toEqual(
    ['agui_version', 'a2a_version', 'dry_run', 'identity_version', 'sdk_version'].sort(),
  );
});

it('ships README and LICENSE in the protocol package tarballs', () => {
  for (const directory of ['agentarts-protocol-a2a', 'agentarts-protocol-agui']) {
    const manifest = JSON.parse(
      readFileSync(join(root, 'packages', directory, 'package.json'), 'utf8'),
    );
    expect(manifest.files).toEqual(expect.arrayContaining(['dist', 'README.md', 'LICENSE']));
  }
});
