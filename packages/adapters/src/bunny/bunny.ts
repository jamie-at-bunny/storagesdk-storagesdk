import {
  type Adapter,
  bodyToBytes,
  checkSignal,
  defineAdapter,
  isInternalKey,
  StorageError,
  type StorageItem,
  type StorageItemMeta,
} from '@storagesdk/core/adapter';
import { asStorageError, BunnyHttpError } from './errors.js';
import { assertLocation, inBatches, siblings } from './siblings.js';

/**
 * Primary storage region of a Bunny storage zone. The `de` (Falkenstein)
 * region is served from the bare `storage.bunnycdn.com` host; every other
 * region prefixes the host with its code.
 */
export type BunnyRegion =
  | 'de'
  | 'uk'
  | 'ny'
  | 'la'
  | 'sg'
  | 'se'
  | 'br'
  | 'jh'
  | 'syd';

// Kept in step with `regions.StorageRegion` and `regions.addr` in
// `@bunny.net/storage-sdk`. Check there when adding a region. It isn't
// imported, so this adapter has no dependencies.
const REGION_HOSTS: Readonly<Record<BunnyRegion, string>> = {
  de: 'storage.bunnycdn.com',
  uk: 'uk.storage.bunnycdn.com',
  ny: 'ny.storage.bunnycdn.com',
  la: 'la.storage.bunnycdn.com',
  sg: 'sg.storage.bunnycdn.com',
  se: 'se.storage.bunnycdn.com',
  br: 'br.storage.bunnycdn.com',
  jh: 'jh.storage.bunnycdn.com',
  syd: 'syd.storage.bunnycdn.com',
};

export interface BunnyConfig {
  /**
   * Storage zone name. The credentials belong to this zone, and it is the
   * first path segment of every Edge Storage request.
   */
  zone: string;
  /**
   * Logical bucket name. A Bunny storage zone is one flat key namespace,
   * so the adapter maps each storagesdk "bucket" to a key prefix
   * (`<bucket>/<key>`). Several buckets can share one zone, and
   * snapshots and forks live as sibling prefixes in the same zone. Must be
   * a single path segment (no `/`).
   */
  bucket: string;
  /**
   * Storage-zone password (read-write API key). This is the per-zone
   * password from the Bunny dashboard, not the account-level API key.
   */
  accessKey: string;
  /** Primary storage region. Defaults to `de` (Falkenstein). */
  region?: BunnyRegion;
  /**
   * Override the storage endpoint origin entirely (e.g. a local mock or a
   * region not in {@link BunnyRegion}). Takes precedence over `region`.
   */
  endpoint?: string;
  /**
   * Pull-zone hostname for public file URLs, e.g. `myzone.b-cdn.net` or a
   * custom domain. Bunny Edge Storage has no presigned URLs, so public
   * reads go through a linked Pull Zone. When set, `url()` returns the CDN
   * URL. Otherwise it returns the storage URL, which needs the `AccessKey`
   * header to fetch.
   */
  pullZone?: string;
}

/**
 * Connection settings exposed as `storage.raw`, for making your own Edge
 * Storage requests with the same host and credentials.
 */
export interface BunnyRaw {
  /** Storage endpoint origin, e.g. `https://storage.bunnycdn.com`. */
  readonly endpoint: string;
  /** Storage zone name. */
  readonly zone: string;
  /** Storage-zone password the adapter authenticates with. */
  readonly accessKey: string;
  /** Pull-zone host for public URLs, when configured. */
  readonly pullZone?: string;
}

/** One entry from a Bunny directory listing / DESCRIBE response. */
interface BunnyObject {
  ObjectName: string;
  Length: number;
  LastChanged: string;
  IsDirectory: boolean;
  ContentType: string;
  Checksum: string | null;
}

/** A file found while walking the zone, keyed relative to the zone root. */
interface ZoneFile {
  zoneKey: string;
  obj: BunnyObject;
}

/**
 * Adapter for Bunny Edge Storage.
 *
 * Implemented directly against the Edge Storage HTTP API (`fetch`, no SDK
 * dependency): `PUT`/`GET`/`DELETE` for objects, a `DESCRIBE` request for
 * `head`, and trailing-slash `GET` for directory listings. A storage zone
 * is one flat namespace, so each storagesdk bucket is a key prefix.
 * Snapshots live at `<bucket>-snapshot-<id>/` and forks at `<forkName>/`,
 * each with its own `.storagesdk.metadata.json` manifest.
 *
 * Limits: Bunny has no user metadata, so `upload`'s `metadata` is dropped.
 * There are no presigned upload URLs, so `uploadUrl` throws
 * `NotSupported`. There is no server-side copy, so `copy`, `move`, and
 * snapshot/fork seeding send every byte through the client. Directory
 * listings aren't paginated, so `list` walks every folder under the
 * prefix on each call.
 */
