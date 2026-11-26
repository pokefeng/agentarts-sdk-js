#!/usr/bin/env node
// Resolves and validates the release metadata consumed by
// `.github/workflows/publish-npm.yml`.
//
// The workflow publishes four packages, always in dependency order, so the
// version of every package is resolved in one place instead of being repeated
// in shell snippets. Run locally to preview:
//
//   node scripts/publish-meta.mjs
//   node scripts/publish-meta.mjs --root <fixture>
//
// Inputs come from the environment (the names are the ones GitHub Actions
// provides): GITHUB_EVENT_NAME, GITHUB_REF_NAME, INPUT_TAG, INPUT_DRY_RUN and
// GITHUB_OUTPUT. Errors are printed as `::error::` annotations so the workflow
// fails with a readable message.
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Packages to publish, in the order the workflow reports and publishes them. */
export const PACKAGES = Object.freeze([
  {
    key: 'identity_version',
    directory: 'huaweicloud-sdk-agentidentity',
    name: '@huaweicloud/huaweicloud-sdk-agentidentity',
  },
  {
    key: 'sdk_version',
    directory: 'agentarts-sdk',
    name: '@huaweicloud/agentarts-sdk',
  },
  {
    key: 'a2a_version',
    directory: 'agentarts-protocol-a2a',
    name: '@huaweicloud/agentarts-protocol-a2a',
  },
  {
    key: 'agui_version',
    directory: 'agentarts-protocol-agui',
    name: '@huaweicloud/agentarts-protocol-agui',
  },
]);

const TAG_PATTERN =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Read the four publishable manifests, verifying each name and version. */
export function readVersions(root = process.cwd()) {
  return PACKAGES.map(({ key, directory, name }) => {
    const file = `packages/${directory}/package.json`;
    let manifest;
    try {
      manifest = JSON.parse(
        readFileSync(resolve(root, 'packages', directory, 'package.json'), 'utf8'),
      );
    } catch (error) {
      throw new Error(`Cannot read ${file}: ${message(error)}`);
    }
    if (manifest.name !== name) {
      throw new Error(`${file} is named '${manifest.name}', expected '${name}'`);
    }
    if (typeof manifest.version !== 'string' || !manifest.version) {
      throw new Error(`${file} has no version`);
    }
    return { key, name, version: manifest.version };
  });
}

/**
 * Validate the tag against the SDK version and resolve every publish version.
 *
 * The tag drives the whole release through `@huaweicloud/agentarts-sdk`, which
 * keeps the coordinated changeset honest. The other packages publish at their
 * own version and only warn on a mismatch, so a repeated tag or a single-package
 * bump stays publishable (already published versions are skipped by the caller).
 */
export function resolveRelease({
  versions,
  eventName = '',
  refName = '',
  inputTag = '',
  inputDryRun = '',
}) {
  const sdk = versions.find((entry) => entry.key === 'sdk_version');
  if (!sdk) throw new Error('The release set must include @huaweicloud/agentarts-sdk');

  const warnings = [];
  const notices = [];
  // A tag push is the release trigger; workflow_dispatch may pass a tag to validate.
  const tag = (eventName === 'push' ? refName : inputTag).trim();
  let tagVersion = '';
  if (tag) {
    if (!TAG_PATTERN.test(tag)) {
      throw new Error(
        `Invalid tag '${tag}'. Expected 'v<major>.<minor>.<patch>' (e.g. v${sdk.version}).`,
      );
    }
    tagVersion = tag.slice(1);
    if (tagVersion !== sdk.version) {
      throw new Error(
        `Tag version '${tagVersion}' does not match @huaweicloud/agentarts-sdk version '${sdk.version}'. Bump the package version or use the correct tag.`,
      );
    }
    for (const entry of versions) {
      if (entry.key === 'sdk_version' || entry.version === tagVersion) continue;
      warnings.push(
        `${entry.name} is at ${entry.version}, which differs from tag ${tag}. It will be published at ${entry.version} (skipped if already on the registry).`,
      );
    }
  } else {
    notices.push(
      `No tag supplied (workflow_dispatch); using package versions: ${versions
        .map((entry) => `${entry.key.replace('_version', '')}=${entry.version}`)
        .join(', ')}`,
    );
  }

  // A tag push always publishes; a manual run defaults to a dry run.
  let dryRun = eventName === 'push' ? 'false' : inputDryRun.trim();
  if (dryRun !== 'true') dryRun = 'false';

  return { dryRun, notices, tag, tagVersion, versions, warnings };
}

/** Render the `key=value` block written to `$GITHUB_OUTPUT`. */
export function formatOutputs(release) {
  return [
    ...release.versions.map((entry) => `${entry.key}=${entry.version}`),
    `dry_run=${release.dryRun}`,
    `tag=${release.tag}`,
  ].join('\n');
}

function parseRoot(argv) {
  const index = argv.indexOf('--root');
  if (index === -1) return process.cwd();
  const value = argv[index + 1];
  if (!value) throw new Error('--root requires a directory');
  return resolve(value);
}

/** CLI entry point; returns the process exit code. */
export function main({ argv = process.argv.slice(2), env = process.env } = {}) {
  try {
    const release = resolveRelease({
      versions: readVersions(parseRoot(argv)),
      eventName: env.GITHUB_EVENT_NAME ?? '',
      refName: env.GITHUB_REF_NAME ?? '',
      inputTag: env.INPUT_TAG ?? '',
      inputDryRun: env.INPUT_DRY_RUN ?? '',
    });
    for (const notice of release.notices) console.log(`::notice::${notice}`);
    for (const warning of release.warnings) console.log(`::warning::${warning}`);
    const outputs = formatOutputs(release);
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${outputs}\n`);
    else console.log(outputs);
    console.log(
      `Resolved ${release.versions
        .map((entry) => `${entry.name}@${entry.version}`)
        .join(', ')} (tag='${release.tag}', dry_run=${release.dryRun})`,
    );
    return 0;
  } catch (error) {
    console.log(`::error::${message(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
