import { createHash } from "node:crypto";
import { createServer } from "node:http";

/** Every fake model file is this small: the tests download bytes, never weights. */
export const FILE_BYTES = 6000;

/** The deterministic bytes the fake serves for a file name. */
export function fileBytes(file: string): Buffer {
  const out = Buffer.alloc(FILE_BYTES);
  for (let i = 0; i < FILE_BYTES; i++) out[i] = (file.charCodeAt(i % file.length) + i) % 256;
  return out;
}

export const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const f = (rfilename: string) => ({ rfilename });

/** The listing rows per author, in the real API's shape, with every kind of repo jevelry must leave out. */
export const ROWS: Record<string, Array<{ id: string; gguf: Record<string, unknown>; siblings: Array<{ rfilename: string }>; cardData: Record<string, unknown> }>> = {
  "ggml-org": [
    {
      id: "ggml-org/vllm-d3-flash-GGUF",
      gguf: { total: 8_950_000_000, architecture: "qwen35", decision_type: "vllm-d3" },
      siblings: [f(".gitattributes"), f("README.md"), f("vllm-d3-flash-Q4_K_M.gguf"), f("vllm-d3-flash-Q8_0.gguf"), f("vllm-d3-flash-F16.gguf"), f("mmproj-vllm-d3-flash-Q8_0.gguf")],
      cardData: { license: "apache-2.0" },
    },
    { id: "ggml-org/vllm-d3-GGUF", gguf: { total: 26_900_000_000, architecture: "qwen35", decision_type: "vllm-d3" }, siblings: [f("vllm-d3-Q8_0.gguf"), f("vllm-d3-Q4_K_M.gguf")], cardData: { license: "apache-2.0" } },
    { id: "ggml-org/Kev-4B-GGUF", gguf: { total: 4_020_000_000, architecture: "qwen3", decision_type: "kev" }, siblings: [f("Kev-4B-Q8_0.gguf"), f("Kev-4B-Q4_K_M.gguf")], cardData: { license: "apache-2.0" } },
    { id: "ggml-org/Clef-GGUF", gguf: { total: 26_900_000_000, architecture: "clef", decision_type: "clef" }, siblings: [f("Clef-Q4_K_M.gguf")], cardData: { license: "apache-2.0" } },
    { id: "ggml-org/OpenJev-GGUF", gguf: { total: 26_900_000_000, architecture: "gemma3", decision_type: "openjev" }, siblings: [f("OpenJev-Q8_0.gguf"), f("OpenJev-Q4_K_M.gguf")], cardData: { license: "cc-by-nc-4.0" } },
    // A clef decision header on a qwen35 architecture: a broken conversion.
    { id: "ggml-org/Clef-Flash-GGUF", gguf: { total: 8_950_000_000, architecture: "qwen35", decision_type: "clef" }, siblings: [f("Clef-Flash-Q8_0.gguf")], cardData: { license: "apache-2.0" } },
    { id: "ggml-org/vllm-d3-flash-for-testing-GGUF", gguf: { total: 8_950_000_000, architecture: "qwen35", decision_type: "vllm-d3" }, siblings: [f("vllm-d3-flash-for-testing-Q8_0.gguf")], cardData: { license: "apache-2.0" } },
    { id: "ggml-org/Mystery-GGUF", gguf: { total: 4_000_000_000, architecture: "mystery", decision_type: "mystery-decider" }, siblings: [f("Mystery-Q8_0.gguf")], cardData: { license: "apache-2.0" } },
    // Only a 16-bit file: nothing jevelry offers.
    { id: "ggml-org/vllm-d3-nano-GGUF", gguf: { total: 2_000_000_000, architecture: "qwen35", decision_type: "vllm-d3" }, siblings: [f("vllm-d3-nano-F16.gguf")], cardData: { license: "apache-2.0" } },
  ],
  LiquidAI: [
    { id: "LiquidAI/d1-3B-GGUF", gguf: { total: 2_700_000_000, architecture: "lfm2", decision_type: "lfm2-d1" }, siblings: [f("d1-3B-Q8_0.gguf"), f("d1-3B-Q4_K_M.gguf")], cardData: { license: "other", license_name: "lfm1.0" } },
    // A chat model: no decision type at all.
    { id: "LiquidAI/LFM2-1.2B-GGUF", gguf: { total: 1_200_000_000, architecture: "lfm2" }, siblings: [f("LFM2-1.2B-Q8_0.gguf")], cardData: { license: "other", license_name: "lfm1.0" } },
  ],
};

export interface FakeHf {
  url: string;
  requests: Array<{ url: string; range: string | undefined }>;
  /** Set by a test to make the following answers misbehave the way a real network can. */
  behaviour: { ignoreRange?: boolean; wrongSha?: boolean; cutAt?: number; size?: number };
  close: () => Promise<void>;
}

/** A fake Hugging Face: the model listing, the tree API and resolve with Range, all from ROWS. */
export async function startHf(): Promise<FakeHf> {
  const requests: FakeHf["requests"] = [];
  const behaviour: FakeHf["behaviour"] = {};
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://hf.test");
    requests.push({ url: req.url ?? "", range: req.headers.range });
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/models") return json(200, ROWS[url.searchParams.get("author") ?? ""] ?? []);
    const tree = /^\/api\/models\/([^/]+\/[^/]+)\/tree\/main$/.exec(url.pathname);
    if (tree) {
      const row = Object.values(ROWS).flat().find((r) => r.id === tree[1]);
      if (!row) return json(404, { error: "Repository not found" });
      return json(200, row.siblings.map(({ rfilename: path }) => {
        const bytes = fileBytes(path);
        if (!path.endsWith(".gguf")) return { type: "file", oid: "0".repeat(40), size: bytes.length, path };
        const oid = behaviour.wrongSha ? sha256(Buffer.from("something else")) : sha256(bytes);
        return { type: "file", oid: "1".repeat(40), size: behaviour.size ?? bytes.length, path, lfs: { oid, size: behaviour.size ?? bytes.length, pointerSize: 135 } };
      }));
    }
    const resolve = /^\/([^/]+\/[^/]+)\/resolve\/main\/(.+)$/.exec(url.pathname);
    if (!resolve) return json(404, { error: "not found" });
    const bytes = fileBytes(resolve[2] ?? "");
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    const start = range && !behaviour.ignoreRange ? Number(range[1]) : 0;
    res.writeHead(start > 0 ? 206 : 200, {
      "content-type": "application/octet-stream",
      "content-length": String(bytes.length - start),
      ...(start > 0 ? { "content-range": `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {}),
    });
    if (behaviour.cutAt === undefined) return res.end(bytes.subarray(start));
    // A connection that drops partway: what was sent arrives, the rest never does.
    res.write(bytes.subarray(start, behaviour.cutAt));
    setTimeout(() => res.destroy(), 100);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    behaviour,
    close: () => new Promise((done) => {
      server.closeAllConnections();
      server.close(() => done());
    }),
  };
}
