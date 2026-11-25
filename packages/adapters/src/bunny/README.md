# @storagesdk/adapters/bunny

Adapter for [Bunny Storage](https://docs.bunny.net/storage) over the Edge Storage HTTP API. It works on any storage zone.

If your zone was created with S3 compatibility turned on, [`@storagesdk/adapters/bunny-s3`](../bunny-s3/README.md) adds user metadata, presigned URLs, multipart uploads, and server-side copy. Both adapters lay the zone out the same way, so they can work on the same zone.

```sh
npm install @storagesdk/core @storagesdk/adapters
```

No extra dependency. The adapter calls the Edge Storage HTTP API with `fetch`.

```ts
import { Storage } from '@storagesdk/core';
import { bunny } from '@storagesdk/adapters/bunny';

const storage = new Storage({
  adapter: bunny({
    zone: 'my-storage-zone',
    bucket: 'photos',
    region: 'de',
    accessKey: process.env.BUNNY_STORAGE_ACCESS_KEY,
    pullZone: 'my-zone.b-cdn.net', // for public url()
  }),
});

await storage.upload('beach.jpg', blob, { contentType: 'image/jpeg' });
const text = await storage.download('config.json', { as: 'text' });
const url = await storage.url('beach.jpg');
```

## How `zone` and `bucket` map

A Bunny **storage zone** is one flat key namespace, addressed by the storage-zone password. The adapter maps each storagesdk `bucket` to a **key prefix** within the zone (`<bucket>/<key>`), so multiple logical buckets can coexist in one zone and snapshots/forks can live as sibling prefixes alongside them.

If you only need one logical bucket per zone, pick any short name like `app`.

## Config

```ts
interface BunnyConfig {
  zone: string;
  bucket: string;
  accessKey: string;
  region?: 'de' | 'uk' | 'ny' | 'la' | 'sg' | 'se' | 'br' | 'jh' | 'syd';
  endpoint?: string;
  pullZone?: string;
}
```

- `zone`: storage zone name. It's the first path segment of every request.
- `bucket`: logical bucket, becomes the key prefix.
- `accessKey`: the storage zone password (the read-write key from the Bunny dashboard), not the account API key.
- `region`: primary storage region. Defaults to `de` (Falkenstein), which is served from `storage.bunnycdn.com`. Other regions prefix the host with their code, for example `ny.storage.bunnycdn.com`.
- `endpoint`: replaces the storage origin, for example with a local mock. Takes precedence over `region`.
- `pullZone`: pull zone hostname for public file URLs (see [URLs](#urls)).

## Snapshots and forks

Each snapshot or fork is a new key prefix in the same zone, filled by copying every object. The Vercel Blob adapter uses the same layout. A `.storagesdk.metadata.json` manifest sits at the root of each prefix.

```ts
const snap = await storage.snapshots.create({ name: 'pre-migration' });
const reader = storage.snapshots.get(snap.id); // ReadOnlyStorage

await storage.forks.create({ name: 'experiment', fromSnapshot: snap.id });
const fork = storage.forks.get('experiment'); // Storage
await fork.upload('new.jpg', blob);
```

`forks.create` without `fromSnapshot` forks from the parent's live state.

A fork's name is its key prefix, and it shares the zone with every other logical bucket. Bucket and fork names must be a single path segment (no `/`, not `.` or `..`); anything else throws `InvalidArgument`. `forks.create` throws `Conflict` when that prefix already holds objects, and `forks.delete` / `snapshots.delete` only remove prefixes this bucket created.

Bunny has no server-side copy, so creating a snapshot or fork sends every object's bytes through the client, and the time it takes grows with total size. The same goes for `copy` and `move`. Each object is piped from the GET into the PUT without being read into memory, and up to 16 objects are copied at once.

If a snapshot or fork fails partway (including when it's aborted), the partial copy is removed. If `snapshots.delete` / `forks.delete` can't remove the data, they throw and leave the manifest entry in place so you can retry.

## What this adapter doesn't preserve

- **Custom metadata.** Bunny Edge Storage has no user-metadata field. `upload({ metadata })` silently drops the metadata. Use a sidecar object if you need per-object metadata.
- **Presigned uploads.** Bunny has no presigned upload URL. `uploadUrl()` throws `StorageError` with code `NotSupported`.
- **Server-side paging.** Bunny's directory listing returns a whole folder at a time with no pagination, so every `list()` call walks every folder under the prefix and then slices out one page. Paging through a large bucket costs one walk per page. Pass the narrowest `prefix` you can; a prefix ending in `/` starts the walk at that folder.

## URLs

Bunny Edge Storage has no presigned-URL concept; public reads are served by a **Pull Zone** linked to the storage zone.

- With `pullZone` set, `url()` returns the public CDN URL (`https://<pullZone>/<bucket>/<key>`), fetchable with no auth.
- Without it, `url()` falls back to the storage URL, which needs the `AccessKey` header to fetch. That works for server-side access but not in a browser.

`url()` does not sign or expire the link; `expiresIn` is ignored.

## Escape hatch

`storage.raw` exposes the adapter's resolved connection settings, so you can issue your own Edge Storage requests:

```ts
const { endpoint, zone, accessKey } = storage.raw;

await fetch(`${endpoint}/${zone}/photos/beach.jpg`, {
  method: 'DELETE',
  headers: { AccessKey: accessKey },
});
```

There's no client object to expose, since the adapter uses `fetch` directly.

```ts
interface BunnyRaw {
  endpoint: string;
  zone: string;
  accessKey: string;
  pullZone?: string;
}
```

## Environment variables

The runtime adapter registry accepts these variables:

```sh
BUNNY_STORAGE_ZONE=my-storage-zone
BUNNY_STORAGE_BUCKET=photos
BUNNY_STORAGE_ACCESS_KEY=<storage-zone-password>
BUNNY_STORAGE_REGION=de
BUNNY_STORAGE_ENDPOINT=https://storage.bunnycdn.com
BUNNY_PULL_ZONE=my-zone.b-cdn.net
```

The first three are required.
