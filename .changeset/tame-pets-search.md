---
"@storagesdk/adapters": minor
---

New `@storagesdk/adapters/bunny` and `@storagesdk/adapters/bunny-s3` adapters for [Bunny Storage](https://docs.bunny.net/storage). `bunny` talks to the Edge Storage HTTP API and works on any storage zone; `bunny-s3` talks to the S3-compatible API and needs a zone created with S3 compatibility turned on.

```ts
import { Storage } from "@storagesdk/core";
import { bunny } from "@storagesdk/adapters/bunny";

const storage = new Storage({
  adapter: bunny({
    zone: "my-storage-zone",
    bucket: "demo",
    accessKey: process.env.BUNNY_STORAGE_ACCESS_KEY,
    region: "de",
    pullZone: "my-zone.b-cdn.net", // for public url()
  }),
});

const snap = await storage.snapshots.create({ name: "baseline" });
await storage.forks.create({ name: "experiment", fromSnapshot: snap.id });
```

Notes on `bunny`:

- No dependencies. It calls the Edge Storage HTTP API with `fetch`. `accessKey` is the storage zone password, not the account API key.
- A storage zone is one flat namespace, so each storagesdk `bucket` maps to a key prefix. Snapshots live at `<bucket>-snapshot-<id>/` and forks at `<forkName>/`, each with a `.storagesdk.metadata.json` manifest. The Vercel Blob adapter uses the same layout.
- `head` uses Bunny's `DESCRIBE` request for per-object metadata; `list` walks directory levels.
- Bunny has no server-side copy, so `copy`, `move`, and snapshot/fork seeding send every byte through the client. Copies and `ReadableStream` uploads are streamed rather than read into memory.
- Bunny has no user metadata, so `opts.metadata` on `upload` is dropped.
- `uploadUrl()` throws `NotSupported` because there are no presigned uploads. `url()` returns the Pull Zone URL when `pullZone` is set, and otherwise the storage URL, which needs the `AccessKey` header to fetch.
- `storage.raw` exposes the resolved `{ endpoint, zone, accessKey, pullZone }` for direct Edge Storage requests.
- `forks.merge`, `forks.rebase`, and `forks.diff` use the SDK defaults on both adapters.

```ts
import { bunnyS3 } from "@storagesdk/adapters/bunny-s3";

const storage = new Storage({
  adapter: bunnyS3({
    zone: "my-s3-storage-zone",
    bucket: "demo",
    accessKey: process.env.BUNNY_S3_ACCESS_KEY,
    region: "de",
  }),
});
```

Notes on `bunny-s3`:

- Object operations delegate to the S3 adapter, so user metadata, presigned `url()` and `uploadUrl()`, multipart uploads, and server-side copy work. `storage.raw` is the `S3Client`. Needs the same `@aws-sdk/*` peer dependencies as the S3 adapter.
- The zone name is the S3 bucket and access key id; `accessKey` (the storage-zone password) is the secret access key.
- Same zone layout as `bunny`: each `bucket` is a key prefix, with snapshots at `<bucket>-snapshot-<id>/` and forks at `<forkName>/`. A zone's credentials can't create another zone, so the S3 adapter's sibling-bucket layout doesn't apply. Snapshot and fork seeding uses server-side `CopyObject`.
- On both adapters, `bucket` and fork names must be a single path segment. `forks.create` throws `Conflict` when the fork's prefix already holds objects, and `forks.delete` and `snapshots.delete` only remove prefixes the bucket created. A snapshot or fork that fails partway is cleaned up, and a delete that can't remove the data throws without touching the manifest.
- Both adapters are in the runtime registry as `bunny` (`BUNNY_STORAGE_*`, `BUNNY_PULL_ZONE`) and `bunny-s3` (`BUNNY_S3_*`).
