import { createHash, type Hash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync, statfsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { hfJson } from "./catalog.js";
import { GIB } from "./estimate.js";

/** A file on Hugging Face as its tree lists it: the exact size and the sha256 the download is checked against. */
export interface RemoteFile {
  repo: string;
  file: string;
  bytes: number;
  sha256: string;
}

/** Throws when the file is not there or has no sha256: jevelry refuses to install what it cannot verify. */
export async function remoteFile(repo: string, file: string, options: { hfUrl: string; fetch?: typeof fetch }): Promise<RemoteFile> {
  const tree = await hfJson(`${options.hfUrl}/api/models/${repo}/tree/main`, options.fetch);
  const entry = (Array.isArray(tree) ? tree : []).find((e: { path?: unknown }) => e?.path === file) as
    | { size?: unknown; lfs?: { oid?: unknown; size?: unknown } }
    | undefined;
  if (!entry) throw new Error(`${file} is not in ${repo} on Hugging Face`);
  const sha256 = entry.lfs?.oid;
  const bytes = entry.lfs?.size ?? entry.size;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256) || typeof bytes !== "number") {
    throw new Error(`${file} in ${repo} has no sha256 on Hugging Face, so it cannot be verified`);
  }
  return { repo, file, bytes, sha256 };
}

/** One directory per repo under `$JEVELRY_HOME/models`, so two repos with the same file name never collide. */
export function modelPath(home: string, repo: string, file: string): string {
  return join(home, "models", ...repo.split("/"), file);
}

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;

/** 1 GiB stays free after the download: a disk filled to the last byte breaks more than this install. */
export function checkSpace(remaining: number, free: number, dir: string): void {
  if (free < remaining + GIB) throw new Error(`not enough disk space: need ${gb(remaining + GIB)}, ${gb(free)} free in ${dir}`);
}

async function hashFile(path: string, hash: Hash): Promise<void> {
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
}

/**
 * Downloads into `dest + ".part"` and resumes from it with a Range request, so an interrupted 20 GB
 * download costs only what was left. The sha256 is computed while streaming and checked before the
 * file takes its real name; a mismatch deletes the part, since resuming it could never match.
 */
export async function downloadFile(remote: RemoteFile, dest: string, options: {
  hfUrl: string;
  fetch?: typeof fetch;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const total = remote.bytes;
  const progress = options.onProgress ?? (() => {});
  if (existsSync(dest) && statSync(dest).size === total) {
    const hash = createHash("sha256");
    await hashFile(dest, hash);
    if (hash.digest("hex") === remote.sha256) {
      progress(total, total);
      return;
    }
  }
  const dir = dirname(dest);
  mkdirSync(dir, { recursive: true });
  const part = `${dest}.part`;
  let done = existsSync(part) ? statSync(part).size : 0;
  // A part longer than the file is no prefix of it: start over.
  if (done > total) {
    unlinkSync(part);
    done = 0;
  }
  const space = statfsSync(dir);
  checkSpace(total - done, space.bavail * space.bsize, dir);
  // The part is hashed before the request, so the connection never sits idle while gigabytes are read.
  let hash = createHash("sha256");
  if (done > 0) await hashFile(part, hash);
  if (done < total) {
    const response = await (options.fetch ?? fetch)(`${options.hfUrl}/${remote.repo}/resolve/main/${remote.file}`, {
      ...(done > 0 ? { headers: { Range: `bytes=${done}-` } } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok || !response.body) throw new Error(`Hugging Face answered ${response.status} for ${remote.file}`);
    // A 200 to a Range request is the whole file: the server ignored the range, so the part starts over.
    if (done > 0 && response.status !== 206) {
      hash = createHash("sha256");
      done = 0;
    }
    const flags = done > 0 ? "a" : "w";
    let last = 0;
    await pipeline(
      Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          hash.update(chunk);
          done += chunk.length;
          const now = Date.now();
          if (now - last >= 250) {
            last = now;
            progress(done, total);
          }
          yield chunk;
        }
      },
      createWriteStream(part, { flags }),
    );
  }
  finish(remote, dest, part, done, hash, progress);
}

/** A short part is a cut connection and stays for the next resume; a wrong hash is a bad file and goes. */
function finish(remote: RemoteFile, dest: string, part: string, done: number, hash: Hash, progress: (done: number, total: number) => void): void {
  if (done < remote.bytes) throw new Error(`the download of ${remote.file} stopped at ${gb(done)} of ${gb(remote.bytes)}; run the install again to resume it`);
  if (done > remote.bytes || hash.digest("hex") !== remote.sha256) {
    unlinkSync(part);
    throw new Error(`downloaded ${remote.file} does not match its sha256 on Hugging Face`);
  }
  renameSync(part, dest);
  progress(done, remote.bytes);
}
