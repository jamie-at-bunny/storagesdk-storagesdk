import { afterAll, describe, expect, it } from 'vitest';
import { bunny } from '../../src/bunny/bunny.js';
import { storageAdapterTestSuite } from '../../src/test-suite.js';

// Live tests against a real Bunny storage zone. The suite is skipped when
// the required env vars are missing or empty. `accessKey` is the storage
// zone password, not the account API key.
const ZONE = process.env.BUNNY_STORAGE_ZONE;
const ACCESS_KEY = process.env.BUNNY_STORAGE_ACCESS_KEY;
const BUCKET = process.env.BUNNY_STORAGE_BUCKET ?? 'storagesdk-test';
const REGION = process.env.BUNNY_STORAGE_REGION as
  | Parameters<typeof bunny>[0]['region']
  | undefined;
// A linked pull zone makes `url()` publicly fetchable; without it the
// adapter returns the auth-required storage URL and the suite skips the
// fetch assertions.
const PULL_ZONE = process.env.BUNNY_PULL_ZONE;

const configured = Boolean(ZONE && ACCESS_KEY);

const buildAdapter = () =>
  bunny({
    zone: ZONE as string,
    bucket: BUCKET,
    accessKey: ACCESS_KEY as string,
    ...(REGION ? { region: REGION } : {}),
    ...(PULL_ZONE ? { pullZone: PULL_ZONE } : {}),
  });

storageAdapterTestSuite({
  name: 'bunny adapter',
  skip: !configured,
  adapter: buildAdapter,
  capabilities: {
    // Bunny Edge Storage has no user-metadata field.
    userMetadata: false,
    // No presigned upload URL.
    presignedUploads: false,
    // `url()` is publicly fetchable only when a pull zone is configured.
    fetchableSignedUrls: Boolean(PULL_ZONE),
  },
  // Bunny has no server-side copy. Snapshot/fork seeding and copy/move
  // send every object's bytes through the client and need more time.
  testTimeoutMs: 60_000,
});

// Edge Storage keeps a folder after its last file is deleted, and `list`
// has to request every folder. Each test writes under its own prefix, so
// without this every run would leave dozens of empty folders behind and
// later runs would list more and more slowly. Remove the folders under the
// test bucket that hold no files. A run sharing the bucket could race
// this, as with the diff-based cleanup.
if (configured) {
  afterAll(async () => {
    const { endpoint, zone, accessKey } = buildAdapter().raw;
    const url = (dir: string) => `${endpoint}/${zone}/${encodeURI(dir)}`;
    const headers = { AccessKey: accessKey, Accept: 'application/json' };
    const entries = async (dir: string) => {
      const res = await fetch(url(dir), { headers });
      return res.ok
        ? ((await res.json()) as Array<{
            ObjectName: string;
            IsDirectory: boolean;
          }>)
        : [];
    };
    const hasFiles = async (dir: string): Promise<boolean> => {
      for (const e of await entries(dir)) {
        if (!e.IsDirectory) return true;
        if (await hasFiles(`${dir}${e.ObjectName}/`)) return true;
      }
      return false;
    };
    for (const e of await entries(`${BUCKET}/`)) {
      const dir = `${BUCKET}/${e.ObjectName}/`;
      if (e.IsDirectory && !(await hasFiles(dir))) {
        await fetch(url(dir), { method: 'DELETE', headers });
      }
    }
  }, 120_000);
}

if (!configured) {
  describe('bunny adapter (skipped)', () => {
    it('skipped: BUNNY_STORAGE_ZONE / BUNNY_STORAGE_ACCESS_KEY not set', () => {
      expect(true).toBe(true);
    });
  });
}
