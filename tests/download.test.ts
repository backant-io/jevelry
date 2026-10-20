import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type RemoteFile, checkSpace, downloadFile, modelPath, remoteFile } from "../src/download.js";
import { FILE_BYTES, type FakeHf, fileBytes, sha256, startHf } from "./fixtures/hf.js";

const REPO = "ggml-org/vllm-d3-flash-GGUF";
const FILE = "vllm-d3-flash-Q8_0.gguf";

let hf: FakeHf;
beforeAll(async () => { hf = await startHf(); });
afterAll(async () => hf.close());
beforeEach(() => {
  for (const key of Object.keys(hf.behaviour)) delete hf.behaviour[key as keyof FakeHf["behaviour"]];
  hf.requests.length = 0;
});

const home = () => mkdtempSync(join(tmpdir(), "jevelry-download-"));
const remote = (): RemoteFile => ({ repo: REPO, file: FILE, bytes: FILE_BYTES, sha256: sha256(fileBytes(FILE)) });
const downloads = () => hf.requests.filter((r) => r.url.includes("/resolve/"));

describe("remoteFile", () => {
  // The sha256 from the tree is what the download is checked against, and the exact size replaces the estimate.
  it("reads the exact size and the sha256 from the tree", async () => {
    expect(await remoteFile(REPO, FILE, { hfUrl: hf.url })).toEqual(remote());
  });

  // A file that cannot be verified could be anything, and jevelry would run it: it refuses instead.
  it("throws for a file that is not there or has no sha256", async () => {
    await expect(remoteFile(REPO, "nope.gguf", { hfUrl: hf.url })).rejects.toThrow("nope.gguf is not in ggml-org/vllm-d3-flash-GGUF on Hugging Face");
    await expect(remoteFile(REPO, "README.md", { hfUrl: hf.url })).rejects.toThrow(/has no sha256 on Hugging Face, so it cannot be verified/);
  });
});

describe("downloadFile", () => {
  // One directory per repo keeps two repos with the same file name apart.
  it("puts a model under models/<author>/<repo>", () => {
    expect(modelPath("/h", REPO, FILE)).toBe(join("/h", "models", "ggml-org", "vllm-d3-flash-GGUF", FILE));
  });

  // The repo and file names come from Hugging Face; one with "../" in it would write outside the models folder.
  it("refuses a repo or file name that could leave the models folder", () => {
    for (const [repo, file, named] of [[REPO, "../x.gguf", "../x.gguf"], [REPO, "..", ".."], ["ggml-org/..", FILE, "ggml-org/.."], ["a/b/c", FILE, "a/b/c"], [REPO, "/etc/x", "/etc/x"]]) {
      expect(() => modelPath("/h", repo!, file!)).toThrow(`refusing an unsafe model path from Hugging Face: ${named}`);
    }
  });

  // The file only takes its real name once verified, so a half-written file is never mistaken for a model.
  it("downloads, verifies and renames the part, reporting progress to the end", async () => {
    const dest = modelPath(home(), REPO, FILE);
    const seen: Array<[number, number]> = [];
    await downloadFile(remote(), dest, { hfUrl: hf.url, onProgress: (done, total) => seen.push([done, total]) });
    expect(readFileSync(dest)).toEqual(fileBytes(FILE));
    expect(existsSync(`${dest}.part`)).toBe(false);
    expect(seen.at(-1)).toEqual([FILE_BYTES, FILE_BYTES]);
  });

  // An interrupted 20 GB download must cost only what was left, never the whole file again.
  it("resumes from a .part with a Range request", async () => {
    const dest = modelPath(home(), REPO, FILE);
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(`${dest}.part`, fileBytes(FILE).subarray(0, 2500));
    await downloadFile(remote(), dest, { hfUrl: hf.url });
    expect(downloads().map((r) => r.range)).toEqual(["bytes=2500-"]);
    expect(readFileSync(dest)).toEqual(fileBytes(FILE));
  });

  // A server that ignores the range sends the whole file; appending it to the part would corrupt it.
  it("starts over when the server answers a Range request with the whole file", async () => {
    const dest = modelPath(home(), REPO, FILE);
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(`${dest}.part`, fileBytes(FILE).subarray(0, 2500));
    hf.behaviour.ignoreRange = true;
    await downloadFile(remote(), dest, { hfUrl: hf.url });
    expect(readFileSync(dest)).toEqual(fileBytes(FILE));
  });

  // A cut connection is the common failure: the bytes that arrived stay for the next run.
  it("keeps the part when the connection drops, says to run the install again, and the next run resumes it", async () => {
    const dest = modelPath(home(), REPO, FILE);
    hf.behaviour.cutAt = 3000;
    const error = await downloadFile(remote(), dest, { hfUrl: hf.url }).catch((e: unknown) => e);
    expect((error as Error).message).toBe(`the download of ${FILE} stopped at 0.0 GB of 0.0 GB; run the install again to resume it`);
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(existsSync(`${dest}.part`)).toBe(true);
    delete hf.behaviour.cutAt;
    await downloadFile(remote(), dest, { hfUrl: hf.url });
    expect(downloads().at(-1)?.range).toMatch(/^bytes=\d+-$/);
    expect(readFileSync(dest)).toEqual(fileBytes(FILE));
  });

  // A body longer than the tree says is not the file that was checked: it must not fill the disk, and no part of it is worth resuming.
  it("cuts a body larger than Hugging Face says and deletes the part", async () => {
    const dest = modelPath(home(), REPO, FILE);
    await expect(downloadFile({ ...remote(), bytes: 3000 }, dest, { hfUrl: hf.url })).rejects.toThrow(`${FILE} is larger than Hugging Face says`);
    expect(existsSync(`${dest}.part`)).toBe(false);
    expect(existsSync(dest)).toBe(false);
  });

  // A file that does not match its published hash is not the model, and resuming it could never match.
  it("refuses a sha256 mismatch and deletes the part", async () => {
    const dest = modelPath(home(), REPO, FILE);
    const wrong = { ...remote(), sha256: sha256(Buffer.from("something else")) };
    await expect(downloadFile(wrong, dest, { hfUrl: hf.url })).rejects.toThrow(`downloaded ${FILE} does not match its sha256 on Hugging Face`);
    expect(existsSync(`${dest}.part`)).toBe(false);
    expect(existsSync(dest)).toBe(false);
  });

  // Running install again must not download gigabytes that are already there and verified.
  it("downloads nothing when the verified file is already there", async () => {
    const dest = modelPath(home(), REPO, FILE);
    await downloadFile(remote(), dest, { hfUrl: hf.url });
    hf.requests.length = 0;
    await downloadFile(remote(), dest, { hfUrl: hf.url });
    expect(downloads()).toHaveLength(0);
  });
});

describe("checkSpace", () => {
  // A disk filled to the last byte breaks more than this install, so 1 GiB stays free and the message says how much is missing.
  it("refuses unless the rest of the file and 1 GiB fit, naming both sizes and the directory", () => {
    expect(() => checkSpace(10e9, 5e9, "/models")).toThrow("not enough disk space: need 11.1 GB, 5.0 GB free in /models");
    expect(() => checkSpace(10e9, 10e9 + 2 ** 30, "/models")).not.toThrow();
  });
});
