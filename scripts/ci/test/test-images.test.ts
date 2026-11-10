// .github/scripts/test-images.mjs: which earlier run's artifact a job restores its Docker test
// images from. Trusted like an Actions cache scope: a run of this repository on the default
// branch or on the job's own branch, never a fork's pull request (whose runs upload artifacts
// here too), and never an artifact about to expire.
import { describe, expect, it } from 'vitest';
import { MIN_LIFE_MS, pickArtifact } from '../../../.github/scripts/test-images.mjs';

const REPO_ID = 1001;
const FORK_ID = 2002;
const NOW = Date.parse('2026-11-10T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const BRANCHES = ['main', 'soak/docker-offline'];

/** An artifact of the run `runId` on `branch`, uploaded `daysAgo` days before NOW, kept 90 days. */
function artifact(id: number, { branch = 'main', daysAgo = 1, runId = id * 10, headRepo = REPO_ID, expired = false } = {}) {
  const created = NOW - daysAgo * DAY_MS;
  return {
    id,
    name: 'test-images-x64-0123456789abcdef',
    expired,
    created_at: new Date(created).toISOString(),
    expires_at: new Date(created + 90 * DAY_MS).toISOString(),
    workflow_run: { id: runId, repository_id: REPO_ID, head_repository_id: headRepo, head_branch: branch },
  };
}

describe('pickArtifact', () => {
  it('takes the newest artifact of the default branch', () => {
    // Arrange
    const artifacts = [artifact(1, { daysAgo: 30 }), artifact(3, { daysAgo: 2 }), artifact(2, { daysAgo: 10 })];

    // Act
    const hit = pickArtifact(artifacts, { branches: BRANCHES, now: NOW });

    // Assert
    expect(hit?.id).toBe(3);
  });

  it("also takes the job's own branch, newest first, but no other branch", () => {
    // Arrange
    const artifacts = [artifact(1, { daysAgo: 5 }), artifact(2, { branch: 'soak/docker-offline', daysAgo: 3 }), artifact(3, { branch: 'feat/other', daysAgo: 1 })];

    // Act
    const hit = pickArtifact(artifacts, { branches: BRANCHES, now: NOW });

    // Assert
    expect(hit?.id).toBe(2);
  });

  it("never takes a fork's artifact, even from a branch named like the default one", () => {
    // Arrange
    const artifacts = [artifact(1, { daysAgo: 20 }), artifact(2, { headRepo: FORK_ID, daysAgo: 1 })];

    // Act
    const hit = pickArtifact(artifacts, { branches: BRANCHES, now: NOW });

    // Assert
    expect(hit?.id).toBe(1);
  });

  it('passes over an expired artifact and one that expires within the hour', () => {
    // Arrange
    const almostGone = artifact(2, { daysAgo: 90 - MIN_LIFE_MS / 2 / DAY_MS });
    const artifacts = [artifact(1, { daysAgo: 1, expired: true }), almostGone];

    // Act
    const hit = pickArtifact(artifacts, { branches: BRANCHES, now: NOW });

    // Assert
    expect(hit).toBeNull();
  });

  it('finds nothing without a run to download from', () => {
    // Arrange
    const noRun = { ...artifact(1), workflow_run: undefined };

    // Act
    const hit = pickArtifact([noRun], { branches: BRANCHES, now: NOW });

    // Assert
    expect(hit).toBeNull();
  });
});
