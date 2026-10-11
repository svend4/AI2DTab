import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/**
 * Начало файла комплекта для L4. Читать можно только файлы из списка `src/data/archive.json` и только текстовые
 * (`kit-files.ts`); база стола и бинарные файлы в списке есть, но не отдаются. Вызов открыт всем, как и чтение стола в режиме A:
 * он показывает то, что и так лежит в репозитории. Отказ приходит как `{ ok: false, reason, message }`, а не исключением.
 */
export const readKitFile = createServerFn({ method: "POST" })
  .validator(z.object({ path: z.string().min(1).max(240) }))
  .handler(async ({ data }) => {
    const { default: archive } = await import("@/data/archive.json");
    const { KIT_MESSAGES, planKitRead } = await import("@/lib/kit-files");
    const { readKitPreview } = await import("@/lib/kit-read.server");
    const plan = planKitRead(data.path, new Set(archive.map((f) => f.path)));
    if (!plan.ok)
      return { ok: false as const, reason: plan.reason, message: KIT_MESSAGES[plan.reason] };
    const read = await readKitPreview(plan.rel);
    if (!read.ok)
      return { ok: false as const, reason: read.reason, message: KIT_MESSAGES[read.reason] };
    return read;
  });
