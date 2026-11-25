import {
  type Adapter,
  type AdapterForks,
  type AdapterSnapshots,
  checkSignal,
  defaultDiff,
  defaultMerge,
  defaultRebase,
  emptyManifest,
  type ForkInfo,
  type ForkOptions,
  type Manifest,
  nextSnapshotId,
  type ReadOnlyAdapter,
  readManifest,
  type SnapshotInfo,
  StorageError,
  writeManifest,
} from '@storagesdk/core/adapter';

/**
 * What the sibling-prefix snapshot/fork logic needs from a transport. Both
 * Bunny adapters (Edge Storage HTTP and S3) lay out a storage zone the same
 * way, with one key prefix per logical bucket. They differ only in how
 * bytes move, so each one supplies these operations.
 */
export interface SiblingTransport<Raw> {
  /** Adapter for the logical bucket stored under the `bucket/` prefix. */
  at(bucket: string): Adapter<Raw>;
  /** Whether anything, including a manifest, is stored under `prefix/`. */
  inUse(prefix: string, signal?: AbortSignal): Promise<boolean>;
  /**
   * Copy every object under `from/` to `to/`, skipping the manifest (the
   * destination writes its own).
   */
  copyAll(from: string, to: string, signal?: AbortSignal): Promise<void>;
  /** Remove everything under `prefix/`. Throws if the removal fails. */
  destroy(prefix: string, signal?: AbortSignal): Promise<void>;
  /** Map a transport error to a `StorageError`. */
  asStorageError(err: unknown): StorageError;
}

// Copies and deletes issued at once while seeding or removing a
// snapshot/fork prefix. Well under Bunny's 500 requests/second limit.
const CONCURRENCY = 16;

/** Run `fn` over `items`, at most `CONCURRENCY` at a time. */
export async function inBatches<T>(
  items: readonly T[],
  fn: (item: T) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    await Promise.all(items.slice(i, i + CONCURRENCY).map(fn));
  }
}

/**
 * Check that `name` can be used as a top-level prefix in the zone: a
 * logical bucket, or a fork name. It must be one non-empty path segment.
 * A `/` would nest the location inside another one (a fork named
 * `demo/x` would land inside bucket `demo`), and `.` / `..` would be
 * resolved away by URL parsing.
 */
export function assertLocation(kind: string, name: string): void {
  if (name === '' || name === '.' || name === '..' || name.includes('/')) {
    throw new StorageError({
      code: 'InvalidArgument',
      message: `${kind} must be a single path segment without "/", got ${JSON.stringify(name)}`,
    });
  }
}

/**
 * Snapshots and forks for one logical bucket in a Bunny storage zone.
 * Snapshots live at `<bucket>-snapshot-<id>/`, forks at `<forkName>/`, and
 * every location carries its own `.storagesdk.metadata.json` manifest.
 */