export function bunny(config: BunnyConfig): Adapter<BunnyRaw> {
  if (!config.accessKey) {
    throw new StorageError({
      code: 'InvalidArgument',
      message: 'bunny adapter: accessKey is required',
    });
  }
  assertLocation('bunny adapter: bucket', config.bucket);
  const regionHost = REGION_HOSTS[config.region ?? 'de'];
  if (config.endpoint === undefined && regionHost === undefined) {
    throw new StorageError({
      code: 'InvalidArgument',
      message: `bunny adapter: unknown region ${config.region} (expected one of ${Object.keys(REGION_HOSTS).join(', ')})`,
    });
  }
  const raw: BunnyRaw = {
    endpoint: (config.endpoint ?? `https://${regionHost}`).replace(/\/+$/, ''),
    zone: config.zone,
    accessKey: config.accessKey,
    ...(config.pullZone !== undefined ? { pullZone: config.pullZone } : {}),
  };
  return defineAdapter<BunnyRaw>(impl(raw, config.bucket));
}

/** A request body `fetch` accepts. */
type Body = NonNullable<RequestInit['body']>;

/** Encode a slash-delimited key per segment, preserving a trailing slash. */
function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** Storage URL for a zone-relative key or (trailing-slash) directory. */
const storageUrl = (raw: BunnyRaw, zoneKey: string): string =>
  `${raw.endpoint}/${raw.zone}/${encodePath(zoneKey)}`;

/** Media type of a response, without parameters. */
const contentTypeOf = (res: Response): string =>
  res.headers.get('content-type')?.split(';')[0]?.trim() ||
  'application/octet-stream';

/**
 * Send one Edge Storage request. Throws `BunnyHttpError` on a non-ok
 * status. With `allowNotFound`, a 404 is returned instead and the caller
 * checks `res.status`.
 */
async function send(
  raw: BunnyRaw,
  method: string,
  zoneKey: string,
  opts: {
    signal?: AbortSignal | undefined;
    headers?: Record<string, string>;
    body?: Body;
    allowNotFound?: boolean;
  } = {}
): Promise<Response> {
  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers: { AccessKey: raw.accessKey, ...opts.headers },
    ...(opts.body !== undefined ? { body: opts.body, duplex: 'half' } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
  const res = await fetch(storageUrl(raw, zoneKey), init);
  if (!res.ok && !(opts.allowNotFound && res.status === 404)) {
    await res.body?.cancel();
    throw new BunnyHttpError(
      res.status,
      `bunny: ${method} ${zoneKey} (${res.status})`
    );
  }
  return res;
}

/**
 * PUT a body to a zone-relative key. Bunny auto-creates parent folders and
 * accepts a streamed body, so a `ReadableStream` isn't read into memory.
 */
async function put(
  raw: BunnyRaw,
  zoneKey: string,
  body: Body,
  contentType: string,
  signal: AbortSignal | undefined
): Promise<void> {
  // Bunny stores the Content-Type header as sent unless
  // Override-Content-Type is set. Like the official SDK, send
  // octet-stream and put the real type in the override.
  await send(raw, 'PUT', zoneKey, {
    signal,
    body,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Override-Content-Type': contentType,
    },
  });
}

/** Copy one object by piping its GET response body into a PUT. */
async function copyObject(
  raw: BunnyRaw,
  fromKey: string,
  toKey: string,
  signal: AbortSignal | undefined
): Promise<void> {
  const res = await send(raw, 'GET', fromKey, { signal });
  try {
    await put(
      raw,
      toKey,
      res.body ?? new Uint8Array(),
      contentTypeOf(res),
      signal
    );
  } catch (err) {
    await res.body?.cancel().catch(() => {});
    throw err;
  }
}

/**
 * Walk every file under the zone directory `dir` (which ends in `/`),
 * one directory level per request. Yields each level's files together so
 * callers can work on them in batches.
 */
