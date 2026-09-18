import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const PM = "/workspace/engine/pm.py";
const DB = "/workspace/engine/project-store.sqlite";
const VERB = /^(STATUS|LOOK|PLANT|CUT|ACCEPT|TAKE|RUN|FETCH|DUMP|GRID|DIFF|JSON|BATCH|CANON|RAW|NEQ|SET|PACKET|MATRIX|MUL|TIMES|FILL|SWEEP|REPAIR|CELL|CONC|CONCORD|INSTR|GAUGE|PANEL|GAP|PROBE|WIRE|PURGE|SETTLE|VOCAB|PORT|SPEC|CAT)\b/i;

export const pmExec = createServerFn({ method: "POST" })
  .validator(
    z.object({
      line: z.string().min(1).max(4000),
      tape: z.string().max(200_000).optional(),
      file: z.string().max(240).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const { spawn } = await import("node:child_process");
    const { existsSync, writeFileSync } = await import("node:fs");

    function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
      return new Promise((resolve) => {
        const child = spawn("python3", [PM, ...args], { cwd: "/workspace/engine" });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (b: Buffer) => {
          stdout += String(b);
        });
        child.stderr.on("data", (b: Buffer) => {
          stderr += String(b);
        });
        child.stdin.end();
        const t = setTimeout(() => child.kill("SIGKILL"), 12000);
        child.on("close", (code) => {
          clearTimeout(t);
          resolve({ code: code ?? 1, stdout: stdout.slice(0, 80_000), stderr: stderr.slice(0, 4000) });
        });
      });
    }

    const line = data.line.trim();
    if (!VERB.test(line)) return { ok: false, stdout: "", stderr: `unknown ${line}` };
    if (!existsSync(DB)) await run(["init"]);
    const args = ["exec"];
    if (data.file) {
      if (!data.file.startsWith("/workspace/engine/")) {
        return { ok: false, stdout: "", stderr: "file" };
      }
      args.push("PLANT", "--file", data.file);
    } else if (data.tape && /^(PLANT|CUT)\b/i.test(line)) {
      writeFileSync("/tmp/desk-tape.txt", data.tape, "utf8");
      args.push("PLANT", "--file", "/tmp/desk-tape.txt");
    } else {
      args.push(...line.split(/\s+/));
    }
    const res = await run(args);
    return { ok: res.code === 0, stdout: res.stdout, stderr: res.stderr };
  });