export function siblings<Raw>(
  transport: SiblingTransport<Raw>,
  bucket: string
): { snapshots: AdapterSnapshots; forks: AdapterForks<Raw> } {
  const { at, inUse, copyAll, destroy, asStorageError } = transport;

  /**
   * Copy `from/` into the new location `to/`, give it a manifest, and add
   * it to this bucket's manifest with `register`. If any step fails the
   * partial copy is removed. The rollback runs without the caller's
   * signal: an abort is the most likely reason to get here, and an
   * aborted signal would cancel the cleanup too.
   */
  const createSibling = async (
    from: string,
    to: string,
    snapshotId: string | null,
    register: (meta: Manifest) => void,
    signal: AbortSignal | undefined
  ): Promise<void> => {
    try {
      await copyAll(from, to, signal);
      await writeManifest(
        at(to),
        emptyManifest({ location: bucket, snapshotId })
      );
      const self = at(bucket);
      const meta = await readManifest(self);
      register(meta);
      await writeManifest(self, meta);
    } catch (err) {
      await destroy(to).catch(() => {});
      throw asStorageError(err);
    }
  };

  return {
    snapshots: {
      async create(opts): Promise<SnapshotInfo> {
        checkSignal(opts?.signal);
        const id = nextSnapshotId(bucket);
        const info: SnapshotInfo = {
          id,
          createdAt: new Date(),
          ...(opts?.name !== undefined ? { name: opts.name } : {}),
        };
        await createSibling(
          bucket,
          id,
          null,
          (meta) => meta.snapshots.push(info),
          opts?.signal
        );
        return info;
      },

      async list(): Promise<SnapshotInfo[]> {
        return (await readManifest(at(bucket))).snapshots;
      },

      async head(id, opts): Promise<SnapshotInfo> {
        checkSignal(opts?.signal);
        const meta = await readManifest(at(bucket));
        const found = meta.snapshots.find((s) => s.id === id);
        if (!found) {
          throw new StorageError({
            code: 'NotFound',
            message: `snapshot ${id} not found`,
          });
        }
        return found;
      },

      async delete(id, opts): Promise<void> {
        checkSignal(opts?.signal);
        const self = at(bucket);
        const meta = await readManifest(self);
        // Only remove prefixes this bucket's manifest knows about. Every
        // logical bucket in the zone is a sibling prefix, so deleting an
        // unknown id blindly could wipe unrelated data.
        if (!meta.snapshots.some((s) => s.id === id)) return;
        // Remove the data first. If that fails the manifest still lists
        // the snapshot, so the caller can retry.
        try {
          await destroy(id, opts?.signal);
        } catch (err) {
          throw asStorageError(err);
        }
        meta.snapshots = meta.snapshots.filter((s) => s.id !== id);
        await writeManifest(self, meta);
      },

      get(id): ReadOnlyAdapter {
        assertLocation('snapshot id', id);
        const snap = at(id);
        return {
          download: (p, opts) => snap.download(p, opts),
          head: (p, opts) => snap.head(p, opts),
          list: (opts) => snap.list(opts),
          url: (p, opts) => snap.url(p, opts),
        };
      },
    },

    forks: {
      async create(opts: ForkOptions): Promise<ForkInfo> {
        checkSignal(opts.signal);
        assertLocation('fork name', opts.name);
        const existing = await readManifest(at(bucket));
        // A zone has no native bucket guard, so two forks with the same
        // name would write to the same prefix. Check the manifest first so
        // a duplicate throws `Conflict`.
        if (existing.forks.some((f) => f.name === opts.name)) {
          throw new StorageError({
            code: 'Conflict',
            message: `fork ${opts.name} already exists`,
          });
        }
        if (
          opts.fromSnapshot !== undefined &&
          !existing.snapshots.some((s) => s.id === opts.fromSnapshot)
        ) {
          throw new StorageError({
            code: 'NotFound',
            message: `snapshot ${opts.fromSnapshot} not found`,
          });
        }
        // The fork's prefix must be free. It could be this bucket, or
        // another logical bucket in the zone that this manifest doesn't
        // know about. Copying into it would mix the two, and the rollback
        // would then delete it.
        let taken: boolean;
        try {
          taken = opts.name === bucket || (await inUse(opts.name, opts.signal));
        } catch (err) {
          throw asStorageError(err);
        }
        if (taken) {
          throw new StorageError({
            code: 'Conflict',
            message: `fork ${opts.name} already exists`,
          });
        }
        const info: ForkInfo = {
          name: opts.name,
          createdAt: new Date(),
          ...(opts.fromSnapshot !== undefined
            ? { fromSnapshot: opts.fromSnapshot }
            : {}),
        };
        await createSibling(
          opts.fromSnapshot ?? bucket,
          opts.name,
          opts.fromSnapshot ?? null,
          (meta) => meta.forks.push(info),
          opts.signal
        );
        return info;
      },

      async list(): Promise<ForkInfo[]> {
        return (await readManifest(at(bucket))).forks;
      },

      async head(name, opts): Promise<ForkInfo> {
        checkSignal(opts?.signal);
        const meta = await readManifest(at(bucket));
        const found = meta.forks.find((f) => f.name === name);
        if (!found) {
          throw new StorageError({
            code: 'NotFound',
            message: `fork ${name} not found`,
          });
        }
        return found;
      },

      async delete(name, opts): Promise<void> {
        checkSignal(opts?.signal);
        const self = at(bucket);
        const meta = await readManifest(self);
        // Same guards as `snapshots.delete`: unknown names are a no-op,
        // and the manifest entry goes only once the data is gone.
        if (!meta.forks.some((f) => f.name === name)) return;
        try {
          await destroy(name, opts?.signal);
        } catch (err) {
          throw asStorageError(err);
        }
        meta.forks = meta.forks.filter((f) => f.name !== name);
        await writeManifest(self, meta);
      },

      get(name): Adapter<Raw> {
        assertLocation('fork name', name);
        return at(name);
      },

      merge: (name, opts) => defaultMerge(at(bucket), name, opts),
      rebase: (name, opts) => defaultRebase(at(bucket), name, opts),
      diff: (name, opts) => defaultDiff(at(bucket), name, opts),
    },
  };
}