async function* walk(
  raw: BunnyRaw,
  dir: string,
  signal: AbortSignal | undefined
): AsyncGenerator<ZoneFile[]> {
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const res = await send(raw, 'GET', current, {
      signal,
      headers: { Accept: 'application/json' },
      allowNotFound: true,
    });
    if (res.status === 404) continue;
    const files: ZoneFile[] = [];
    for (const obj of (await res.json()) as BunnyObject[]) {
      if (obj.IsDirectory) {
        stack.push(`${current}${obj.ObjectName}/`);
      } else {
        files.push({ zoneKey: `${current}${obj.ObjectName}`, obj });
      }
    }
    yield files;
  }
}

/**
 * Copy every object under `from/` to `to/`, skipping the manifest since
 * the destination writes its own. Bunny has no server-side copy, so the
 * bytes pass through the client.
 */
async function copyAll(
  raw: BunnyRaw,
  from: string,
  to: string,
  signal: AbortSignal | undefined
): Promise<void> {
  const base = `${from}/`;
  for await (const files of walk(raw, base, signal)) {
    const relative = files
      .map(({ zoneKey }) => zoneKey.slice(base.length))
      .filter((key) => !isInternalKey(key));
    await inBatches(relative, (key) =>
      copyObject(raw, `${base}${key}`, `${to}/${key}`, signal)
    );
  }
}

/** Whether anything is stored directly under `prefix/`. */
async function inUse(
  raw: BunnyRaw,
  prefix: string,
  signal: AbortSignal | undefined
): Promise<boolean> {
  const res = await send(raw, 'GET', `${prefix}/`, {
    signal,
    headers: { Accept: 'application/json' },
    allowNotFound: true,
  });
  if (res.status === 404) return false;
  return ((await res.json()) as BunnyObject[]).length > 0;
}

/**
 * Remove a sibling prefix. Bunny's DELETE on a trailing-slash path removes
 * the directory and everything under it in one call. A missing directory
 * counts as removed.
 */
async function destroy(
  raw: BunnyRaw,
  prefix: string,
  signal: AbortSignal | undefined
): Promise<void> {
  await send(raw, 'DELETE', `${prefix}/`, { signal, allowNotFound: true });
}

const toMeta = (obj: BunnyObject, path: string): StorageItemMeta => ({
  path,
  size: obj.Length ?? 0,
  contentType: obj.ContentType || 'application/octet-stream',
  etag: obj.Checksum ?? '',
  lastModified: obj.LastChanged ? new Date(obj.LastChanged) : new Date(0),
});

/** Copy a byte slice into a fresh `ArrayBuffer`-backed `Uint8Array`. */
function sliceBytes(
  u8: Uint8Array,
  start: number,
  end: number
): Uint8Array<ArrayBuffer> {
  const len = Math.max(0, Math.min(end, u8.byteLength) - start);
  const out = new Uint8Array(new ArrayBuffer(len));
  out.set(u8.subarray(start, start + len));
  return out;
}

/** Run `fn`, mapping anything it throws to a `StorageError`. */
async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw asStorageError(err);
  }
}

