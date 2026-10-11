import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";

/**
 * Серверные вызовы стола. Режим A (docs/AUDIT.md, раздел 4.3):
 *  - `pmRead` открыт всем и пропускает только глаголы чтения;
 *  - `pmWrite` требует входа (`authMiddleware`: проверенный `context.userId`, отказ чужим сайтам) и пропускает всё из таблицы глаголов.
 * Что именно разрешено, решает `buildPmArgs` в `pm-request.ts`, а не имя вызова: строка, не подходящая под вызов, получает отказ
 * (`login_required` и т. п.), и клиентская подсказка «какой вызов выбрать» ничего не открывает.
 * Параметра «файл» нет; лента PLANT приходит текстом, путь к её временному файлу выбирает сервер.
 */
const Input = z.object({
  line: z.string().min(1).max(4000),
  tape: z.string().max(200_000).optional(),
});

export const pmRead = createServerFn({ method: "POST" })
  .validator(Input)
  .handler(async ({ data }) => {
    const { execute } = await import("@/lib/pm-exec.server");
    return execute(data, null);
  });

export const pmWrite = createServerFn({ method: "POST" })
  .validator(Input)
  .middleware([authMiddleware])
  .handler(async ({ data, context }) => {
    const { execute } = await import("@/lib/pm-exec.server");
    return execute(data, { id: context.userId });
  });
