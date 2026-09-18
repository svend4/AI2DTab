import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export const readKitFile = createServerFn({ method: "POST" })
  .validator(z.object({ path: z.string().min(1).max(240) }))
  .handler(async ({ data }) => {
    const { readFile, existsSync } = await import("node:fs");
    const path = await import("node:path");
    const kit = path.resolve("/workspace/artifacts/ai-pm-kit");
    const engine = path.resolve("/workspace/engine");
    const name = path.basename(data.path).replace(/\\/g, "");
    const tries = [path.join(engine, name), path.resolve(kit, data.path)];
    for (const abs of tries) {
      const okRoot = abs.startsWith(engine + path.sep) || abs === path.join(engine, name) || abs.startsWith(kit + path.sep);
      try {
        if (!okRoot || !existsSync(abs)) continue;
        const buf = readFile(abs);
        return {
          path: name,
          bytes: buf.length,
          preview: buf.subarray(0, 12_000).toString("utf8"),
        };
      } catch {
        continue;
      }
    }
    throw new Error("path");
  });