function impl(raw: BunnyRaw, bucket: string): Adapter<BunnyRaw> {
  const base = `${bucket}/`;
  const zoneKeyOf = (key: string): string => `${base}${key}`;

  return {
    name: 'bunny',
    raw,

    upload: (key, body, opts) =>
      mapped(async () => {
        checkSignal(opts?.signal);
        // Bunny has no user metadata, so `opts.metadata` is dropped. The
        // compat matrix in the README says so.
        const contentType = opts?.contentType ?? 'application/octet-stream';
        let size: number;
        if (body instanceof ReadableStream) {
          // Stream the body through, counting bytes for the result.
          size = 0;
          const counted = body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                size += chunk.byteLength;
                controller.enqueue(chunk);
              },
            })
          );
          await put(raw, zoneKeyOf(key), counted, contentType, opts?.signal);
        } else {
          const bytes = await bodyToBytes(body);
          size = bytes.byteLength;
          await put(raw, zoneKeyOf(key), bytes, contentType, opts?.signal);
        }
        // Bunny's PUT response has no object metadata, so build it from
        // the inputs. `head` and `download` return the real etag and mtime.
        return {
          path: key,
          size,
          contentType,
          etag: '',
          lastModified: new Date(),
        };
      }),

    download: (key, opts) =>
      mapped(async (): Promise<StorageItem> => {
        checkSignal(opts?.signal);
        const range = opts?.range;
        const res = await send(raw, 'GET', zoneKeyOf(key), {
          signal: opts?.signal,
          ...(range !== undefined
            ? {
                headers: {
                  Range: `bytes=${range.offset}-${range.offset + range.length - 1}`,
                },
              }
            : {}),
        });
        let body = new Uint8Array(await res.arrayBuffer());
        if (range !== undefined && res.status !== 206) {
          // The server ignored Range and sent the whole object, so slice it here.
          body = sliceBytes(body, range.offset, range.offset + range.length);
        }
        const lastModified = res.headers.get('last-modified');
        return {
          path: key,
          size: body.byteLength,
          contentType: contentTypeOf(res),
          etag: res.headers.get('etag') ?? '',
          lastModified: lastModified ? new Date(lastModified) : new Date(0),
          body,
        };
      }),

    head: (key, opts) =>
      mapped(async () => {
        checkSignal(opts?.signal);
        // `DESCRIBE` on the object path returns its metadata directly.
        const res = await send(raw, 'DESCRIBE', zoneKeyOf(key), {
          signal: opts?.signal,
          headers: { Accept: 'application/json' },
        });
        const obj = (await res.json()) as BunnyObject;
        if (obj.IsDirectory) {
          throw new StorageError({
            code: 'NotFound',
            message: `bunny adapter: ${key} is a directory`,
          });
        }
        return toMeta(obj, key);
      }),

    list: (opts) =>
      mapped(async () => {
        checkSignal(opts?.signal);
        const prefix = opts?.prefix ?? '';
        const limit = opts?.limit ?? 1000;
        const cursor = opts?.cursor ?? '';
        // Start at the deepest folder the prefix names, so listing `a/b/`
        // doesn't walk the rest of the bucket.
        const start = zoneKeyOf(prefix.slice(0, prefix.lastIndexOf('/') + 1));
        const matching: Array<{ key: string; obj: BunnyObject }> = [];
        for await (const files of walk(raw, start, opts?.signal)) {
          for (const { zoneKey, obj } of files) {
            const key = zoneKey.slice(base.length);
            if (key.startsWith(prefix) && key > cursor && !isInternalKey(key)) {
              matching.push({ key, obj });
            }
          }
        }
        matching.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        const page = matching.slice(0, limit);
        const items = page.map(({ key, obj }) => toMeta(obj, key));
        const last = page[page.length - 1];
        return matching.length > limit && last !== undefined
          ? { items, cursor: last.key }
          : { items };
      }),

    delete: (key, opts) =>
      mapped(async () => {
        checkSignal(opts?.signal);
        // 404 is a no-op, matching S3 and fs.
        await send(raw, 'DELETE', zoneKeyOf(key), {
          signal: opts?.signal,
          allowNotFound: true,
        });
      }),

    copy: (from, to, opts) =>
      mapped(async () => {
        checkSignal(opts?.signal);
        await copyObject(raw, zoneKeyOf(from), zoneKeyOf(to), opts?.signal);
      }),

    move: (from, to, opts) =>
      mapped(async () => {
        checkSignal(opts?.signal);
        // Copy, then delete. Not atomic: a failure after the copy can
        // leave both keys. The `move` contract allows this.
        await copyObject(raw, zoneKeyOf(from), zoneKeyOf(to), opts?.signal);
        await send(raw, 'DELETE', zoneKeyOf(from), {
          signal: opts?.signal,
          allowNotFound: true,
        });
      }),

    async url(key, opts): Promise<string> {
      checkSignal(opts?.signal);
      // Public reads go through a linked Pull Zone. Without one, return
      // the storage URL, which needs the `AccessKey` header to fetch.
      return raw.pullZone
        ? `https://${raw.pullZone}/${encodePath(zoneKeyOf(key))}`
        : storageUrl(raw, zoneKeyOf(key));
    },

    async uploadUrl(): Promise<never> {
      throw new StorageError({
        code: 'NotSupported',
        message:
          'bunny adapter: uploadUrl is not supported (Bunny Edge Storage has no presigned upload URL).',
      });
    },

    ...siblings<BunnyRaw>(
      {
        at: (name) => impl(raw, name),
        inUse: (prefix, signal) => inUse(raw, prefix, signal),
        copyAll: (from, to, signal) => copyAll(raw, from, to, signal),
        destroy: (prefix, signal) => destroy(raw, prefix, signal),
        asStorageError,
      },
      bucket
    ),
  };
}
